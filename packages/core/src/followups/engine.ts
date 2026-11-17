import { createId } from "./ids";
import { prisma, type Db, type FollowUpRule, type FollowUpTask, type Lead, type Tx } from "@lfm/db";
import { DEFAULT_FOLLOW_UP_STEPS, updateFollowUpRulesSchema, type UpdateFollowUpRulesInput } from "@lfm/shared";
import { audit } from "../audit/audit";
import { logExecution } from "../automation/executions";
import { recordActivity } from "../leads/activity";
import { queueFollowUpMessage } from "../messaging/outbox";
import { managerMemberIds, notify } from "../notifications/service";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { calendarFromOrg, computeDueAt, type BusinessCalendar } from "./working-hours";

/**
 * Follow-up engine (PLAN §5.3, ADR-006).
 *
 * The database is the source of truth: each step of a lead's sequence is a follow_up_tasks row
 * with a due time. The worker's sweep turns SCHEDULED rows whose time has come into DUE reminders.
 * Every lifecycle event (new lead, employee contact, customer reply, status change) goes through
 * one of the `on…` functions below, which cancel/pause what no longer applies and recalculate.
 *
 * Runs: tasks created together share a sequenceRunId. Prefixes tell them apart:
 *   seq_…    automatic sequence steps (stepIndex = rule step)
 *   reply_…  "customer replied" reminder for the employee
 *   manual_… follow-ups an employee scheduled by hand
 */

const PENDING = ["SCHEDULED", "DUE", "IN_PROGRESS"] as const;
const CLOSED = ["CONVERTED", "LOST"];
/** Statuses that move to FOLLOW_UP_DUE when a reminder becomes due. */
const ADVANCE_TO_DUE = ["ASSIGNED", "CONTACTED", "WAITING_FOR_CUSTOMER"];

// ───────────────────────────── Rules ─────────────────────────────

/** Active + inactive rules in order; creates the default 24h / 3d / 7d / 14d sequence on first use. */
export async function getFollowUpRules(organizationId: string, db: Db = prisma): Promise<FollowUpRule[]> {
  const rules = await db.followUpRule.findMany({ where: { organizationId }, orderBy: { stepIndex: "asc" } });
  if (rules.length) return rules;
  await db.followUpRule.createMany({
    data: DEFAULT_FOLLOW_UP_STEPS.map((s, i) => ({
      organizationId,
      stepIndex: i + 1,
      name: s.name,
      delayMinutes: s.delayMinutes,
      // Spec default: follow-ups go by email and WhatsApp (each only once connected and approved).
      channels: ["EMAIL", "WHATSAPP"],
      templateKey: `FOLLOW_UP_${i + 1}`,
    })),
    skipDuplicates: true,
  });
  return db.followUpRule.findMany({ where: { organizationId }, orderBy: { stepIndex: "asc" } });
}

/** Replaces the sequence. Applies to sequences started or recalculated from now on. */
export async function updateFollowUpRules(ctx: OrgContext, raw: UpdateFollowUpRulesInput, ip?: string | null) {
  assertPermission(ctx, "automation:configure");
  const { steps } = updateFollowUpRulesSchema.parse(raw);
  const rules = await prisma.$transaction(async (tx) => {
    const existing = await getFollowUpRules(ctx.organizationId, tx);
    const byStep = new Map(existing.map((r) => [r.stepIndex, r]));
    for (const [i, s] of steps.entries()) {
      const stepIndex = i + 1;
      const prev = byStep.get(stepIndex);
      // Keep channel/template settings (configured in messaging) when a step is edited.
      await tx.followUpRule.upsert({
        where: { organizationId_stepIndex: { organizationId: ctx.organizationId, stepIndex } },
        update: { name: s.name, delayMinutes: s.delayMinutes, active: s.active },
        create: {
          organizationId: ctx.organizationId,
          stepIndex,
          name: s.name,
          delayMinutes: s.delayMinutes,
          active: s.active,
          channels: prev?.channels ?? ["EMAIL", "WHATSAPP"],
          templateKey: `FOLLOW_UP_${stepIndex}`,
        },
      });
    }
    await tx.followUpRule.deleteMany({ where: { organizationId: ctx.organizationId, stepIndex: { gt: steps.length } } });
    return tx.followUpRule.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { stepIndex: "asc" } });
  });
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "automation.followup_rules_updated",
    targetType: "automation",
    ip,
    metadata: { steps: steps.map((s) => ({ name: s.name, delayMinutes: s.delayMinutes, active: s.active })) },
  });
  return rules;
}

// ───────────────────────────── Helpers ─────────────────────────────

async function loadCalendar(db: Db, organizationId: string): Promise<BusinessCalendar> {
  const org = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { timezone: true, workingHours: true, holidays: true },
  });
  return calendarFromOrg(org);
}

/** Keeps leads.nextFollowUpAt equal to the earliest pending task (drives lists and the dashboard). */
export async function refreshNextFollowUp(db: Db, leadId: string): Promise<Date | null> {
  const next = await db.followUpTask.findFirst({
    where: { leadId, status: { in: [...PENDING] } },
    orderBy: { dueAt: "asc" },
    select: { dueAt: true },
  });
  await db.lead.update({ where: { id: leadId }, data: { nextFollowUpAt: next?.dueAt ?? null } });
  return next?.dueAt ?? null;
}

async function endPending(
  db: Db,
  leadId: string,
  status: "CANCELLED" | "PAUSED" | "SKIPPED",
  reason: string,
  opts: { includeManual?: boolean; fromStatuses?: readonly string[] } = {},
): Promise<number> {
  const res = await db.followUpTask.updateMany({
    where: {
      leadId,
      status: { in: [...(opts.fromStatuses ?? PENDING)] as FollowUpTask["status"][] },
      ...(opts.includeManual ? {} : { NOT: { sequenceRunId: { startsWith: "manual_" } } }),
    },
    data: { status, statusReason: reason },
  });
  return res.count;
}

async function notifyOwner(db: Db, lead: Lead, n: { event: "followUpDue" | "followUpOverdue" | "customerReplied"; title: string; body?: string }) {
  const memberIds = lead.assignedMemberId ? [lead.assignedMemberId] : await managerMemberIds(db, lead.organizationId);
  await notify(db, { organizationId: lead.organizationId, memberIds, leadId: lead.id, ...n });
}

// ───────────────────────────── Scheduling ─────────────────────────────

/**
 * Replaces the lead's automatic sequence with a fresh run covering steps `fromStep…N`.
 * Step k is due `delay[k] − delay[fromStep−1]` after the anchor (delay[0] = 0), moved into
 * working hours. Returns the number of steps scheduled.
 */
export async function scheduleSequence(
  tx: Tx,
  lead: Lead,
  args: { anchor: Date; fromStep: number; reason: string; actorUserId?: string | null },
): Promise<number> {
  await endPending(tx, lead.id, "CANCELLED", `Replaced: ${args.reason}`);
  const [rules, cal] = await Promise.all([getFollowUpRules(lead.organizationId, tx), loadCalendar(tx, lead.organizationId)]);
  const active = rules.filter((r) => r.active);
  const base = active.find((r) => r.stepIndex === args.fromStep - 1)?.delayMinutes ?? (args.fromStep <= 1 ? 0 : null);
  // If the previous step was removed from the rules, measure from the closest earlier step.
  const baseDelay = base ?? active.filter((r) => r.stepIndex < args.fromStep).at(-1)?.delayMinutes ?? 0;
  const steps = active.filter((r) => r.stepIndex >= args.fromStep);
  const runId = `seq_${createId()}`;

  if (steps.length === 0) {
    await refreshNextFollowUp(tx, lead.id);
    await recordActivity(tx, {
      organizationId: lead.organizationId,
      leadId: lead.id,
      type: "FOLLOW_UPS_STOPPED",
      actorType: "SYSTEM",
      payload: { reason: "All follow-up steps have been used" },
    });
    return 0;
  }

  const total = active.length;
  await tx.followUpTask.createMany({
    data: steps.map((r) => ({
      organizationId: lead.organizationId,
      leadId: lead.id,
      ruleId: r.id,
      sequenceRunId: runId,
      stepIndex: r.stepIndex,
      kind: "EMPLOYEE_REMINDER" as const,
      status: "SCHEDULED" as const,
      dueAt: computeDueAt(args.anchor, r.delayMinutes - baseDelay, cal),
      title: `${r.name} (${active.indexOf(r) + 1} of ${total})`,
    })),
  });
  const next = await refreshNextFollowUp(tx, lead.id);
  await recordActivity(tx, {
    organizationId: lead.organizationId,
    leadId: lead.id,
    type: "FOLLOW_UP_SCHEDULED",
    actorType: args.actorUserId ? "USER" : "SYSTEM",
    actorUserId: args.actorUserId,
    payload: { count: steps.length, fromStep: args.fromStep, nextDueAt: next?.toISOString() ?? null, reason: args.reason },
  });
  await logExecution(tx, {
    organizationId: lead.organizationId,
    eventType: "followup.scheduled",
    status: "SUCCESS",
    leadId: lead.id,
    output: { steps: steps.length, fromStep: args.fromStep, nextDueAt: next?.toISOString() ?? null },
  });
  return steps.length;
}

// ───────────────────────────── Lifecycle hooks ─────────────────────────────

/** A brand-new lead starts the sequence from the moment it arrived. */
export async function onLeadCreated(tx: Tx, lead: Lead) {
  if (CLOSED.includes(lead.status)) return;
  await scheduleSequence(tx, lead, { anchor: lead.createdAt, fromStep: 1, reason: "New lead" });
}

/**
 * The employee contacted the customer: the sequence continues from where it was, re-timed from
 * this contact (so the next reminder isn't due five minutes after a call).
 */
export async function onEmployeeContact(tx: Tx, lead: Lead, args: { at: Date; actorUserId?: string | null }) {
  if (CLOSED.includes(lead.status) || lead.status === "ON_HOLD") return;
  // A "customer replied" reminder is answered by this contact.
  await tx.followUpTask.updateMany({
    where: { leadId: lead.id, sequenceRunId: { startsWith: "reply_" }, status: { in: [...PENDING] } },
    data: { status: "COMPLETED", completedAt: args.at, statusReason: "Employee contacted the customer" },
  });
  await scheduleSequence(tx, lead, {
    anchor: args.at,
    fromStep: lead.followUpStep + 1,
    reason: "Employee contacted the customer",
    actorUserId: args.actorUserId,
  });
}

/**
 * The customer got back in touch (reply, new message, repeat inquiry). Automatic follow-ups pause,
 * the assignee gets an immediate reminder, and the sequence restarts after their next contact.
 */
export async function onCustomerReply(
  tx: Tx,
  lead: Lead,
  args: { at: Date; channel: string; preview?: string | null; recordedByUserId?: string | null },
): Promise<Lead> {
  const paused = await endPending(tx, lead.id, "CANCELLED", "Customer replied");
  const status = CLOSED.includes(lead.status) || ["QUALIFIED", "ON_HOLD", "NEW"].includes(lead.status) ? lead.status : "FOLLOW_UP_DUE";
  const updated = await tx.lead.update({
    where: { id: lead.id },
    data: { lastCustomerReplyAt: args.at, followUpStep: 0, status },
  });
  await recordActivity(tx, {
    organizationId: lead.organizationId,
    leadId: lead.id,
    type: "CUSTOMER_REPLIED",
    actorType: args.recordedByUserId ? "USER" : "CUSTOMER",
    actorUserId: args.recordedByUserId,
    occurredAt: args.at,
    payload: { channel: args.channel, preview: args.preview?.slice(0, 500) ?? null },
  });
  if (paused) {
    await recordActivity(tx, {
      organizationId: lead.organizationId,
      leadId: lead.id,
      type: "FOLLOW_UPS_PAUSED",
      actorType: "SYSTEM",
      payload: { reason: "Customer replied", cancelled: paused },
    });
  }
  if (status !== lead.status) {
    await recordActivity(tx, {
      organizationId: lead.organizationId,
      leadId: lead.id,
      type: "STATUS_CHANGED",
      actorType: "SYSTEM",
      payload: { from: lead.status, to: status, reason: "Customer replied" },
    });
  }
  if (!CLOSED.includes(lead.status)) {
    await tx.followUpTask.create({
      data: {
        organizationId: lead.organizationId,
        leadId: lead.id,
        sequenceRunId: `reply_${createId()}`,
        stepIndex: 0,
        kind: "EMPLOYEE_REMINDER",
        status: "DUE",
        dueAt: args.at,
        title: "Customer replied — get back to them",
      },
    });
  }
  await refreshNextFollowUp(tx, lead.id);
  await notifyOwner(tx, updated, {
    event: "customerReplied",
    title: `${lead.name} replied`,
    body: args.preview?.slice(0, 140) ?? undefined,
  });
  await logExecution(tx, {
    organizationId: lead.organizationId,
    eventType: "followup.paused_customer_replied",
    status: "SUCCESS",
    leadId: lead.id,
    output: { cancelledTasks: paused },
  });
  return tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
}

/** Stop / pause / resume rules for status changes. Call after the status has been written. */
export async function onStatusChanged(tx: Tx, before: Lead, after: Lead, actorUserId?: string | null) {
  const wasClosed = CLOSED.includes(before.status);
  const isClosed = CLOSED.includes(after.status);

  if (isClosed && !wasClosed) {
    const n = await endPending(tx, after.id, "CANCELLED", after.status === "CONVERTED" ? "Lead converted" : "Lead lost", { includeManual: true });
    await endPending(tx, after.id, "CANCELLED", "Lead closed", { includeManual: true, fromStatuses: ["PAUSED"] });
    await refreshNextFollowUp(tx, after.id);
    if (n) {
      await recordActivity(tx, {
        organizationId: after.organizationId,
        leadId: after.id,
        type: "FOLLOW_UPS_STOPPED",
        actorType: "SYSTEM",
        payload: { reason: after.status === "CONVERTED" ? "Lead converted" : "Lead marked as lost", cancelled: n },
      });
    }
    return;
  }
  if (after.status === "ON_HOLD" && before.status !== "ON_HOLD") {
    const n = await endPending(tx, after.id, "PAUSED", "Lead on hold", { includeManual: true });
    await refreshNextFollowUp(tx, after.id);
    if (n) {
      await recordActivity(tx, {
        organizationId: after.organizationId,
        leadId: after.id,
        type: "FOLLOW_UPS_PAUSED",
        actorType: "SYSTEM",
        payload: { reason: "Lead put on hold", paused: n },
      });
    }
    return;
  }
  if (wasClosed && !isClosed) {
    // Reopened: a fresh sequence from today.
    const lead = await tx.lead.update({ where: { id: after.id }, data: { followUpStep: 0 } });
    if (lead.status !== "ON_HOLD") await scheduleSequence(tx, lead, { anchor: new Date(), fromStep: 1, reason: "Lead reopened", actorUserId });
    return;
  }
  if (before.status === "ON_HOLD" && after.status !== "ON_HOLD") {
    await endPending(tx, after.id, "CANCELLED", "Resumed from hold", { includeManual: false, fromStatuses: ["PAUSED"] });
    // Manual follow-ups come back as they were.
    await tx.followUpTask.updateMany({
      where: { leadId: after.id, status: "PAUSED", sequenceRunId: { startsWith: "manual_" } },
      data: { status: "SCHEDULED", statusReason: null },
    });
    await scheduleSequence(tx, after, { anchor: new Date(), fromStep: after.followUpStep + 1, reason: "Lead taken off hold", actorUserId });
  }
}

// ───────────────────────────── Processing (worker) ─────────────────────────────

/** Tasks whose time has come. The sweep enqueues one processing job per task. */
export async function findDueTasks(now = new Date(), limit = 200): Promise<{ id: string; dueAt: Date }[]> {
  const rows = await prisma.followUpTask.findMany({
    where: { status: "SCHEDULED", dueAt: { lte: now } },
    orderBy: { dueAt: "asc" },
    take: limit,
    select: { id: true, dueAt: true },
  });
  return rows;
}

export async function findDueTaskIds(now = new Date(), limit = 200): Promise<string[]> {
  return (await findDueTasks(now, limit)).map((t) => t.id);
}

export type ProcessResult = "due" | "skipped" | "not_due" | "already_handled" | "cancelled" | "paused";

/**
 * Turns one SCHEDULED task into a DUE reminder. Idempotent: the conditional SCHEDULED → DUE
 * update means a duplicate job, a retry or two workers racing can only fire it once.
 */
export async function processDueTask(taskId: string, now = new Date(), jobId?: string): Promise<ProcessResult> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.followUpTask.updateMany({
      where: { id: taskId, status: "SCHEDULED", dueAt: { lte: now } },
      data: { status: "DUE" },
    });
    if (claimed.count !== 1) {
      const t = await tx.followUpTask.findUnique({ where: { id: taskId }, select: { status: true } });
      return !t || t.status !== "SCHEDULED" ? "already_handled" : "not_due";
    }
    const task = await tx.followUpTask.findUniqueOrThrow({ where: { id: taskId } });
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: task.leadId } });

    // Re-check stop conditions at fire time — the lead may have changed since scheduling.
    if (CLOSED.includes(lead.status)) {
      await tx.followUpTask.update({ where: { id: task.id }, data: { status: "CANCELLED", statusReason: "Lead closed" } });
      await refreshNextFollowUp(tx, lead.id);
      return "cancelled";
    }
    if (lead.status === "ON_HOLD") {
      await tx.followUpTask.update({ where: { id: task.id }, data: { status: "PAUSED", statusReason: "Lead on hold" } });
      await refreshNextFollowUp(tx, lead.id);
      return "paused";
    }

    const isSequenceStep = task.sequenceRunId.startsWith("seq_");
    if (isSequenceStep) {
      // An unanswered earlier reminder is superseded by this one so they don't pile up.
      await tx.followUpTask.updateMany({
        where: { leadId: lead.id, status: "DUE", id: { not: task.id }, sequenceRunId: { startsWith: "seq_" } },
        data: { status: "SKIPPED", statusReason: "A later reminder became due" },
      });
    }

    const data: { followUpStep?: number; status?: Lead["status"] } = {};
    if (isSequenceStep && task.stepIndex > lead.followUpStep) data.followUpStep = task.stepIndex;
    if (ADVANCE_TO_DUE.includes(lead.status)) data.status = "FOLLOW_UP_DUE";
    if (Object.keys(data).length) await tx.lead.update({ where: { id: lead.id }, data });
    if (data.status) {
      await recordActivity(tx, {
        organizationId: lead.organizationId,
        leadId: lead.id,
        type: "STATUS_CHANGED",
        actorType: "SYSTEM",
        payload: { from: lead.status, to: data.status, reason: task.title ?? "Follow-up due" },
      });
    }
    await refreshNextFollowUp(tx, lead.id);
    const messages = await queueFollowUpMessage(tx, await tx.lead.findUniqueOrThrow({ where: { id: lead.id } }), task);
    await notifyOwner(tx, lead, {
      event: "followUpDue",
      title: `Follow-up due: ${lead.name}`,
      body: task.title ?? undefined,
    });
    await logExecution(tx, {
      organizationId: lead.organizationId,
      eventType: "followup.reminder_due",
      status: "SUCCESS",
      leadId: lead.id,
      followUpTaskId: task.id,
      jobId,
      output: { step: task.stepIndex, title: task.title, messagesQueued: messages.map((m) => m.channel) },
    });
    return "due";
  });
}

/** Tells assignees once about reminders left unanswered for a day. Returns how many were sent. */
export async function notifyOverdueFollowUps(now = new Date(), overdueAfterMs = 24 * 60 * 60 * 1000): Promise<number> {
  const tasks = await prisma.followUpTask.findMany({
    where: { status: "DUE", overdueNotifiedAt: null, dueAt: { lt: new Date(now.getTime() - overdueAfterMs) } },
    include: { lead: true },
    take: 200,
  });
  let sent = 0;
  for (const t of tasks) {
    const claimed = await prisma.followUpTask.updateMany({ where: { id: t.id, overdueNotifiedAt: null }, data: { overdueNotifiedAt: now } });
    if (claimed.count !== 1) continue;
    await notifyOwner(prisma, t.lead, { event: "followUpOverdue", title: `Overdue follow-up: ${t.lead.name}`, body: t.title ?? undefined });
    sent++;
  }
  return sent;
}
