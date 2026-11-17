import { prisma, type Integration, type Tx } from "@lfm/db";
import { whatsappConnectSchema, type WhatsAppConnectInput } from "@lfm/shared";
import { audit } from "../audit/audit";
import { encryptJson } from "../crypto/encryption";
import { Errors } from "../errors";
import { ingestLead } from "../intake/ingest";
import { normalizePhone } from "../leads/normalize";
import { logger } from "../logger";
import { recordConsent } from "../messaging/consent";
import { recordInboundMessage, storeInboundMessage } from "../messaging/inbound";
import { applyDeliveryStatus } from "../messaging/outbox";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { providerFetch } from "./http";
import { graphBase } from "./meta-common";
import { integrationView, readCredentials } from "./service";
import { ProviderError, type ChannelAdapter, type TestResult } from "./types";

/**
 * WhatsApp Business Platform (Cloud API) — official Graph API only (no unofficial sending).
 * Credentials: a permanent system-user access token. Config: phone number id (+ WABA id).
 * Webhooks: one app-level callback for all businesses; events are routed by phone_number_id.
 */

export type WhatsAppCreds = { accessToken: string };
export type WhatsAppConfig = { phoneNumberId: string; businessAccountId?: string; displayPhoneNumber?: string; verifiedName?: string };

/** Meta error codes that won't succeed on retry. */
const PERMANENT_CODES = new Set([131026, 131047, 131051, 131052, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 133010, 470]);

function classify(err: unknown): ProviderError {
  if (!(err instanceof ProviderError)) return new ProviderError((err as Error).message, "temporary");
  const code = Number(err.message.match(/code (\d+)/)?.[1]);
  if (code === 190) return new ProviderError("The WhatsApp access token is invalid or has expired. Paste a new token.", "permanent", "EAUTH");
  if (code === 131047) return new ProviderError("More than 24 hours since the customer's last message — an approved template is required.", "permanent", "WINDOW_CLOSED");
  if (PERMANENT_CODES.has(code)) return new ProviderError(err.message, "permanent", String(code));
  return err;
}

const toWaId = (e164: string) => e164.replace(/^\+/, "");

export const whatsappAdapter: ChannelAdapter<WhatsAppCreds, WhatsAppConfig> = {
  provider: "WHATSAPP_CLOUD",
  channel: "WHATSAPP",

  async test(creds, config): Promise<TestResult> {
    try {
      const r = await providerFetch<{ display_phone_number?: string; verified_name?: string }>(
        `${graphBase()}/${config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: { Authorization: `Bearer ${creds.accessToken}` }, label: "WhatsApp" },
      );
      return { ok: true, detail: `${r.verified_name ?? "WhatsApp number"} (${r.display_phone_number ?? config.phoneNumberId})` };
    } catch (err) {
      return { ok: false, error: classify(err).message };
    }
  },

  async send(creds, config, msg) {
    const body = msg.providerTemplate
      ? {
          messaging_product: "whatsapp",
          to: toWaId(msg.to),
          type: "template",
          template: {
            name: msg.providerTemplate.name,
            language: { code: msg.providerTemplate.language },
            components: msg.providerTemplate.params.length
              ? [{ type: "body", parameters: msg.providerTemplate.params.map((text) => ({ type: "text", text })) }]
              : [],
          },
        }
      : { messaging_product: "whatsapp", to: toWaId(msg.to), type: "text", text: { body: msg.text, preview_url: true } };
    try {
      const r = await providerFetch<{ messages?: { id: string }[] }>(`${graphBase()}/${config.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.accessToken}` },
        body,
        label: "WhatsApp",
      });
      return { providerMessageId: r.messages?.[0]?.id ?? null };
    } catch (err) {
      throw classify(err);
    }
  },
};

/** Saves the WhatsApp number and verifies it against the Graph API; CONNECTED only if it answers. */
export async function connectWhatsApp(ctx: OrgContext, raw: WhatsAppConnectInput, ip?: string | null) {
  assertPermission(ctx, "integrations:manage");
  const input = whatsappConnectSchema.parse(raw);
  const existing = await prisma.integration.findFirst({ where: { organizationId: ctx.organizationId, provider: "WHATSAPP_CLOUD" } });
  const token = input.accessToken || (existing?.encryptedCredentials ? readCredentials<WhatsAppCreds>(existing).accessToken : undefined);
  if (!token) throw Errors.validation("Paste the access token.", { accessToken: "Required" });
  // One WhatsApp number belongs to one business on this platform.
  const clash = await prisma.integration.findFirst({
    where: { provider: "WHATSAPP_CLOUD", status: "CONNECTED", organizationId: { not: ctx.organizationId }, config: { path: ["phoneNumberId"], equals: input.phoneNumberId } },
  });
  if (clash) throw Errors.conflict("This WhatsApp number is already connected to another business.");

  const config: WhatsAppConfig = { phoneNumberId: input.phoneNumberId, businessAccountId: input.businessAccountId };
  const creds: WhatsAppCreds = { accessToken: token };
  const test = await whatsappAdapter.test(creds, config);
  let warning: string | null = null;
  if (test.ok && input.businessAccountId) {
    // Subscribe our app to the account's webhooks so replies and delivery receipts arrive.
    try {
      await providerFetch(`${graphBase()}/${input.businessAccountId}/subscribed_apps`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, label: "WhatsApp" });
    } catch (err) {
      warning = `Connected, but subscribing to webhooks failed: ${(err as Error).message}`;
    }
  }
  if (test.ok) {
    const detail = /^(.*) \((.*)\)$/.exec(test.detail ?? "");
    config.verifiedName = detail?.[1];
    config.displayPhoneNumber = detail?.[2];
  }
  const now = new Date();
  const data = {
    name: `WhatsApp ${config.displayPhoneNumber ?? input.phoneNumberId}`,
    config,
    encryptedCredentials: encryptJson(creds),
    status: test.ok ? ("CONNECTED" as const) : ("ERROR" as const),
    lastError: test.ok ? warning : test.error,
    lastTestedAt: now,
    connectedAt: test.ok ? now : (existing?.connectedAt ?? null),
  };
  const integration = existing
    ? await prisma.integration.update({ where: { id: existing.id }, data })
    : await prisma.integration.create({ data: { organizationId: ctx.organizationId, provider: "WHATSAPP_CLOUD", ...data } });
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: test.ok ? "integration.connected" : "integration.connect_failed",
    targetType: "integration",
    targetId: integration.id,
    ip,
    metadata: { provider: "WHATSAPP_CLOUD" },
  });
  return { integration: integrationView(integration), test: test.ok ? { ok: true as const, detail: warning ?? test.detail } : test };
}

// ───────────────────────────── Webhooks ─────────────────────────────

type WaMessage = {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  context?: { id?: string };
};
type WaStatus = { id: string; status: "sent" | "delivered" | "read" | "failed"; timestamp?: string; errors?: { title?: string; message?: string; code?: number }[] };
type WaValue = {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
};
export type WhatsAppWebhook = { object?: string; entry?: { changes?: { field?: string; value?: WaValue }[] }[] };

const STOP_WORDS = new Set(["stop", "unsubscribe", "stop all", "opt out", "optout"]);
const START_WORDS = new Set(["start", "subscribe", "opt in"]);

function messageText(m: WaMessage): string {
  return m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? `[${m.type} message]`;
}

/**
 * Handles one webhook delivery. Each message/status is idempotent on its WhatsApp id, so Meta's
 * retries are harmless. Unknown numbers become new leads (source: WhatsApp).
 */
export async function processWhatsAppWebhook(payload: WhatsAppWebhook) {
  const result = { messages: 0, statuses: 0, newLeads: 0, ignored: 0 };
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== "messages" || !v?.metadata?.phone_number_id) continue;
      const integration = await prisma.integration.findFirst({
        where: { provider: "WHATSAPP_CLOUD", status: { in: ["CONNECTED", "ERROR"] }, config: { path: ["phoneNumberId"], equals: v.metadata.phone_number_id } },
      });
      if (!integration) {
        result.ignored++;
        continue;
      }
      for (const s of v.statuses ?? []) {
        const claimed = await claimEvent(integration, `status:${s.id}:${s.status}`, "whatsapp.status");
        if (!claimed) continue;
        if (s.status === "delivered" || s.status === "read" || s.status === "failed") {
          const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : undefined;
          const error = s.errors?.[0] ? `${s.errors[0].title ?? s.errors[0].message ?? "Delivery failed"}${s.errors[0].code ? ` (code ${s.errors[0].code})` : ""}` : undefined;
          await applyDeliveryStatus(s.id, s.status === "delivered" ? "DELIVERED" : s.status === "read" ? "READ" : "FAILED", { at, error });
        }
        result.statuses++;
      }
      for (const m of v.messages ?? []) {
        const profileName = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? v.contacts?.[0]?.profile?.name;
        const r = await handleInbound(integration, m, profileName);
        if (r === "new_lead") result.newLeads++;
        if (r !== "duplicate") result.messages++;
      }
    }
  }
  return result;
}

async function claimEvent(integration: Integration, externalEventId: string, eventType: string) {
  const r = await prisma.inboundEvent.createMany({
    data: [{ organizationId: integration.organizationId, integrationId: integration.id, externalEventId, eventType, payloadHash: externalEventId, processedAt: new Date() }],
    skipDuplicates: true,
  });
  return r.count === 1;
}

async function handleInbound(integration: Integration, m: WaMessage, profileName?: string) {
  const body = messageText(m);
  const receivedAt = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
  const from = `+${m.from.replace(/^\+/, "")}`;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: integration.organizationId }, select: { defaultCountry: true } });
  const phone = normalizePhone(from, org.defaultCountry);
  const keyword = body.trim().toLowerCase();

  const existing = await recordInboundMessage({
    organizationId: integration.organizationId,
    channel: "WHATSAPP",
    from,
    body,
    providerMessageId: m.id,
    receivedAt,
    inReplyToProviderMessageId: m.context?.id ?? null,
  });
  if (existing) {
    if (existing.duplicate) return "duplicate";
    await applyKeyword(integration.organizationId, existing.lead.id, keyword);
    return "reply";
  }

  // Someone new wrote to the business on WhatsApp → a new lead.
  const res = await ingestLead({
    integration,
    sourceType: "WHATSAPP",
    externalEventId: `msg:${m.id}`,
    eventType: "whatsapp.message",
    raw: { name: profileName ?? (phone.ok ? phone.display : from), phone: from, inquiry: body },
    metadata: { waId: m.from, profileName: profileName ?? null },
    afterCreate: async (tx: Tx, lead) => {
      // Store the message first so the 24h window is open when the acknowledgement is decided.
      await storeInboundMessage(tx, lead, { organizationId: integration.organizationId, channel: "WHATSAPP", from, body, providerMessageId: m.id, receivedAt });
    },
  });
  if (res.leadId) await applyKeyword(integration.organizationId, res.leadId, keyword);
  return res.outcome === "duplicate_event" ? "duplicate" : "new_lead";
}

async function applyKeyword(organizationId: string, leadId: string, keyword: string) {
  if (!STOP_WORDS.has(keyword) && !START_WORDS.has(keyword)) return;
  await prisma.$transaction((tx) =>
    recordConsent(tx, { organizationId, leadId, channel: "WHATSAPP", optedOut: STOP_WORDS.has(keyword), source: "whatsapp_keyword" }),
  );
  logger.info({ leadId, keyword }, "whatsapp consent keyword");
}
