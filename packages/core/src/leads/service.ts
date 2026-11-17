import { prisma, type Db, type Lead, type Prisma, type Tx } from "@lfm/db";
import {
  addNoteSchema,
  allowedNextStatuses,
  assignLeadSchema,
  changeStatusSchema,
  createLeadSchema,
  LEAD_STATUS_LABELS,
  logInteractionSchema,
  updateLeadSchema,
  type ChangeStatusInput,
  type CreateLeadInput,
  type LeadStatus,
  type LogInteractionInput,
  type SourceType,
  type UpdateLeadInput,
} from "@lfm/shared";
import { ASSIGNMENT_TX } from "../assignment/constants";
import { autoAssignLead } from "../assignment/round-robin";
import { getLeadAutomationSettings } from "../automation/settings";
import { AppError, Errors } from "../errors";
import { onCustomerReply, onEmployeeContact, onLeadCreated, onStatusChanged } from "../followups/engine";
import { queueAcknowledgement } from "../messaging/outbox";
import { assertPermission, can, type OrgContext } from "../tenancy/context";
import { recordActivity } from "./activity";
import { normalizeContact, normalizeEmail, normalizePhone, type NormalizedContact } from "./normalize";

// ───────────────────────────── Access helpers ─────────────────────────────

/** Salespeople only see leads assigned to them; everyone else sees all leads of the organization. */
export function leadScope(ctx: OrgContext): Prisma.LeadWhereInput {
  return can(ctx, "leads:view_all")
    ? { organizationId: ctx.organizationId }
    : { organizationId: ctx.organizationId, assignedMemberId: ctx.memberId };
}

/** Loads a lead the actor may access; anything else is reported as "not found" (no existence leak). */
export async function findAccessibleLead(ctx: OrgContext, leadId: string, db: Db = prisma): Promise<Lead> {
  const lead = await db.lead.findFirst({ where: { id: leadId, ...leadScope(ctx) } });
  if (!lead) throw Errors.notFound("Lead");
  return lead;
}

async function activeMemberOrThrow(db: Db, organizationId: string, memberId: string) {
  const m = await db.organizationMember.findFirst({
    where: { id: memberId, organizationId, status: "ACTIVE" },
    include: { user: { select: { name: true } } },
  });
  if (!m) throw Errors.validation("Choose an active team member.", { assignedMemberId: "Not an active team member" });
  return m;
}

// ───────────────────────────── Duplicate detection ─────────────────────────────

export type DuplicateMatch = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: LeadStatus;
  assignedTo: string | null;
  matchedOn: ("email" | "phone")[];
  createdAt: Date;
};

/** Finds the most recent open lead in the organization with the same normalized email or phone. */
export async function findDuplicateLead(
  db: Db,
  organizationId: string,
  contact: Pick<NormalizedContact, "emailNormalized" | "phoneE164">,
  excludeLeadId?: string,
): Promise<DuplicateMatch | null> {
  const or: Prisma.LeadWhereInput[] = [];
  if (contact.emailNormalized) or.push({ emailNormalized: contact.emailNormalized });
  if (contact.phoneE164) or.push({ phoneE164: contact.phoneE164 });
  if (or.length === 0) return null;
  const match = await db.lead.findFirst({
    where: {
      organizationId,
      OR: or,
      status: { notIn: ["CONVERTED", "LOST"] },
      duplicateOfId: null,
      ...(excludeLeadId ? { id: { not: excludeLeadId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: { assignedMember: { include: { user: { select: { name: true } } } } },
  });
  if (!match) return null;
  const matchedOn: ("email" | "phone")[] = [];
  if (contact.emailNormalized && match.emailNormalized === contact.emailNormalized) matchedOn.push("email");
  if (contact.phoneE164 && match.phoneE164 === contact.phoneE164) matchedOn.push("phone");
  return {
    id: match.id,
    name: match.name,
    email: match.email,
    phone: match.phone,
    status: match.status,
    assignedTo: match.assignedMember?.user.name ?? null,
    matchedOn,
    createdAt: match.createdAt,
  };
}

export class DuplicateLeadError extends AppError {
  constructor(public readonly duplicate: DuplicateMatch) {
    super("DUPLICATE_FOUND", `A lead for ${duplicate.name} already exists.`, 409, undefined, { duplicate });
  }
}

// ───────────────────────────── Intake ─────────────────────────────

export type IntakeSource = {
  type: SourceType;
  sourceId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export type IntakeResult = { lead: Lead; outcome: "created" | "merged" | "flagged_duplicate" };

/**
 * Core intake used by every source. Runs in one transaction: duplicate check → create or merge →
 * timeline entries. `assign` decides the assignee for new leads (manual choice now; round-robin
 * plugs in here in Task 5).
 */
export async function intakeLead(
  tx: Tx,
  args: {
    organizationId: string;
    contact: NormalizedContact;
    source: IntakeSource;
    priority?: Lead["priority"];
    onDuplicate: "merge" | "create";
    actor: { type: "USER" | "SYSTEM"; userId?: string | null };
    assign: (lead: Lead) => Promise<Lead>;
    /** Called with the new or merged lead before automation (acknowledgement / reply rules) runs. */
    afterCreate?: (lead: Lead) => Promise<void>;
  },
): Promise<IntakeResult> {
  const { organizationId, contact, source, actor } = args;
  const duplicate = await findDuplicateLead(tx, organizationId, contact);

  if (duplicate && args.onDuplicate === "merge") {
    const existing = await tx.lead.findUniqueOrThrow({ where: { id: duplicate.id } });
    // Fill gaps only; never overwrite what the team already has.
    const lead = await tx.lead.update({
      where: { id: existing.id },
      data: {
        email: existing.email ?? contact.email,
        emailNormalized: existing.emailNormalized ?? contact.emailNormalized,
        phone: existing.phone ?? contact.phone,
        phoneE164: existing.phoneE164 ?? contact.phoneE164,
        company: existing.company ?? contact.company,
      },
    });
    await recordActivity(tx, {
      organizationId,
      leadId: lead.id,
      type: "DUPLICATE_MERGED",
      actorType: actor.type,
      actorUserId: actor.userId,
      payload: {
        source: source.type,
        subject: contact.subject,
        inquiry: contact.inquiry,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
      },
    });
    if (args.afterCreate) await args.afterCreate(lead);
    // The customer reached out again: same handling as a reply (pause automatic follow-ups, alert the owner).
    const replied = await onCustomerReply(tx, lead, {
      at: new Date(),
      channel: source.type,
      preview: [contact.subject, contact.inquiry].filter(Boolean).join(" — ") || "Contacted you again",
    });
    return { lead: replied, outcome: "merged" };
  }

  const created = await tx.lead.create({
    data: {
      organizationId,
      ...contact,
      sourceType: source.type,
      sourceId: source.sourceId ?? null,
      sourceMetadata: source.metadata ?? {},
      priority: args.priority ?? "NORMAL",
      status: "NEW",
      duplicateOfId: duplicate?.id ?? null,
    },
  });
  await recordActivity(tx, {
    organizationId,
    leadId: created.id,
    type: "LEAD_CREATED",
    actorType: actor.type,
    actorUserId: actor.userId,
    payload: { source: source.type, subject: contact.subject, ...(duplicate ? { possibleDuplicateOf: duplicate.id } : {}) },
  });
  const assigned = await args.assign(created);
  if (args.afterCreate) await args.afterCreate(assigned);
  await onLeadCreated(tx, assigned);
  await queueAcknowledgement(tx, await tx.lead.findUniqueOrThrow({ where: { id: assigned.id } }));
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: assigned.id } });
  return { lead, outcome: duplicate ? "flagged_duplicate" : "created" };
}

/** Assigns (or unassigns) a lead, recording history and a timeline entry. */
export async function applyAssignment(
  tx: Tx,
  lead: Lead,
  args: {
    memberId: string | null;
    memberName?: string | null;
    method: "ROUND_ROBIN" | "MANUAL" | "FALLBACK" | "UNASSIGNED";
    actorUserId?: string | null;
    reason?: string | null;
  },
): Promise<Lead> {
  if (lead.assignedMemberId === args.memberId) return lead;
  const previous = lead.assignedMemberId;
  // A brand-new lead becomes ASSIGNED; unassigning an ASSIGNED lead puts it back to NEW.
  let status = lead.status;
  if (args.memberId && lead.status === "NEW") status = "ASSIGNED";
  if (!args.memberId && lead.status === "ASSIGNED") status = "NEW";

  const updated = await tx.lead.update({ where: { id: lead.id }, data: { assignedMemberId: args.memberId, status } });
  await tx.assignment.create({
    data: {
      organizationId: lead.organizationId,
      leadId: lead.id,
      memberId: args.memberId,
      previousMemberId: previous,
      method: args.method,
      actorUserId: args.actorUserId ?? null,
      reason: args.reason ?? null,
    },
  });
  await recordActivity(tx, {
    organizationId: lead.organizationId,
    leadId: lead.id,
    type: !args.memberId ? "UNASSIGNED" : previous ? "REASSIGNED" : "ASSIGNED",
    actorType: args.actorUserId ? "USER" : "SYSTEM",
    actorUserId: args.actorUserId,
    payload: { memberId: args.memberId, memberName: args.memberName ?? null, previousMemberId: previous, method: args.method, reason: args.reason ?? null },
  });
  return updated;
}

/** Manual lead entry from the dashboard. */
export async function createLead(ctx: OrgContext, raw: CreateLeadInput) {
  assertPermission(ctx, "leads:create");
  const input = createLeadSchema.parse(raw);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const contact = normalizeContact(input, { defaultCountry: org.defaultCountry, strict: true });

  // Who gets the lead: an explicit choice (requires assign permission unless choosing yourself);
  // salespeople default to themselves.
  let assigneeId: string | null | undefined = input.assignedMemberId;
  if (assigneeId && assigneeId !== ctx.memberId) assertPermission(ctx, "leads:assign");
  if (assigneeId === undefined && !can(ctx, "leads:assign")) assigneeId = ctx.memberId;

  if (input.onDuplicate === "check") {
    const dup = await findDuplicateLead(prisma, ctx.organizationId, contact);
    if (dup) throw new DuplicateLeadError(dup);
  }

  const manualSource = await prisma.leadSource.upsert({
    where: { organizationId_type_label: { organizationId: ctx.organizationId, type: "MANUAL", label: "Manual entry" } },
    update: {},
    create: { organizationId: ctx.organizationId, type: "MANUAL", label: "Manual entry" },
  });

  // undefined → automatic (round-robin per settings), null → unassigned queue, id → that member.
  const settings = assigneeId === undefined ? await getLeadAutomationSettings(ctx.organizationId) : null;

  return prisma.$transaction(async (tx) => {
    const member = assigneeId ? await activeMemberOrThrow(tx, ctx.organizationId, assigneeId) : null;
    return intakeLead(tx, {
      organizationId: ctx.organizationId,
      contact,
      source: { type: "MANUAL", sourceId: manualSource.id, metadata: { createdByUserId: ctx.userId } },
      priority: input.priority,
      onDuplicate: input.onDuplicate === "merge" ? "merge" : "create",
      actor: { type: "USER", userId: ctx.userId },
      assign: async (lead) => {
        if (member) {
          return applyAssignment(tx, lead, { memberId: member.id, memberName: member.user.name, method: "MANUAL", actorUserId: ctx.userId });
        }
        if (settings) return (await autoAssignLead(tx, lead, settings)).lead;
        return lead;
      },
    });
  }, ASSIGNMENT_TX);
}

// ───────────────────────────── Updates ─────────────────────────────

export async function updateLead(ctx: OrgContext, leadId: string, raw: UpdateLeadInput) {
  assertPermission(ctx, "leads:update");
  const input = updateLeadSchema.parse(raw);
  const lead = await findAccessibleLead(ctx, leadId);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });

  const data: Prisma.LeadUpdateInput = {};
  for (const k of ["name", "company", "subject", "inquiry", "priority"] as const) {
    if (input[k] !== undefined) data[k] = input[k] ?? null;
  }
  if (input.name !== undefined && !input.name) throw Errors.validation("Enter the customer's name.", { name: "Required" });
  if (input.email !== undefined) {
    data.email = input.email;
    data.emailNormalized = normalizeEmail(input.email);
  }
  if (input.phone !== undefined) {
    if (input.phone) {
      const p = normalizePhone(input.phone, org.defaultCountry);
      if (!p.ok) throw Errors.validation("Please check the phone number.", { phone: "Enter a valid phone number" });
      data.phone = p.display;
      data.phoneE164 = p.e164;
    } else {
      data.phone = null;
      data.phoneE164 = null;
    }
  }
  const nextEmail = input.email !== undefined ? input.email : lead.email;
  const nextPhone = input.phone !== undefined ? input.phone : lead.phone;
  if (!nextEmail && !nextPhone) throw Errors.validation("Keep at least an email address or a phone number.", { email: "Required" });

  return prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({ where: { id: lead.id }, data });
    const changed = Object.keys(data).filter(
      (k) => !k.endsWith("Normalized") && k !== "phoneE164" && JSON.stringify(lead[k as keyof Lead]) !== JSON.stringify(updated[k as keyof Lead]),
    );
    if (changed.length) {
      await recordActivity(tx, {
        organizationId: ctx.organizationId,
        leadId: lead.id,
        type: "LEAD_UPDATED",
        actorType: "USER",
        actorUserId: ctx.userId,
        payload: { fields: changed },
      });
    }
    return updated;
  });
}

export async function changeLeadStatus(ctx: OrgContext, leadId: string, raw: ChangeStatusInput) {
  assertPermission(ctx, "leads:update");
  const input = changeStatusSchema.parse(raw);
  const lead = await findAccessibleLead(ctx, leadId);
  if (!allowedNextStatuses(lead.status).includes(input.status)) {
    throw Errors.validation(`This lead is "${LEAD_STATUS_LABELS[lead.status]}" and can't be changed to "${LEAD_STATUS_LABELS[input.status]}".`, {
      status: "Not allowed from the current status",
    });
  }
  const now = new Date();
  const data: Prisma.LeadUpdateInput = { status: input.status };
  if (input.status === "CONVERTED") data.convertedAt = now;
  if (input.status === "LOST") {
    data.lostAt = now;
    data.lostReason = input.reason || null;
  }
  // Reopening clears the closed markers.
  if (lead.status === "CONVERTED" || lead.status === "LOST") {
    Object.assign(data, { convertedAt: null, lostAt: null, lostReason: null });
  }

  return prisma.$transaction(async (tx) => {
    // Conditional update: if someone else changed the status meanwhile, don't overwrite it silently.
    const res = await tx.lead.updateMany({ where: { id: lead.id, status: lead.status }, data: data as Prisma.LeadUpdateManyMutationInput });
    if (res.count !== 1) throw Errors.conflict("This lead was just updated by someone else. Refresh and try again.");
    const type = input.status === "CONVERTED" ? "CONVERTED" : input.status === "LOST" ? "LOST" : "STATUS_CHANGED";
    await recordActivity(tx, {
      organizationId: ctx.organizationId,
      leadId: lead.id,
      type,
      actorType: "USER",
      actorUserId: ctx.userId,
      payload: { from: lead.status, to: input.status, reason: input.reason ?? null },
    });
    const after = await tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
    await onStatusChanged(tx, lead, after, ctx.userId);
    return tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
  });
}

export async function addLeadNote(ctx: OrgContext, leadId: string, raw: { body: string }) {
  assertPermission(ctx, "leads:update");
  const { body } = addNoteSchema.parse(raw);
  const lead = await findAccessibleLead(ctx, leadId);
  return recordActivity(prisma, {
    organizationId: ctx.organizationId,
    leadId: lead.id,
    type: "NOTE_ADDED",
    actorType: "USER",
    actorUserId: ctx.userId,
    payload: { body },
  });
}

/** Manager reassigns a lead by hand (or moves it to the unassigned queue with memberId = null). */
export async function assignLeadManually(ctx: OrgContext, leadId: string, raw: { memberId: string | null; reason?: string }) {
  assertPermission(ctx, "leads:assign");
  const input = assignLeadSchema.parse(raw);
  const lead = await findAccessibleLead(ctx, leadId);
  return prisma.$transaction(async (tx) => {
    const member = input.memberId ? await activeMemberOrThrow(tx, ctx.organizationId, input.memberId) : null;
    return applyAssignment(tx, lead, {
      memberId: member?.id ?? null,
      memberName: member?.user.name ?? null,
      method: member ? "MANUAL" : "UNASSIGNED",
      actorUserId: ctx.userId,
      reason: input.reason,
    });
  });
}

/**
 * Employee records that they contacted the customer (call, email, …). This is separate from the
 * customer replying. Moves the lead forward and stamps lastContactAt; the follow-up engine
 * (Task 6) recalculates the next follow-up from this moment.
 */
export async function logInteraction(ctx: OrgContext, leadId: string, raw: LogInteractionInput) {
  assertPermission(ctx, "leads:update");
  const input = logInteractionSchema.parse(raw);
  const lead = await findAccessibleLead(ctx, leadId);
  return prisma.$transaction((tx) => applyEmployeeContact(tx, ctx, lead, input), ASSIGNMENT_TX);
}

/**
 * In-transaction core of "employee contacted the customer": validates, moves the status forward,
 * records the timeline entry and recalculates follow-ups. Shared with completing a follow-up.
 */
export async function applyEmployeeContact(
  tx: Tx,
  ctx: OrgContext,
  lead: Lead,
  input: { channel: string; note?: string; awaitingCustomer: boolean; occurredAt?: string },
): Promise<Lead> {
  if (lead.status === "CONVERTED" || lead.status === "LOST") {
    throw Errors.validation("Reopen this lead before logging new contact.");
  }
  const at = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (at.getTime() > Date.now() + 5 * 60_000) throw Errors.validation("The contact time can't be in the future.", { occurredAt: "In the future" });

  const progressStatuses: LeadStatus[] = ["NEW", "ASSIGNED", "CONTACTED", "WAITING_FOR_CUSTOMER", "FOLLOW_UP_DUE"];
  const nextStatus: LeadStatus = progressStatuses.includes(lead.status)
    ? input.awaitingCustomer
      ? "WAITING_FOR_CUSTOMER"
      : "CONTACTED"
    : lead.status; // QUALIFIED / ON_HOLD stay as they are

  const updated = await tx.lead.update({
    where: { id: lead.id },
    data: {
      status: nextStatus,
      lastContactAt: lead.lastContactAt && lead.lastContactAt > at ? lead.lastContactAt : at,
    },
  });
  await recordActivity(tx, {
    organizationId: ctx.organizationId,
    leadId: lead.id,
    type: "EMPLOYEE_CONTACTED",
    actorType: "USER",
    actorUserId: ctx.userId,
    occurredAt: at,
    payload: { channel: input.channel, note: input.note ?? null, awaitingCustomer: input.awaitingCustomer },
  });
  if (nextStatus !== lead.status) {
    await recordActivity(tx, {
      organizationId: ctx.organizationId,
      leadId: lead.id,
      type: "STATUS_CHANGED",
      actorType: "SYSTEM",
      payload: { from: lead.status, to: nextStatus, reason: "Contact logged" },
    });
  }
  await onEmployeeContact(tx, updated, { at, actorUserId: ctx.userId });
  return tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
}
