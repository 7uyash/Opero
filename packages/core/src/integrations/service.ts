import { prisma, type Db, type Integration, type IntegrationProvider } from "@lfm/db";
import { smtpConnectSchema, type MessageChannel, type SmtpConnectInput } from "@lfm/shared";
import { audit } from "../audit/audit";
import { decryptJson, encryptJson } from "../crypto/encryption";
import { Errors } from "../errors";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { smtpAdapter, type SmtpConfig, type SmtpCredentials } from "./smtp";
import type { ChannelAdapter } from "./types";
import { gmailAdapterFor } from "./gmail";
import { whatsappAdapter } from "./whatsapp";

/** Which providers can send on each channel. */
const CHANNEL_PROVIDERS: Record<MessageChannel, IntegrationProvider[]> = {
  EMAIL: ["SMTP", "GMAIL"],
  WHATSAPP: ["WHATSAPP_CLOUD"],
};

/**
 * The sending adapter for a connection. Resolved lazily (at call time) so provider modules can
 * import this service without an import cycle at load time. Gmail needs the row to refresh tokens.
 */
export function channelAdapterFor(i: Integration): ChannelAdapter<any, any> | null {
  switch (i.provider) {
    case "SMTP":
      return smtpAdapter;
    case "WHATSAPP_CLOUD":
      return whatsappAdapter;
    case "GMAIL":
      return gmailAdapterFor(i);
    default:
      return null;
  }
}

/** Safe, credential-free view for the API/UI. */
export function integrationView(i: Integration) {
  const cfg = (i.config ?? {}) as Record<string, unknown>;
  return {
    id: i.id,
    provider: i.provider,
    name: i.name,
    status: i.status,
    lastError: i.lastError,
    lastTestedAt: i.lastTestedAt,
    connectedAt: i.connectedAt,
    // Only non-secret settings are exposed.
    config: Object.fromEntries(Object.entries(cfg).filter(([k]) => !/secret|token|password/i.test(k))),
    hasCredentials: !!i.encryptedCredentials,
    webhookKey: i.webhookKey,
  };
}

export async function listIntegrations(ctx: OrgContext) {
  const rows = await prisma.integration.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "asc" } });
  return rows.map(integrationView);
}

/** The connected integration that sends on a channel (prefers the most recently connected). */
export async function getChannelIntegration(db: Db, organizationId: string, channel: MessageChannel): Promise<Integration | null> {
  const providers = CHANNEL_PROVIDERS[channel];
  return db.integration.findFirst({
    where: { organizationId, provider: { in: providers }, status: "CONNECTED" },
    orderBy: { connectedAt: "desc" },
  });
}

export function readCredentials<T>(i: Integration): T {
  return (i.encryptedCredentials ? decryptJson<T>(i.encryptedCredentials) : {}) as T;
}

// ───────────────────────────── SMTP ─────────────────────────────

/**
 * Saves SMTP settings and verifies them against the real server. The integration is only marked
 * CONNECTED when the server accepts the login; otherwise it is saved as ERROR with the reason.
 */
export async function connectSmtp(ctx: OrgContext, raw: SmtpConnectInput, ip?: string | null) {
  assertPermission(ctx, "integrations:manage");
  const input = smtpConnectSchema.parse(raw);
  const existing = await prisma.integration.findFirst({ where: { organizationId: ctx.organizationId, provider: "SMTP" } });
  const prevCreds = existing ? readCredentials<SmtpCredentials>(existing) : {};
  // An empty password field on an update keeps the saved password.
  const creds: SmtpCredentials = {
    username: input.username || undefined,
    password: input.password || (input.username === prevCreds.username ? prevCreds.password : undefined),
  };
  const config: SmtpConfig = {
    host: input.host,
    port: input.port,
    secure: input.secure,
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    replyTo: input.replyTo,
  };
  const result = await smtpAdapter.test(creds, config);
  const now = new Date();
  const data = {
    name: `Email (${input.fromEmail})`,
    config,
    encryptedCredentials: encryptJson(creds),
    status: result.ok ? ("CONNECTED" as const) : ("ERROR" as const),
    lastError: result.ok ? null : result.error,
    lastTestedAt: now,
    connectedAt: result.ok ? now : (existing?.connectedAt ?? null),
  };
  const integration = existing
    ? await prisma.integration.update({ where: { id: existing.id }, data })
    : await prisma.integration.create({ data: { organizationId: ctx.organizationId, provider: "SMTP", ...data } });
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: result.ok ? "integration.connected" : "integration.connect_failed",
    targetType: "integration",
    targetId: integration.id,
    ip,
    metadata: { provider: "SMTP", host: input.host, ...(result.ok ? {} : { error: result.error }) },
  });
  return { integration: integrationView(integration), test: result };
}

async function findIntegration(ctx: OrgContext, id: string) {
  const i = await prisma.integration.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!i) throw Errors.notFound("Connection");
  return i;
}

/** Re-tests the connection; with `sendTo`, also sends a real test email. */
export async function testIntegration(ctx: OrgContext, id: string, opts: { sendTo?: string } = {}) {
  assertPermission(ctx, "integrations:manage");
  const i = await findIntegration(ctx, id);
  const adapter = channelAdapterFor(i);
  if (!adapter || !i.encryptedCredentials) throw Errors.validation("This connection can't be tested yet.");
  const creds = readCredentials(i);
  let result = await adapter.test(creds, i.config);
  if (result.ok && opts.sendTo) {
    try {
      await adapter.send(creds, i.config, {
        to: opts.sendTo,
        subject: "Test email from Lead & Follow-up Manager",
        text: "This is a test. If you received it, your email connection works.",
        messageId: `test-${Date.now()}`,
      });
      result = { ok: true, detail: `Test email sent to ${opts.sendTo}` };
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }
  }
  const updated = await prisma.integration.update({
    where: { id: i.id },
    data: {
      status: result.ok ? "CONNECTED" : "ERROR",
      lastError: result.ok ? null : result.error,
      lastTestedAt: new Date(),
      ...(result.ok && !i.connectedAt ? { connectedAt: new Date() } : {}),
    },
  });
  return { integration: integrationView(updated), test: result };
}

export async function disconnectIntegration(ctx: OrgContext, id: string, ip?: string | null) {
  assertPermission(ctx, "integrations:manage");
  const i = await findIntegration(ctx, id);
  // Credentials are wiped, not just hidden.
  const updated = await prisma.integration.update({
    where: { id: i.id },
    data: { status: "DISCONNECTED", encryptedCredentials: null, lastError: null },
  });
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "integration.disconnected",
    targetType: "integration",
    targetId: i.id,
    ip,
    metadata: { provider: i.provider },
  });
  return integrationView(updated);
}

/** Marks a connection as broken after a provider says the credentials are no longer valid. */
export async function markIntegrationError(db: Db, integrationId: string, error: string) {
  await db.integration.update({ where: { id: integrationId }, data: { status: "ERROR", lastError: error } });
}
