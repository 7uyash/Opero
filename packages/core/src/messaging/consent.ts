import { prisma, type Channel, type Db } from "@lfm/db";
import { optOutSchema } from "@lfm/shared";
import { hmacSha256Hex, safeEqual } from "../crypto/tokens";
import { Errors } from "../errors";
import { recordActivity } from "../leads/activity";
import { findAccessibleLead } from "../leads/service";
import { assertPermission, type OrgContext } from "../tenancy/context";

const MESSAGE_CHANNELS: Channel[] = ["EMAIL", "WHATSAPP"];

export async function consentStatus(db: Db, leadId: string, channel: Channel) {
  const c = await db.consent.findUnique({ where: { leadId_channel: { leadId, channel } } });
  return c?.status ?? null;
}

export async function isOptedOut(db: Db, leadId: string, channel: Channel) {
  return (await consentStatus(db, leadId, channel)) === "OPTED_OUT";
}

/** Records consent (e.g. a website form's WhatsApp opt-in checkbox, or a customer's opt-out). */
export async function recordConsent(
  db: Db,
  args: { organizationId: string; leadId: string; channel: Channel; optedOut: boolean; source: string; actorUserId?: string | null },
) {
  const status = args.optedOut ? "OPTED_OUT" : "OPTED_IN";
  const prev = await consentStatus(db, args.leadId, args.channel);
  if (prev === status) return false;
  await db.consent.upsert({
    where: { leadId_channel: { leadId: args.leadId, channel: args.channel } },
    update: { status, source: args.source, recordedAt: new Date() },
    create: { organizationId: args.organizationId, leadId: args.leadId, channel: args.channel, status, source: args.source },
  });
  if (args.optedOut) {
    // Anything still waiting to go out on that channel is cancelled.
    await db.message.updateMany({
      where: { leadId: args.leadId, channel: args.channel, direction: "OUTBOUND", status: "QUEUED" },
      data: { status: "CANCELLED", failureKind: "policy", lastError: "Customer opted out" },
    });
    await recordActivity(db, {
      organizationId: args.organizationId,
      leadId: args.leadId,
      type: "OPTED_OUT",
      actorType: args.actorUserId ? "USER" : "CUSTOMER",
      actorUserId: args.actorUserId,
      payload: { channel: args.channel, source: args.source },
    });
  }
  // Lead-level flag = opted out of every messaging channel.
  const statuses = await Promise.all(MESSAGE_CHANNELS.map((ch) => consentStatus(db, args.leadId, ch)));
  await db.lead.update({
    where: { id: args.leadId },
    data: { optedOutAt: statuses.every((s) => s === "OPTED_OUT") ? new Date() : null },
  });
  return true;
}

/** Team member updates a customer's messaging preferences (e.g. they asked not to be contacted). */
export async function setLeadOptOut(ctx: OrgContext, leadId: string, raw: { channel: string; optedOut: boolean }) {
  assertPermission(ctx, "leads:update");
  const input = optOutSchema.parse(raw);
  const lead = await findAccessibleLead(ctx, leadId);
  const channels = input.channel === "ALL" ? MESSAGE_CHANNELS : [input.channel as Channel];
  await prisma.$transaction(async (tx) => {
    for (const channel of channels) {
      await recordConsent(tx, {
        organizationId: ctx.organizationId,
        leadId: lead.id,
        channel,
        optedOut: input.optedOut,
        source: "team_member",
        actorUserId: ctx.userId,
      });
    }
  });
  return getLeadConsents(lead.id);
}

export async function getLeadConsents(leadId: string) {
  const rows = await prisma.consent.findMany({ where: { leadId } });
  return Object.fromEntries(MESSAGE_CHANNELS.map((ch) => [ch, rows.find((r) => r.channel === ch)?.status ?? null])) as Record<
    "EMAIL" | "WHATSAPP",
    "OPTED_IN" | "OPTED_OUT" | null
  >;
}

// ───────────────────────────── Unsubscribe links ─────────────────────────────

function sign(leadId: string, channel: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return hmacSha256Hex(secret, `unsubscribe:${leadId}:${channel}`).slice(0, 32);
}

/** Token for the one-click unsubscribe link in every email. Signed, so it can't be guessed for other leads. */
export function unsubscribeToken(leadId: string, channel: Channel = "EMAIL") {
  return `${leadId}.${channel}.${sign(leadId, channel)}`;
}

function parseToken(token: string) {
  const [leadId, channel, sig] = token.split(".");
  if (!leadId || !channel || !sig || !MESSAGE_CHANNELS.includes(channel as Channel)) return null;
  if (!safeEqual(sig, sign(leadId, channel))) return null;
  return { leadId, channel: channel as Channel };
}

export async function describeUnsubscribe(token: string) {
  const parsed = parseToken(token);
  if (!parsed) throw Errors.notFound("Link");
  const lead = await prisma.lead.findUnique({ where: { id: parsed.leadId }, include: { organization: { select: { name: true } } } });
  if (!lead) throw Errors.notFound("Link");
  return {
    businessName: lead.organization.name,
    channel: parsed.channel,
    optedOut: (await consentStatus(prisma, lead.id, parsed.channel)) === "OPTED_OUT",
  };
}

export async function unsubscribeByToken(token: string, optedOut = true) {
  const parsed = parseToken(token);
  if (!parsed) throw Errors.notFound("Link");
  const lead = await prisma.lead.findUnique({ where: { id: parsed.leadId } });
  if (!lead) throw Errors.notFound("Link");
  await prisma.$transaction((tx) =>
    recordConsent(tx, { organizationId: lead.organizationId, leadId: lead.id, channel: parsed.channel, optedOut, source: "unsubscribe_link" }),
  );
  return describeUnsubscribe(token);
}
