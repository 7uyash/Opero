import { DateTime } from "luxon";
import { prisma, type Prisma } from "@lfm/db";
import { CLOSED_STATUSES, listLeadsQuerySchema, type LeadStatus, type ListLeadsQuery } from "@lfm/shared";
import { assertPermission, can, type OrgContext } from "../tenancy/context";
import { findAccessibleLead, leadScope } from "./service";

const memberSelect = { select: { id: true, user: { select: { name: true } } } } as const;

/** Start/end of a YYYY-MM-DD calendar day in the organization's timezone, as UTC Dates. */
function dayBounds(date: string, tz: string) {
  const start = DateTime.fromISO(date, { zone: tz }).startOf("day");
  return { start: start.toJSDate(), end: start.endOf("day").toJSDate() };
}

export async function listLeads(ctx: OrgContext, raw: ListLeadsQuery) {
  assertPermission(ctx, "leads:view_assigned");
  const q = listLeadsQuerySchema.parse(raw);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
  const tz = org.timezone;
  const now = new Date();

  const and: Prisma.LeadWhereInput[] = [leadScope(ctx)];

  if (q.q) {
    const term = q.q;
    const digits = term.replace(/\D/g, "");
    const or: Prisma.LeadWhereInput[] = [
      { name: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
      { company: { contains: term, mode: "insensitive" } },
    ];
    if (digits.length >= 4) or.push({ phoneE164: { contains: digits } });
    and.push({ OR: or });
  }
  if (q.status?.length) and.push({ status: { in: q.status } });
  else if (!q.includeClosed) and.push({ status: { notIn: [...CLOSED_STATUSES] } });
  if (q.source?.length) and.push({ sourceType: { in: q.source } });
  if (q.priority?.length) and.push({ priority: { in: q.priority } });
  if (q.assignee && can(ctx, "leads:view_all")) {
    if (q.assignee === "unassigned") and.push({ assignedMemberId: null });
    else and.push({ assignedMemberId: q.assignee === "me" ? ctx.memberId : q.assignee });
  }
  if (q.createdFrom) and.push({ createdAt: { gte: dayBounds(q.createdFrom, tz).start } });
  if (q.createdTo) and.push({ createdAt: { lte: dayBounds(q.createdTo, tz).end } });
  if (q.followUp) {
    const today = DateTime.now().setZone(tz);
    switch (q.followUp) {
      case "overdue":
        // Overdue = still open from before today (today's reminders are "due today").
        and.push({ nextFollowUpAt: { lt: today.startOf("day").toJSDate() } });
        break;
      case "today":
        and.push({ nextFollowUpAt: { gte: today.startOf("day").toJSDate(), lte: today.endOf("day").toJSDate() } });
        break;
      case "week":
        and.push({ nextFollowUpAt: { gte: now, lte: today.plus({ days: 7 }).toJSDate() } });
        break;
      case "none":
        and.push({ nextFollowUpAt: null });
        break;
    }
  }

  const where: Prisma.LeadWhereInput = { AND: and };
  const nullable = q.sort === "lastContactAt" || q.sort === "nextFollowUpAt";
  const orderBy: Prisma.LeadOrderByWithRelationInput[] = [
    nullable ? { [q.sort]: { sort: q.dir, nulls: "last" } } : { [q.sort]: q.dir },
    { id: "desc" },
  ];

  const [total, rows] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { assignedMember: memberSelect },
    }),
  ]);

  return {
    items: rows.map((l) => ({
      id: l.id,
      name: l.name,
      email: l.email,
      phone: l.phone,
      company: l.company,
      subject: l.subject,
      source: l.sourceType,
      status: l.status,
      priority: l.priority,
      assignedTo: l.assignedMember ? { id: l.assignedMember.id, name: l.assignedMember.user.name } : null,
      possibleDuplicate: !!l.duplicateOfId,
      lastContactAt: l.lastContactAt,
      nextFollowUpAt: l.nextFollowUpAt,
      createdAt: l.createdAt,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
    pageCount: Math.max(1, Math.ceil(total / q.pageSize)),
    query: q,
  };
}

export type LeadListItem = Awaited<ReturnType<typeof listLeads>>["items"][number];

export async function getLeadDetail(ctx: OrgContext, leadId: string) {
  const base = await findAccessibleLead(ctx, leadId);
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: base.id },
    include: {
      assignedMember: memberSelect,
      source: { select: { label: true, type: true } },
      duplicateOf: { select: { id: true, name: true } },
      duplicates: { select: { id: true, name: true, createdAt: true } },
      assignments: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
        include: { member: memberSelect },
      },
    },
  });
  return lead;
}

/** Chronological timeline with actor names resolved. */
export async function getLeadTimeline(ctx: OrgContext, leadId: string, opts: { limit?: number } = {}) {
  const lead = await findAccessibleLead(ctx, leadId);
  const activities = await prisma.leadActivity.findMany({
    where: { leadId: lead.id, organizationId: ctx.organizationId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: Math.min(opts.limit ?? 200, 500),
  });
  const userIds = [...new Set(activities.map((a) => a.actorUserId).filter((x): x is string => !!x))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return activities.map((a) => ({
    id: a.id,
    type: a.type,
    actorType: a.actorType,
    actorName: a.actorUserId ? (names.get(a.actorUserId) ?? "Former team member") : null,
    payload: a.payload as Record<string, unknown>,
    occurredAt: a.occurredAt,
  }));
}

export type TimelineEntry = Awaited<ReturnType<typeof getLeadTimeline>>[number];

/** Members a lead can be assigned to. */
export async function listAssignableMembers(ctx: OrgContext) {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId: ctx.organizationId, status: "ACTIVE" },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return members.map((m) => ({ id: m.id, name: m.user.name, role: m.role, isAvailable: m.isAvailable, receivesLeads: m.receivesLeads }));
}

// ───────────────────────────── Dashboard ─────────────────────────────

export async function getDashboardOverview(ctx: OrgContext) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { timezone: true } });
  const scope = leadScope(ctx);
  const now = new Date();
  const todayStart = DateTime.now().setZone(org.timezone).startOf("day").toJSDate();
  const open = { status: { notIn: [...CLOSED_STATUSES] as LeadStatus[] } };

  const [total, newToday, awaiting, overdue, converted, lost, unassigned, byStatus, bySource] = await Promise.all([
    prisma.lead.count({ where: scope }),
    prisma.lead.count({ where: { ...scope, createdAt: { gte: todayStart } } }),
    prisma.lead.count({ where: { ...scope, ...open, OR: [{ status: "FOLLOW_UP_DUE" }, { nextFollowUpAt: { not: null } }] } }),
    prisma.lead.count({ where: { ...scope, ...open, nextFollowUpAt: { lt: todayStart } } }),
    prisma.lead.count({ where: { ...scope, status: "CONVERTED" } }),
    prisma.lead.count({ where: { ...scope, status: "LOST" } }),
    can(ctx, "leads:view_all") ? prisma.lead.count({ where: { ...scope, ...open, assignedMemberId: null } }) : Promise.resolve(0),
    prisma.lead.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["sourceType"], where: scope, _count: { _all: true } }),
  ]);

  const closed = converted + lost;
  const stats = {
    total,
    newToday,
    awaitingFollowUp: awaiting,
    overdueFollowUps: overdue,
    converted,
    lost,
    unassigned,
    /** Share of decided (converted + lost) leads that converted. */
    conversionRate: closed ? converted / closed : null,
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])) as Partial<Record<LeadStatus, number>>,
    bySource: Object.fromEntries(bySource.map((r) => [r.sourceType, r._count._all])),
  };

  const team = can(ctx, "dashboard:view_team") ? await getTeamPerformance(ctx.organizationId, todayStart) : null;
  return { stats, team, timezone: org.timezone };
}

async function getTeamPerformance(organizationId: string, overdueBefore: Date) {
  const [members, rows, overdueRows] = await Promise.all([
    prisma.organizationMember.findMany({
      where: { organizationId, status: "ACTIVE" },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.lead.groupBy({
      by: ["assignedMemberId", "status"],
      where: { organizationId, assignedMemberId: { not: null } },
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ["assignedMemberId"],
      where: { organizationId, assignedMemberId: { not: null }, status: { notIn: [...CLOSED_STATUSES] }, nextFollowUpAt: { lt: overdueBefore } },
      _count: { _all: true },
    }),
  ]);
  const overdueBy = new Map(overdueRows.map((r) => [r.assignedMemberId, r._count._all]));
  return members.map((m) => {
    const mine = rows.filter((r) => r.assignedMemberId === m.id);
    const count = (s?: LeadStatus[]) => mine.filter((r) => !s || s.includes(r.status)).reduce((n, r) => n + r._count._all, 0);
    const assigned = count();
    const converted = count(["CONVERTED"]);
    const lost = count(["LOST"]);
    return {
      memberId: m.id,
      name: m.user.name,
      role: m.role,
      isAvailable: m.isAvailable,
      assigned,
      open: assigned - converted - lost,
      awaitingFirstContact: count(["NEW", "ASSIGNED"]),
      converted,
      lost,
      overdue: overdueBy.get(m.id) ?? 0,
      conversionRate: converted + lost ? converted / (converted + lost) : null,
    };
  });
}
