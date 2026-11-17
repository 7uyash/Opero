import { prisma, type Prisma } from "@lfm/db";
import {
  completeFollowUpSchema,
  customerReplySchema,
  rescheduleFollowUpSchema,
  scheduleFollowUpSchema,
  type CompleteFollowUpInput,
  type CustomerReplyInput,
  type FollowUpView,
  type ScheduleFollowUpInput,
} from "@lfm/shared";
import { ASSIGNMENT_TX } from "../assignment/constants";
import { Errors } from "../errors";
import { recordActivity } from "../leads/activity";
import { applyEmployeeContact, findAccessibleLead, leadScope } from "../leads/service";
import { assertPermission, can, type OrgContext } from "../tenancy/context";
import { onCustomerReply, refreshNextFollowUp } from "./engine";
import { createId } from "./ids";
import { todayBounds } from "./working-hours";

const PENDING = ["SCHEDULED", "DUE", "IN_PROGRESS"] as const;

/** Loads a task the actor may act on (via access to its lead). */
async function findAccessibleTask(ctx: OrgContext, taskId: string) {
  const task = await prisma.followUpTask.findFirst({
    where: { id: taskId, organizationId: ctx.organizationId, lead: leadScope(ctx) },
  });
  if (!task) throw Errors.notFound("Follow-up");
  return task;
}

/**
 * Employee marks a follow-up as done. When they actually reached the customer this also records
 * the contact, which recalculates the remaining sequence from now.
 */
export async function completeFollowUp(ctx: OrgContext, taskId: string, raw: CompleteFollowUpInput) {
  assertPermission(ctx, "followups:manage");
  const input = completeFollowUpSchema.parse(raw);
  const task = await findAccessibleTask(ctx, taskId);
  if (!PENDING.includes(task.status as (typeof PENDING)[number])) {
    throw Errors.conflict("This follow-up is already closed.");
  }
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.followUpTask.updateMany({
      where: { id: task.id, status: { in: [...PENDING] } },
      data: { status: "COMPLETED", completedAt: new Date(), completedById: ctx.memberId, note: input.note ?? null },
    });
    if (claimed.count !== 1) throw Errors.conflict("This follow-up was just closed by someone else.");
    await recordActivity(tx, {
      organizationId: ctx.organizationId,
      leadId: task.leadId,
      type: "FOLLOW_UP_COMPLETED",
      actorType: "USER",
      actorUserId: ctx.userId,
      payload: { title: task.title, note: input.note ?? null, contacted: input.contacted },
    });
    const lead = await tx.lead.findUniqueOrThrow({ where: { id: task.leadId } });
    if (input.contacted) {
      await applyEmployeeContact(tx, ctx, lead, { channel: input.channel, note: input.note, awaitingCustomer: input.awaitingCustomer });
    } else {
      await refreshNextFollowUp(tx, lead.id);
    }
    return tx.followUpTask.findUniqueOrThrow({ where: { id: task.id } });
  }, ASSIGNMENT_TX);
}

/** Employee schedules a one-off follow-up ("call back Thursday at 3"). */
export async function scheduleManualFollowUp(ctx: OrgContext, leadId: string, raw: ScheduleFollowUpInput) {
  assertPermission(ctx, "followups:manage");
  const input = scheduleFollowUpSchema.parse(raw);
  const lead = await findAccessibleLead(ctx, leadId);
  if (lead.status === "CONVERTED" || lead.status === "LOST") throw Errors.validation("Reopen this lead before scheduling a follow-up.");
  const dueAt = new Date(input.dueAt);
  if (dueAt.getTime() < Date.now() - 60_000) throw Errors.validation("Choose a time in the future.", { dueAt: "In the past" });

  return prisma.$transaction(async (tx) => {
    const task = await tx.followUpTask.create({
      data: {
        organizationId: ctx.organizationId,
        leadId: lead.id,
        sequenceRunId: `manual_${createId()}`,
        stepIndex: 0,
        kind: "EMPLOYEE_REMINDER",
        status: lead.status === "ON_HOLD" ? "PAUSED" : "SCHEDULED",
        dueAt,
        title: input.title || "Follow up",
        note: input.note ?? null,
      },
    });
    await recordActivity(tx, {
      organizationId: ctx.organizationId,
      leadId: lead.id,
      type: "FOLLOW_UP_SCHEDULED",
      actorType: "USER",
      actorUserId: ctx.userId,
      payload: { manual: true, title: task.title, nextDueAt: dueAt.toISOString(), note: input.note ?? null },
    });
    await refreshNextFollowUp(tx, lead.id);
    return task;
  });
}

export async function rescheduleFollowUp(ctx: OrgContext, taskId: string, raw: { dueAt: string }) {
  assertPermission(ctx, "followups:manage");
  const { dueAt } = rescheduleFollowUpSchema.parse(raw);
  const task = await findAccessibleTask(ctx, taskId);
  if (!PENDING.includes(task.status as (typeof PENDING)[number])) throw Errors.conflict("Only open follow-ups can be rescheduled.");
  const at = new Date(dueAt);
  if (at.getTime() < Date.now() - 60_000) throw Errors.validation("Choose a time in the future.", { dueAt: "In the past" });
  return prisma.$transaction(async (tx) => {
    const updated = await tx.followUpTask.update({
      where: { id: task.id },
      data: { dueAt: at, status: "SCHEDULED", overdueNotifiedAt: null, statusReason: "Rescheduled" },
    });
    await recordActivity(tx, {
      organizationId: ctx.organizationId,
      leadId: task.leadId,
      type: "FOLLOW_UP_SCHEDULED",
      actorType: "USER",
      actorUserId: ctx.userId,
      payload: { rescheduled: true, title: task.title, nextDueAt: at.toISOString() },
    });
    await refreshNextFollowUp(tx, task.leadId);
    return updated;
  });
}

export async function skipFollowUp(ctx: OrgContext, taskId: string, reason?: string) {
  assertPermission(ctx, "followups:manage");
  const task = await findAccessibleTask(ctx, taskId);
  return prisma.$transaction(async (tx) => {
    const res = await tx.followUpTask.updateMany({
      where: { id: task.id, status: { in: [...PENDING] } },
      data: { status: "SKIPPED", statusReason: reason || "Skipped by team member", completedById: ctx.memberId, completedAt: new Date() },
    });
    if (res.count !== 1) throw Errors.conflict("This follow-up is already closed.");
    await recordActivity(tx, {
      organizationId: ctx.organizationId,
      leadId: task.leadId,
      type: "FOLLOW_UP_SKIPPED",
      actorType: "USER",
      actorUserId: ctx.userId,
      payload: { title: task.title, reason: reason ?? null },
    });
    await refreshNextFollowUp(tx, task.leadId);
  });
}

/** An employee records that the customer got back to them outside the app (e.g. phoned in). */
export async function recordCustomerReply(ctx: OrgContext, leadId: string, raw: CustomerReplyInput) {
  assertPermission(ctx, "leads:update");
  const input = customerReplySchema.parse(raw);
  const lead = await findAccessibleLead(ctx, leadId);
  return prisma.$transaction(
    (tx) => onCustomerReply(tx, lead, { at: new Date(), channel: input.channel, preview: input.note, recordedByUserId: ctx.userId }),
    ASSIGNMENT_TX,
  );
}

// ───────────────────────────── Views ─────────────────────────────

const taskInclude = {
  lead: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      status: true,
      subject: true,
      assignedMember: { select: { id: true, user: { select: { name: true } } } },
    },
  },
} as const;

export async function listLeadFollowUps(ctx: OrgContext, leadId: string) {
  const lead = await findAccessibleLead(ctx, leadId);
  return prisma.followUpTask.findMany({
    where: { leadId: lead.id, organizationId: ctx.organizationId },
    orderBy: [{ dueAt: "desc" }],
    take: 50,
    include: { completedBy: { select: { user: { select: { name: true } } } } },
  });
}

/**
 * Follow-up Center. Overdue = open reminders from before today; due today = today's (business
 * timezone); upcoming = later. Lead-based views list leads waiting on someone.
 */
export async function listFollowUpCenter(ctx: OrgContext, view: FollowUpView, opts: { assignee?: string; limit?: number } = {}) {
  assertPermission(ctx, "leads:view_assigned");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
  const { start, end } = todayBounds(org.timezone);
  const limit = Math.min(opts.limit ?? 100, 200);
  const scope = leadScope(ctx);
  const leadWhere: Prisma.LeadWhereInput =
    opts.assignee && can(ctx, "leads:view_all")
      ? { ...scope, assignedMemberId: opts.assignee === "unassigned" ? null : opts.assignee }
      : scope;

  const taskWhere = (dueAt: Prisma.DateTimeFilter): Prisma.FollowUpTaskWhereInput => ({
    organizationId: ctx.organizationId,
    status: { in: [...PENDING] },
    dueAt,
    lead: leadWhere,
  });

  const counts = await Promise.all([
    prisma.followUpTask.count({ where: taskWhere({ gte: start, lte: end }) }),
    prisma.followUpTask.count({ where: taskWhere({ lt: start }) }),
    prisma.followUpTask.count({ where: taskWhere({ gt: end }) }),
    prisma.lead.count({ where: { ...leadWhere, status: "WAITING_FOR_CUSTOMER" } }),
    prisma.lead.count({ where: awaitingEmployeeWhere(leadWhere) }),
    prisma.message.count({ where: { organizationId: ctx.organizationId, status: "FAILED", lead: leadWhere } }),
  ]);
  const summary: Record<FollowUpView, number> = {
    due_today: counts[0],
    overdue: counts[1],
    upcoming: counts[2],
    waiting: counts[3],
    awaiting_employee: counts[4],
    failed: counts[5],
  };

  if (view === "due_today" || view === "overdue" || view === "upcoming") {
    const dueAt = view === "due_today" ? { gte: start, lte: end } : view === "overdue" ? { lt: start } : { gt: end };
    const tasks = await prisma.followUpTask.findMany({
      where: taskWhere(dueAt),
      orderBy: { dueAt: "asc" },
      take: limit,
      include: taskInclude,
    });
    return { view, summary, timezone: org.timezone, tasks, leads: [], messages: [] };
  }
  if (view === "failed") {
    const messages = await prisma.message.findMany({
      where: { organizationId: ctx.organizationId, status: "FAILED", lead: leadWhere },
      orderBy: { failedAt: "desc" },
      take: limit,
      include: { lead: taskInclude.lead },
    });
    return { view, summary, timezone: org.timezone, tasks: [], leads: [], messages };
  }
  const leads = await prisma.lead.findMany({
    where: view === "waiting" ? { ...leadWhere, status: "WAITING_FOR_CUSTOMER" } : awaitingEmployeeWhere(leadWhere),
    orderBy: view === "waiting" ? { lastContactAt: "asc" } : { updatedAt: "asc" },
    take: limit,
    include: { assignedMember: { select: { id: true, user: { select: { name: true } } } } },
  });
  return { view, summary, timezone: org.timezone, tasks: [], leads, messages: [] };
}

/** Leads where the ball is in the team's court: never contacted, or a reminder/reply is waiting. */
function awaitingEmployeeWhere(scope: Prisma.LeadWhereInput): Prisma.LeadWhereInput {
  return { ...scope, status: { in: ["NEW", "ASSIGNED", "FOLLOW_UP_DUE"] } };
}
