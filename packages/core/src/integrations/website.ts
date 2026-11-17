import { prisma, type Integration } from "@lfm/db";
import { websiteFormSettingsSchema, type WebsiteFormSettings } from "@lfm/shared";
import { audit } from "../audit/audit";
import { decrypt, encrypt } from "../crypto/encryption";
import { hmacSha256Hex, randomToken, safeEqual, sha256Hex } from "../crypto/tokens";
import { AppError, Errors } from "../errors";
import { hashPayload, ingestLead, isChecked, mapFormFields, type IngestResult } from "../intake/ingest";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { integrationView } from "./service";

/**
 * Website lead capture.
 *
 *  - Server-to-server (any backend, Zapier, WordPress plugin…):
 *      POST /api/webhooks/website/<key>
 *      X-LFM-Timestamp: <unix seconds>
 *      X-LFM-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *    Requests older than 5 minutes are rejected (replay protection).
 *  - Browser form (hosted page or the HTML snippet): POST /api/webhooks/website/<key>/form.
 *    Can't hold a secret, so it is protected by an origin allow-list, a honeypot field, a minimum
 *    fill time and per-IP rate limits, and the lead is marked as unverified.
 */

export const SIGNATURE_TOLERANCE_S = 5 * 60;

export function signWebsitePayload(secret: string, timestamp: number, rawBody: string) {
  return `sha256=${hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;
}

export function verifyWebsiteSignature(secret: string, rawBody: string, timestampHeader: string | null, signatureHeader: string | null, now = Date.now()) {
  const ts = Number(timestampHeader);
  if (!timestampHeader || !Number.isFinite(ts)) return { ok: false as const, reason: "Missing or invalid X-LFM-Timestamp header" };
  if (Math.abs(now / 1000 - ts) > SIGNATURE_TOLERANCE_S) return { ok: false as const, reason: "Timestamp is too old or in the future" };
  if (!signatureHeader) return { ok: false as const, reason: "Missing X-LFM-Signature header" };
  return safeEqual(signatureHeader, signWebsitePayload(secret, ts, rawBody)) ? { ok: true as const } : { ok: false as const, reason: "Signature does not match" };
}

export function websiteSettings(i: Pick<Integration, "config">): WebsiteFormSettings {
  const parsed = websiteFormSettingsSchema.safeParse(i.config ?? {});
  return parsed.success ? parsed.data : websiteFormSettingsSchema.parse({});
}

/** Creates a website form connection. The signing secret is returned once and never shown again. */
export async function createWebsiteForm(ctx: OrgContext, raw: Partial<WebsiteFormSettings>, ip?: string | null) {
  assertPermission(ctx, "integrations:manage");
  const config = websiteFormSettingsSchema.parse(raw);
  const secret = `whsec_${randomToken(24)}`;
  const integration = await prisma.integration.create({
    data: {
      organizationId: ctx.organizationId,
      provider: "WEBSITE_FORM",
      name: config.name,
      // Ready to receive; becomes CONNECTED after the first successful submission.
      status: "PENDING",
      config,
      webhookKey: `wf_${randomToken(16)}`,
      encryptedWebhookSecret: encrypt(secret),
    },
  });
  await audit({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.created", targetType: "integration", targetId: integration.id, ip, metadata: { provider: "WEBSITE_FORM" } });
  return { integration: integrationView(integration), webhookKey: integration.webhookKey!, secret };
}

export async function updateWebsiteForm(ctx: OrgContext, id: string, raw: Partial<WebsiteFormSettings>) {
  assertPermission(ctx, "integrations:manage");
  const i = await prisma.integration.findFirst({ where: { id, organizationId: ctx.organizationId, provider: "WEBSITE_FORM" } });
  if (!i) throw Errors.notFound("Website form");
  const config = websiteFormSettingsSchema.parse({ ...websiteSettings(i), ...raw });
  return integrationView(await prisma.integration.update({ where: { id }, data: { config, name: config.name } }));
}

export async function rotateWebsiteSecret(ctx: OrgContext, id: string, ip?: string | null) {
  assertPermission(ctx, "integrations:manage");
  const i = await prisma.integration.findFirst({ where: { id, organizationId: ctx.organizationId, provider: "WEBSITE_FORM" } });
  if (!i) throw Errors.notFound("Website form");
  const secret = `whsec_${randomToken(24)}`;
  await prisma.integration.update({ where: { id }, data: { encryptedWebhookSecret: encrypt(secret) } });
  await audit({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.secret_rotated", targetType: "integration", targetId: id, ip });
  return { secret };
}

/** Public lookup by the key in the URL. Disconnected forms stop accepting submissions. */
export async function findWebsiteForm(webhookKey: string) {
  const i = await prisma.integration.findUnique({ where: { webhookKey } });
  if (!i || i.provider !== "WEBSITE_FORM" || i.status === "DISCONNECTED") return null;
  return i;
}

export function websiteSecret(i: Integration) {
  if (!i.encryptedWebhookSecret) throw new Error("Website form has no secret");
  return decrypt(i.encryptedWebhookSecret);
}

type Submission = { fields: Record<string, unknown>; verified: boolean; ip?: string | null; origin?: string | null; idempotencyKey?: string | null; userAgent?: string | null };

/** Turns a submission into a lead (idempotent per submission id). */
export async function ingestWebsiteSubmission(i: Integration, s: Submission): Promise<IngestResult> {
  const settings = websiteSettings(i);
  const { contact, extra } = mapFormFields(s.fields);
  // Our own control fields are not customer data.
  for (const k of ["submission_id", "lfm_hp", "lfm_started", "whatsapp_opt_in", "consent_whatsapp", "page_url", "website"]) delete extra[k];
  const pageUrl = typeof s.fields.page_url === "string" ? s.fields.page_url.slice(0, 500) : null;
  // Without a client-supplied id, identical submissions within 10 minutes count as one.
  const eventId = s.idempotencyKey
    ? `sub:${s.idempotencyKey.slice(0, 120)}`
    : `hash:${sha256Hex(`${hashPayload(s.fields)}:${s.ip ?? ""}:${Math.floor(Date.now() / 600_000)}`)}`;
  const res = await ingestLead({
    integration: i,
    sourceType: "WEBSITE",
    externalEventId: eventId,
    eventType: "website.submission",
    raw: contact,
    metadata: { form: settings.name, verified: s.verified, origin: s.origin ?? null, pageUrl, fields: extra, ip: s.ip ?? null, userAgent: s.userAgent?.slice(0, 200) ?? null },
    consent: settings.askWhatsAppOptIn && (isChecked(s.fields.whatsapp_opt_in) || isChecked(s.fields.consent_whatsapp)) ? { WHATSAPP: true } : undefined,
  });
  if (i.status !== "CONNECTED") {
    await prisma.integration.update({ where: { id: i.id }, data: { status: "CONNECTED", connectedAt: new Date(), lastError: null, lastTestedAt: new Date() } });
  }
  return res;
}

/** Browser-side protections for the embeddable form. Throws an AppError the route turns into a response. */
export function checkBrowserSubmission(i: Integration, s: { origin: string | null; fields: Record<string, unknown>; now?: number }, selfOrigin: string) {
  const { allowedOrigins } = websiteSettings(i);
  if (s.origin && s.origin !== selfOrigin && allowedOrigins.length > 0 && !allowedOrigins.includes(s.origin)) {
    throw new AppError("ORIGIN_NOT_ALLOWED", "This website isn't allowed to send to this form.", 403);
  }
  // Honeypot: a hidden field humans never fill in. Pretend success so bots don't adapt.
  if (typeof s.fields.lfm_hp === "string" && s.fields.lfm_hp.trim() !== "") return { spam: true as const };
  const started = Number(s.fields.lfm_started);
  if (Number.isFinite(started) && started > 0 && (s.now ?? Date.now()) - started < 2_000) return { spam: true as const };
  return { spam: false as const };
}

/** "Send a test submission": signs and ingests a sample lead server-side to prove the setup end to end. */
export async function sendWebsiteTestSubmission(ctx: OrgContext, id: string) {
  assertPermission(ctx, "integrations:manage");
  const i = await prisma.integration.findFirst({ where: { id, organizationId: ctx.organizationId, provider: "WEBSITE_FORM" } });
  if (!i) throw Errors.notFound("Website form");
  // Uses the tester's own address so any acknowledgement goes to them, showing what customers see.
  const me = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { email: true } });
  const fields = {
    name: "Test Lead (website form)",
    email: me.email,
    message: "This is a test submission sent from the Integrations page.",
    submission_id: `test-${randomToken(8)}`,
  };
  const res = await ingestWebsiteSubmission(i, { fields, verified: true, idempotencyKey: fields.submission_id as string });
  await prisma.integration.update({ where: { id }, data: { lastTestedAt: new Date() } });
  return res;
}
