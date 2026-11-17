import { prisma, type Channel, type Lead, type Tx } from "@lfm/db";
import { logExecution } from "../automation/executions";
import { onCustomerReply } from "../followups/engine";
import { normalizeEmail, normalizePhone } from "../leads/normalize";
import { WHATSAPP_WINDOW_MS } from "./outbox";

export type InboundMessage = {
  organizationId: string;
  channel: Channel;
  /** Sender address: email, or phone in any format. */
  from: string;
  body: string;
  subject?: string | null;
  providerMessageId?: string | null;
  externalThreadId?: string | null;
  receivedAt?: Date;
  /** Our outbound message id the customer replied to (from email In-Reply-To headers). */
  inReplyToMessageId?: string | null;
  /** Provider id of the message replied to (WhatsApp context.id, Gmail thread). */
  inReplyToProviderMessageId?: string | null;
};

/**
 * Stores an inbound message on the lead's conversation (opening the WhatsApp 24h window) without
 * running reply rules. Used directly when the message *creates* the lead.
 */
export async function storeInboundMessage(tx: Tx, lead: Lead, m: InboundMessage) {
  const at = m.receivedAt ?? new Date();
  const windowExpiresAt = m.channel === "WHATSAPP" ? new Date(at.getTime() + WHATSAPP_WINDOW_MS) : null;
  const conversation = await tx.conversation.upsert({
    where: { leadId_channel: { leadId: lead.id, channel: m.channel } },
    update: { externalThreadId: m.externalThreadId ?? undefined, ...(windowExpiresAt ? { windowExpiresAt } : {}) },
    create: { organizationId: m.organizationId, leadId: lead.id, channel: m.channel, externalThreadId: m.externalThreadId ?? null, windowExpiresAt },
  });
  return tx.message.create({
    data: {
      organizationId: m.organizationId,
      leadId: lead.id,
      conversationId: conversation.id,
      direction: "INBOUND",
      channel: m.channel,
      purpose: "reply",
      subject: m.subject ?? null,
      body: m.body.slice(0, 20_000),
      fromAddress: m.from,
      status: "RECEIVED",
      providerMessageId: m.providerMessageId ?? null,
      createdAt: at,
    },
  });
}

async function findLeadForSender(m: InboundMessage): Promise<Lead | null> {
  if (m.inReplyToMessageId || m.inReplyToProviderMessageId) {
    const original = await prisma.message.findFirst({
      where: {
        organizationId: m.organizationId,
        direction: "OUTBOUND",
        OR: [
          ...(m.inReplyToMessageId ? [{ id: m.inReplyToMessageId }] : []),
          ...(m.inReplyToProviderMessageId ? [{ providerMessageId: m.inReplyToProviderMessageId }] : []),
        ],
      },
    });
    if (original) return prisma.lead.findUnique({ where: { id: original.leadId } });
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: m.organizationId }, select: { defaultCountry: true } });
  const where =
    m.channel === "EMAIL"
      ? { emailNormalized: normalizeEmail(m.from) ?? "__none__" }
      : (() => {
          const p = normalizePhone(m.from, org.defaultCountry);
          return { phoneE164: p.ok ? p.e164 : "__none__" };
        })();
  // Prefer an open lead; otherwise the most recent one.
  return (
    (await prisma.lead.findFirst({ where: { organizationId: m.organizationId, ...where, status: { notIn: ["CONVERTED", "LOST"] } }, orderBy: { createdAt: "desc" } })) ??
    (await prisma.lead.findFirst({ where: { organizationId: m.organizationId, ...where }, orderBy: { createdAt: "desc" } }))
  );
}

/**
 * A customer's reply arrived (email or WhatsApp). Records it on the right lead's conversation and
 * runs the reply rules: automatic follow-ups pause and the assigned person is told.
 * Idempotent per provider message id. Returns null when the sender matches no lead
 * (the source adapter then decides whether to create a new lead).
 */
export async function recordInboundMessage(m: InboundMessage): Promise<{ lead: Lead; messageId: string; duplicate: boolean } | null> {
  const at = m.receivedAt ?? new Date();
  if (m.providerMessageId) {
    const existing = await prisma.message.findFirst({
      where: { organizationId: m.organizationId, providerMessageId: m.providerMessageId, direction: "INBOUND" },
    });
    if (existing) return { lead: await prisma.lead.findUniqueOrThrow({ where: { id: existing.leadId } }), messageId: existing.id, duplicate: true };
  }
  const lead = await findLeadForSender(m);
  if (!lead) return null;

  return prisma.$transaction(async (tx) => {
    const message = await storeInboundMessage(tx, lead, { ...m, receivedAt: at });
    const updated = await onCustomerReply(tx, lead, { at, channel: m.channel, preview: m.body });
    await logExecution(tx, {
      organizationId: m.organizationId,
      eventType: "message.reply_received",
      status: "SUCCESS",
      leadId: lead.id,
      messageId: message.id,
      output: { channel: m.channel },
    });
    return { lead: updated, messageId: message.id, duplicate: false };
  });
}
