import { prisma, type Channel, type Db, type FollowUpTask, type Lead, type Message, type MessageTemplate, type Tx } from "@lfm/db";
import { LEAD_FOLLOWUP_AUTOMATION, sendMessageSchema, type MessageChannel, type MessagePurpose, type SendMessageInput } from "@lfm/shared";
import { getLeadAutomationSettings } from "../automation/settings";
import { logExecution } from "../automation/executions";
import { AppError, Errors } from "../errors";
import { calendarFromOrg, nextWorkingTime } from "../followups/working-hours";
import { channelAdapterFor, getChannelIntegration, markIntegrationError, readCredentials } from "../integrations/service";
import { ProviderError } from "../integrations/types";
import { recordActivity } from "../leads/activity";
import { applyEmployeeContact, findAccessibleLead } from "../leads/service";
import { managerMemberIds, notify } from "../notifications/service";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { consentStatus, isOptedOut, unsubscribeToken } from "./consent";
import { extractVariables, renderTemplate, textToHtml, valuesForLead } from "./render";
import { resolveTemplate } from "./templates";

/**
 * Outbound messaging via an outbox (ADR-007).
 *
 *  1. queue*  → a `messages` row (QUEUED) with a unique idempotency key. Asking twice for the same
 *               message (webhook replay, job retry, double click) returns the existing row.
 *  2. worker  → sendQueuedMessage claims QUEUED → SENDING with a conditional update, re-checks every
 *               policy, calls the provider adapter and records the result.
 *  3. Retries are timed by the database (`scheduledFor`), so they survive restarts and Redis loss.
 */

export const MAX_SEND_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** A message stuck in SENDING this long means a worker died mid-send (delivery unknown). */
export const STUCK_SENDING_MS = 10 * 60_000;
/** WhatsApp customer-service window. */
const WHATSAPP_WINDOW_MS = 24 * 60 * 60_000;

const AUTOMATIC: MessagePurpose[] = ["acknowledgement", "follow_up", "fallback"];

export function addressFor(lead: Pick<Lead, "email" | "phoneE164">, channel: Channel): string | null {
  return channel === "EMAIL" ? lead.email : channel === "WHATSAPP" ? lead.phoneE164 : null;
}

async function automationActive(db: Db, organizationId: string) {
  const c = await db.automationConfig.findUnique({
    where: { organizationId_automationKey: { organizationId, automationKey: LEAD_FOLLOWUP_AUTOMATION } },
    select: { status: true },
  });
  return c?.status === "ACTIVE";
}

async function whatsappWindowOpen(db: Db, leadId: string, now = new Date()) {
  const conv = await db.conversation.findUnique({ where: { leadId_channel: { leadId, channel: "WHATSAPP" } } });
  return !!conv?.windowExpiresAt && conv.windowExpiresAt > now;
}

/** Next moment automatic messages may go out (sending-hours setting). */
async function nextSendingTime(db: Db, organizationId: string, at: Date): Promise<Date> {
  const [org, settings] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true, workingHours: true, holidays: true } }),
    getLeadAutomationSettings(organizationId, db),
  ]);
  const { mode, custom } = settings.messaging.sendingHours;
  if (mode === "ALWAYS") return at;
  const cal = calendarFromOrg(mode === "CUSTOM" && custom ? { ...org, workingHours: custom } : org);
  return nextWorkingTime(at, cal);
}

// ───────────────────────────── Queueing ─────────────────────────────

type QueueArgs = {
  lead: Lead;
  channel: Channel;
  purpose: MessagePurpose;
  idempotencyKey: string;
  subject?: string | null;
  body: string;
  template?: MessageTemplate | null;
  followUpTaskId?: string | null;
  sentByUserId?: string | null;
  scheduledFor?: Date | null;
};

/**
 * Inserts the message unless one with this idempotency key exists. Uses ON CONFLICT DO NOTHING so
 * a duplicate never aborts the surrounding transaction. Returns [message, createdNow].
 */
export async function queueMessage(tx: Tx, a: QueueArgs): Promise<[Message, boolean]> {
  const integration = await getChannelIntegration(tx, a.lead.organizationId, a.channel as MessageChannel);
  const res = await tx.message.createMany({
    data: [
      {
        organizationId: a.lead.organizationId,
        leadId: a.lead.id,
        direction: "OUTBOUND",
        channel: a.channel,
        purpose: a.purpose,
        templateId: a.template?.id ?? null,
        followUpTaskId: a.followUpTaskId ?? null,
        integrationId: integration?.id ?? null,
        subject: a.subject ?? null,
        body: a.body,
        toAddress: addressFor(a.lead, a.channel),
        status: "QUEUED",
        idempotencyKey: a.idempotencyKey,
        sentByUserId: a.sentByUserId ?? null,
        scheduledFor: a.scheduledFor ?? null,
      },
    ],
    skipDuplicates: true,
  });
  const message = await tx.message.findUniqueOrThrow({ where: { idempotencyKey: a.idempotencyKey } });
  if (res.count === 1) {
    await recordActivity(tx, {
      organizationId: a.lead.organizationId,
      leadId: a.lead.id,
      type: "MESSAGE_QUEUED",
      actorType: a.sentByUserId ? "USER" : "SYSTEM",
      actorUserId: a.sentByUserId,
      payload: { messageId: message.id, channel: a.channel, purpose: a.purpose, preview: a.body.slice(0, 160), scheduledFor: a.scheduledFor?.toISOString() ?? null },
    });
  }
  return [message, res.count === 1];
}

type ChannelCheck = { ok: true } | { ok: false; reason: string };

/** Can an automatic message go to this customer on this channel right now? */
async function canMessageAutomatically(db: Db, lead: Lead, channel: Channel): Promise<ChannelCheck> {
  if (!addressFor(lead, channel)) return { ok: false, reason: channel === "EMAIL" ? "No email address" : "No valid phone number" };
  if (await isOptedOut(db, lead.id, channel)) return { ok: false, reason: "Customer opted out" };
  if (!(await getChannelIntegration(db, lead.organizationId, channel as MessageChannel))) {
    return { ok: false, reason: `${channel === "EMAIL" ? "Email" : "WhatsApp"} isn't connected` };
  }
  if (channel === "WHATSAPP") {
    // WhatsApp Business rules: business-initiated messages need the customer's opt-in.
    const opted = (await consentStatus(db, lead.id, "WHATSAPP")) === "OPTED_IN";
    if (!opted && !(await whatsappWindowOpen(db, lead.id))) return { ok: false, reason: "No WhatsApp opt-in from this customer" };
  }
  return { ok: true };
}

async function renderFor(db: Db, lead: Lead, template: MessageTemplate) {
  const [org, settings, member] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: lead.organizationId } }),
    getLeadAutomationSettings(lead.organizationId, db),
    lead.assignedMemberId
      ? db.organizationMember.findUnique({ where: { id: lead.assignedMemberId }, include: { user: { select: { name: true } } } })
      : Promise.resolve(null),
  ]);
  const values = valuesForLead(lead, org, member?.user.name);
  const custom = settings.messaging.customVariables;
  return {
    body: renderTemplate(template.body, values, custom).output,
    subject: template.subject ? renderTemplate(template.subject, values, custom).output : null,
  };
}

/**
 * Picks channels for an automatic message: the configured ones that work for this customer,
 * otherwise the fallback channel. Logs a SKIPPED execution explaining anything not sent.
 */
async function queueAutomatic(
  tx: Tx,
  lead: Lead,
  args: { purpose: "acknowledgement" | "follow_up"; channels: Channel[]; templateKey: string; keyPrefix: string; followUpTaskId?: string },
): Promise<Message[]> {
  const settings = await getLeadAutomationSettings(lead.organizationId, tx);
  if (!settings.messaging.autoSend || !(await automationActive(tx, lead.organizationId))) return [];

  const skipped: string[] = [];
  const chosen: { channel: Channel; template: MessageTemplate }[] = [];
  const consider = async (channel: Channel) => {
    const check = await canMessageAutomatically(tx, lead, channel);
    if (!check.ok) return skipped.push(`${channel}: ${check.reason}`), false;
    const template = await resolveTemplate(tx, lead.organizationId, args.templateKey, channel as MessageChannel);
    if (!template || template.approval !== "APPROVED") return skipped.push(`${channel}: template not approved`), false;
    chosen.push({ channel, template });
    return true;
  };
  for (const ch of args.channels) await consider(ch);
  const fb = settings.messaging.fallbackChannel;
  if (chosen.length === 0 && fb && !args.channels.includes(fb)) await consider(fb);

  const scheduledFor = await nextSendingTime(tx, lead.organizationId, new Date());
  const queued: Message[] = [];
  for (const { channel, template } of chosen) {
    const r = await renderFor(tx, lead, template);
    const [m] = await queueMessage(tx, {
      lead,
      channel,
      purpose: args.purpose,
      idempotencyKey: `${args.keyPrefix}:${channel}`,
      template,
      followUpTaskId: args.followUpTaskId,
      scheduledFor: scheduledFor > new Date() ? scheduledFor : null,
      ...r,
    });
    queued.push(m);
  }
  if (skipped.length) {
    await logExecution(tx, {
      organizationId: lead.organizationId,
      eventType: args.purpose === "acknowledgement" ? "message.acknowledgement_skipped" : "message.follow_up_skipped",
      status: "SKIPPED",
      leadId: lead.id,
      followUpTaskId: args.followUpTaskId,
      output: { reasons: skipped, sentOn: chosen.map((c) => c.channel) },
    });
  }
  return queued;
}

/** Automatic acknowledgement for a newly arrived lead. Idempotent per lead and channel. */
export async function queueAcknowledgement(tx: Tx, lead: Lead) {
  const settings = await getLeadAutomationSettings(lead.organizationId, tx);
  if (!settings.messaging.acknowledgement.enabled) return [];
  return queueAutomatic(tx, lead, {
    purpose: "acknowledgement",
    channels: settings.messaging.acknowledgement.channels,
    templateKey: "ACKNOWLEDGEMENT",
    keyPrefix: `ack:${lead.id}`,
  });
}

/** Automatic follow-up message when a sequence step becomes due. Idempotent per task and channel. */
export async function queueFollowUpMessage(tx: Tx, lead: Lead, task: FollowUpTask) {
  if (!task.sequenceRunId.startsWith("seq_") || !task.ruleId) return [];
  const settings = await getLeadAutomationSettings(lead.organizationId, tx);
  if (!settings.messaging.followUpMessages.enabled) return [];
  const rule = await tx.followUpRule.findUnique({ where: { id: task.ruleId } });
  if (!rule || rule.channels.length === 0) return [];
  return queueAutomatic(tx, lead, {
    purpose: "follow_up",
    channels: rule.channels,
    templateKey: rule.templateKey,
    keyPrefix: `fu:${task.id}`,
    followUpTaskId: task.id,
  });
}

/** A team member writes to the customer from the lead page. Counts as contacting them. */
export async function sendManualMessage(ctx: OrgContext, leadId: string, raw: SendMessageInput) {
  assertPermission(ctx, "messages:send");
  const input = sendMessageSchema.parse(raw);
  const lead = await findAccessibleLead(ctx, leadId);
  if (!addressFor(lead, input.channel)) {
    throw Errors.validation(input.channel === "EMAIL" ? "This customer has no email address." : "This customer has no valid phone number.");
  }
  if (await isOptedOut(prisma, lead.id, input.channel)) throw Errors.validation("This customer has opted out of this channel.");
  if (!(await getChannelIntegration(prisma, ctx.organizationId, input.channel))) {
    throw Errors.validation(`${input.channel === "EMAIL" ? "Email" : "WhatsApp"} isn't connected yet. Connect it under Integrations.`);
  }
  if (input.channel === "EMAIL" && !input.subject) throw Errors.validation("Add a subject.", { subject: "Required" });

  return prisma.$transaction(async (tx) => {
    const [message, created] = await queueMessage(tx, {
      lead,
      channel: input.channel,
      purpose: "manual",
      idempotencyKey: `manual:${ctx.organizationId}:${input.clientRequestId}`,
      subject: input.subject,
      body: input.body,
      sentByUserId: ctx.userId,
    });
    if (created && lead.status !== "CONVERTED" && lead.status !== "LOST") {
      await applyEmployeeContact(tx, ctx, lead, { channel: input.channel, note: `Sent ${input.channel === "EMAIL" ? "an email" : "a WhatsApp message"}`, awaitingCustomer: true });
    }
    return message;
  }, { maxWait: 15_000, timeout: 20_000 });
}

// ───────────────────────────── Sending (worker) ─────────────────────────────

export async function findDueMessages(now = new Date(), limit = 200) {
  return prisma.message.findMany({
    where: { direction: "OUTBOUND", status: "QUEUED", OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, attempts: true },
  });
}

export type SendOutcome = "sent" | "deferred" | "retry_scheduled" | "failed" | "cancelled" | "not_ready";

async function cancel(db: Db, m: Message, reason: string) {
  await db.message.update({ where: { id: m.id }, data: { status: "CANCELLED", failureKind: "policy", lastError: reason } });
  await logExecution(db, {
    organizationId: m.organizationId,
    eventType: `message.${m.purpose}`,
    status: "SKIPPED",
    leadId: m.leadId,
    messageId: m.id,
    output: { channel: m.channel, reason },
  });
  return "cancelled" as const;
}

/**
 * Sends one queued message. Safe to run concurrently or repeatedly: only the caller that flips
 * QUEUED → SENDING proceeds.
 */
export async function sendQueuedMessage(messageId: string, now = new Date(), jobId?: string): Promise<SendOutcome> {
  const claimed = await prisma.message.updateMany({
    where: { id: messageId, status: "QUEUED", OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
    data: { status: "SENDING", attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return "not_ready";
  const m = await prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: { template: true } });
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: m.leadId } });
  const automatic = AUTOMATIC.includes(m.purpose as MessagePurpose);

  // ── Policy re-checks at send time (the world may have changed since queueing) ──
  if (await isOptedOut(prisma, lead.id, m.channel)) return cancel(prisma, m, "Customer opted out");
  if (automatic) {
    if (!(await automationActive(prisma, lead.organizationId))) return cancel(prisma, m, "Automation is paused");
    const settings = await getLeadAutomationSettings(lead.organizationId);
    if (!settings.messaging.autoSend) return cancel(prisma, m, "Automatic sending is turned off");
    if (lead.status === "CONVERTED" || lead.status === "LOST") return cancel(prisma, m, `Lead ${lead.status === "CONVERTED" ? "converted" : "lost"}`);
    if (lead.status === "ON_HOLD") return cancel(prisma, m, "Lead on hold");
    if (m.purpose !== "acknowledgement" && lead.lastCustomerReplyAt && lead.lastCustomerReplyAt > m.createdAt) {
      return cancel(prisma, m, "Customer replied before this was sent");
    }
    if (m.template && m.template.approval !== "APPROVED") return cancel(prisma, m, "Template is no longer approved");
    const next = await nextSendingTime(prisma, lead.organizationId, now);
    if (next > now) {
      await prisma.message.update({ where: { id: m.id }, data: { status: "QUEUED", scheduledFor: next, attempts: { decrement: 1 } } });
      return "deferred";
    }
  }

  const integration =
    (m.integrationId ? await prisma.integration.findUnique({ where: { id: m.integrationId } }) : null)?.status === "CONNECTED"
      ? await prisma.integration.findUniqueOrThrow({ where: { id: m.integrationId! } })
      : await getChannelIntegration(prisma, lead.organizationId, m.channel as MessageChannel);
  const adapter = integration ? channelAdapterFor(integration) : null;
  const to = m.toAddress ?? addressFor(lead, m.channel);
  if (!integration || !adapter) return fail(m, lead, new ProviderError(`${m.channel === "EMAIL" ? "Email" : "WhatsApp"} isn't connected`, "permanent"), jobId);
  if (!to) return fail(m, lead, new ProviderError("The customer has no address for this channel", "permanent"), jobId);

  let providerTemplate: { name: string; language: string; params: string[] } | null = null;
  if (m.channel === "WHATSAPP" && !(await whatsappWindowOpen(prisma, lead.id, now))) {
    // Outside the 24h window WhatsApp only allows pre-approved templates.
    if (!m.template?.providerTemplateName) {
      return fail(m, lead, new ProviderError("Outside WhatsApp's 24-hour window a Meta-approved template is required", "permanent", "WINDOW_CLOSED"), jobId);
    }
    // Meta templates use positional parameters {{1}}, {{2}}…: fill them in the order our template uses variables.
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: lead.organizationId } });
    const member = lead.assignedMemberId
      ? await prisma.organizationMember.findUnique({ where: { id: lead.assignedMemberId }, include: { user: { select: { name: true } } } })
      : null;
    const settings = await getLeadAutomationSettings(lead.organizationId);
    const values = valuesForLead(lead, org, member?.user.name);
    const params = extractVariables(m.template.body).map((v) => renderTemplate(`{{${v}}}`, values, settings.messaging.customVariables).output || "-");
    providerTemplate = { name: m.template.providerTemplateName, language: m.template.providerLanguage ?? "en", params };
  }

  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const token = unsubscribeToken(lead.id, "EMAIL");
  // People click the page link (it asks to confirm); mail clients POST to the one-click endpoint (RFC 8058).
  const unsubscribeUrl = `${appUrl}/unsubscribe/${token}`;
  const oneClickUrl = `${appUrl}/api/unsubscribe/${token}`;
  const text = m.channel === "EMAIL" ? `${m.body}\n\n—\nDon't want these emails? ${unsubscribeUrl}` : m.body;

  try {
    const res = await adapter.send(readCredentials(integration), integration.config, {
      to,
      subject: m.subject,
      text,
      html: m.channel === "EMAIL" ? `${textToHtml(m.body)}\n<p style="color:#888;font-size:12px">Don't want these emails? <a href="${unsubscribeUrl}">Unsubscribe</a></p>` : undefined,
      messageId: m.id,
      headers: m.channel === "EMAIL" ? { "List-Unsubscribe": `<${oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
      providerTemplate,
    });
    await prisma.$transaction(async (tx) => {
      await tx.message.update({
        where: { id: m.id },
        data: { status: "SENT", sentAt: new Date(), providerMessageId: res.providerMessageId, integrationId: integration.id, lastError: null, failureKind: null },
      });
      await recordActivity(tx, {
        organizationId: m.organizationId,
        leadId: m.leadId,
        type: "MESSAGE_SENT",
        actorType: m.sentByUserId ? "USER" : "SYSTEM",
        actorUserId: m.sentByUserId,
        payload: { messageId: m.id, channel: m.channel, purpose: m.purpose, preview: m.body.slice(0, 160), subject: m.subject },
      });
      await logExecution(tx, {
        organizationId: m.organizationId,
        eventType: `message.${m.purpose}`,
        status: "SUCCESS",
        leadId: m.leadId,
        messageId: m.id,
        jobId,
        attempt: m.attempts,
        output: { channel: m.channel, providerMessageId: res.providerMessageId },
      });
    });
    return "sent";
  } catch (err) {
    const pe = err instanceof ProviderError ? err : new ProviderError((err as Error).message ?? "Unknown error", "temporary");
    if (pe.code === "EAUTH") await markIntegrationError(prisma, integration.id, pe.message);
    return fail(m, lead, pe, jobId);
  }
}

/** Records a failed attempt: schedules a retry for temporary errors, otherwise fails (and falls back). */
async function fail(m: Message, lead: Lead, err: ProviderError, jobId?: string): Promise<SendOutcome> {
  if (err.kind === "temporary" && m.attempts < MAX_SEND_ATTEMPTS) {
    const delay = BACKOFF_MS[Math.min(m.attempts - 1, BACKOFF_MS.length - 1)]!;
    await prisma.message.update({
      where: { id: m.id },
      data: { status: "QUEUED", scheduledFor: new Date(Date.now() + delay), lastError: err.message, errorRetryable: true },
    });
    await logExecution(prisma, {
      organizationId: m.organizationId,
      eventType: `message.${m.purpose}`,
      status: "RETRYING",
      leadId: m.leadId,
      messageId: m.id,
      jobId,
      attempt: m.attempts,
      error: err.message,
      retryable: true,
      output: { nextAttemptInSeconds: delay / 1000 },
    });
    return "retry_scheduled";
  }
  const failureKind = err.kind === "temporary" ? "temporary_exhausted" : err.kind;
  await prisma.$transaction(async (tx) => {
    await tx.message.update({
      where: { id: m.id },
      data: { status: "FAILED", failedAt: new Date(), lastError: err.message, failureKind, errorRetryable: err.kind !== "permanent" },
    });
    await recordActivity(tx, {
      organizationId: m.organizationId,
      leadId: m.leadId,
      type: "MESSAGE_FAILED",
      actorType: "SYSTEM",
      payload: { messageId: m.id, channel: m.channel, purpose: m.purpose, error: err.message, failureKind },
    });
    await logExecution(tx, {
      organizationId: m.organizationId,
      eventType: `message.${m.purpose}`,
      status: "FAILED",
      leadId: m.leadId,
      messageId: m.id,
      jobId,
      attempt: m.attempts,
      error: err.message,
      retryable: err.kind !== "permanent",
      output: { channel: m.channel, failureKind },
    });
    const memberIds = lead.assignedMemberId ? [lead.assignedMemberId] : await managerMemberIds(tx, lead.organizationId);
    await notify(tx, {
      organizationId: m.organizationId,
      memberIds,
      event: "messageFailed",
      title: `Message to ${lead.name} failed`,
      body: err.message,
      leadId: lead.id,
    });
    // Automatic messages try the fallback channel once.
    if (m.purpose === "acknowledgement" || m.purpose === "follow_up") await queueFallback(tx, m, lead);
  });
  return "failed";
}

async function queueFallback(tx: Tx, m: Message, lead: Lead) {
  const settings = await getLeadAutomationSettings(lead.organizationId, tx);
  const fb = settings.messaging.fallbackChannel;
  if (!fb || fb === m.channel) return;
  const check = await canMessageAutomatically(tx, lead, fb);
  if (!check.ok) return;
  const original = m.templateId ? await tx.messageTemplate.findUnique({ where: { id: m.templateId } }) : null;
  const key = original?.key ?? (m.purpose === "acknowledgement" ? "ACKNOWLEDGEMENT" : "FOLLOW_UP");
  const template = await resolveTemplate(tx, lead.organizationId, key, fb);
  if (!template || template.approval !== "APPROVED") return;
  const r = await renderFor(tx, lead, template);
  await queueMessage(tx, { lead, channel: fb, purpose: "fallback", idempotencyKey: `${m.idempotencyKey}:fallback`, template, followUpTaskId: m.followUpTaskId, ...r });
}

/**
 * Worker crash between claiming and recording the result leaves a message SENDING. We can't know if
 * it went out, so it's failed as "delivery unknown" for a person to decide — never resent blindly.
 */
export async function recoverStuckMessages(now = new Date()) {
  const stuck = await prisma.message.findMany({
    where: { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
    include: { lead: true },
    take: 100,
  });
  for (const m of stuck) {
    // Claim it so two sweeps don't both handle the same message.
    const res = await prisma.message.updateMany({
      where: { id: m.id, status: "SENDING", updatedAt: m.updatedAt },
      data: { lastError: "Recovering interrupted send" },
    });
    if (res.count === 1) {
      await fail(m, m.lead, new ProviderError("Sending was interrupted; the message may or may not have been delivered.", "delivery_unknown"));
    }
  }
  return stuck.length;
}

/**
 * Safe retry from the UI. Re-uses the same message row and idempotency key, so it can never
 * create a second copy. "Delivery unknown" failures need explicit confirmation.
 */
export async function retryMessage(ctx: OrgContext, messageId: string, opts: { confirmPossibleDuplicate?: boolean } = {}) {
  assertPermission(ctx, "messages:send");
  const m = await prisma.message.findFirst({ where: { id: messageId, organizationId: ctx.organizationId, direction: "OUTBOUND" } });
  if (!m) throw Errors.notFound("Message");
  await findAccessibleLead(ctx, m.leadId);
  if (m.status !== "FAILED") throw Errors.conflict("Only failed messages can be retried.");
  if (m.failureKind === "delivery_unknown" && !opts.confirmPossibleDuplicate) {
    throw new AppError("CONFIRM_POSSIBLE_DUPLICATE", "This message may already have reached the customer. Confirm to send it again.", 409);
  }
  const res = await prisma.message.updateMany({
    where: { id: m.id, status: "FAILED" },
    data: { status: "QUEUED", scheduledFor: null, attempts: 0, failedAt: null, failureKind: null, lastError: null },
  });
  if (res.count !== 1) throw Errors.conflict("This message is already being retried.");
  await logExecution(prisma, {
    organizationId: m.organizationId,
    eventType: `message.${m.purpose}`,
    status: "RETRYING",
    leadId: m.leadId,
    messageId: m.id,
    input: { retriedBy: ctx.userId, manual: true },
  });
  return prisma.message.findUniqueOrThrow({ where: { id: m.id } });
}

// ───────────────────────────── Delivery status & history ─────────────────────────────

const STATUS_RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3 };

/** Provider delivery receipts (WhatsApp webhooks, email bounces). Never moves a status backwards. */
export async function applyDeliveryStatus(providerMessageId: string, status: "DELIVERED" | "READ" | "FAILED", opts: { at?: Date; error?: string } = {}) {
  const m = await prisma.message.findFirst({ where: { providerMessageId } });
  if (!m) return null;
  if (status === "FAILED") {
    if (m.status === "FAILED") return m;
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: m.leadId } });
    await fail(m, lead, new ProviderError(opts.error ?? "The provider reported the message as undelivered", "permanent"));
    return prisma.message.findUnique({ where: { id: m.id } });
  }
  if ((STATUS_RANK[m.status] ?? 0) >= STATUS_RANK[status]!) return m;
  const at = opts.at ?? new Date();
  const updated = await prisma.message.update({
    where: { id: m.id },
    data: { status, ...(status === "DELIVERED" ? { deliveredAt: at } : { readAt: at, deliveredAt: m.deliveredAt ?? at }) },
  });
  if (status === "DELIVERED") {
    await recordActivity(prisma, {
      organizationId: m.organizationId,
      leadId: m.leadId,
      type: "MESSAGE_DELIVERED",
      actorType: "SYSTEM",
      occurredAt: at,
      payload: { messageId: m.id, channel: m.channel },
    });
  }
  return updated;
}

export async function listLeadMessages(ctx: OrgContext, leadId: string) {
  const lead = await findAccessibleLead(ctx, leadId);
  return prisma.message.findMany({
    where: { leadId: lead.id, organizationId: ctx.organizationId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export { WHATSAPP_WINDOW_MS };
