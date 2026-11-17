import { prisma, type Lead, type OrganizationMember, type Tx } from "@lfm/db";
import type { LeadAutomationSettings } from "@lfm/shared";
import { applyAssignment } from "../leads/service";
import { managerMemberIds, notify } from "../notifications/service";

/**
 * Atomic round-robin assignment (ADR-005).
 *
 * The rotation is every ACTIVE member with `receivesLeads`, in a stable order (joined date, id).
 * The organization's single `assignment_cursors` row remembers who got the previous lead and is
 * locked with SELECT … FOR UPDATE for the rest of the transaction, so concurrent intakes in the
 * same organization queue up behind each other and never pick the same slot. Members who are
 * away keep their place in the ring but are skipped.
 */

type RingMember = Pick<OrganizationMember, "id" | "status" | "receivesLeads" | "isAvailable" | "unavailableUntil" | "isFallbackManager" | "role" | "createdAt"> & {
  user: { name: string };
};

/** Away members with an "away until" date in the past are treated as back. */
export function isAvailableNow(m: Pick<OrganizationMember, "isAvailable" | "unavailableUntil">, now = new Date()): boolean {
  if (m.isAvailable) return !m.unavailableUntil || m.unavailableUntil <= now;
  return !!m.unavailableUntil && m.unavailableUntil <= now;
}

export function isEligible(m: RingMember, now = new Date()): boolean {
  return m.status === "ACTIVE" && m.receivesLeads && isAvailableNow(m, now);
}

/**
 * Pure selection: the first eligible member after `lastMemberId` in ring order, wrapping around.
 * If the previous member left the ring, rotation continues from where they used to sit.
 */
export function pickNext<T extends { id: string; createdAt: Date }>(
  ring: T[],
  lastMember: { id: string; createdAt: Date } | null,
  eligible: (m: T) => boolean,
): T | null {
  if (ring.length === 0) return null;
  let start = 0;
  if (lastMember) {
    const idx = ring.findIndex((m) => m.id === lastMember.id);
    if (idx >= 0) start = idx + 1;
    else {
      // Position after the departed member: first ring entry ordered after them.
      const after = ring.findIndex(
        (m) => m.createdAt > lastMember.createdAt || (m.createdAt.getTime() === lastMember.createdAt.getTime() && m.id > lastMember.id),
      );
      start = after >= 0 ? after : 0;
    }
  }
  for (let i = 0; i < ring.length; i++) {
    const m = ring[(start + i) % ring.length]!;
    if (eligible(m)) return m;
  }
  return null;
}

const ringSelect = {
  id: true,
  status: true,
  receivesLeads: true,
  isAvailable: true,
  unavailableUntil: true,
  isFallbackManager: true,
  role: true,
  createdAt: true,
  user: { select: { name: true } },
} as const;

async function loadMembers(tx: Tx, organizationId: string): Promise<RingMember[]> {
  return tx.organizationMember.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: ringSelect,
  });
}

/** Locks (creating if missing) the organization's cursor row and returns the last assignee id. */
async function lockCursor(tx: Tx, organizationId: string): Promise<string | null> {
  await tx.$executeRaw`
    INSERT INTO assignment_cursors ("organizationId", "updatedAt") VALUES (${organizationId}, now())
    ON CONFLICT ("organizationId") DO NOTHING`;
  const rows = await tx.$queryRaw<{ lastMemberId: string | null }[]>`
    SELECT "lastMemberId" FROM assignment_cursors WHERE "organizationId" = ${organizationId} FOR UPDATE`;
  return rows[0]?.lastMemberId ?? null;
}

export type AutoAssignResult = {
  lead: Lead;
  method: "ROUND_ROBIN" | "FALLBACK" | "UNASSIGNED";
  memberId: string | null;
};

/**
 * Chooses and applies an assignee for a newly arrived lead. Must run inside the intake transaction.
 * Order: rotation → fallback manager → unassigned queue (managers notified).
 */
export async function autoAssignLead(
  tx: Tx,
  lead: Lead,
  settings: LeadAutomationSettings,
  opts: { reason?: string; excludeMemberId?: string } = {},
): Promise<AutoAssignResult> {
  const { organizationId } = lead;
  const now = new Date();

  if (settings.assignment.mode === "MANUAL") {
    await notifyUnassigned(tx, lead, "Assignment is set to manual.");
    return { lead, method: "UNASSIGNED", memberId: null };
  }

  const lastMemberId = await lockCursor(tx, organizationId);
  const members = await loadMembers(tx, organizationId);
  const ring = members.filter((m) => m.status === "ACTIVE" && m.receivesLeads);
  const last = lastMemberId ? (members.find((m) => m.id === lastMemberId) ?? null) : null;
  const eligible = (m: RingMember) => isEligible(m, now) && m.id !== opts.excludeMemberId;

  const next = pickNext(ring, last, eligible);
  if (next) {
    await tx.assignmentCursor.update({ where: { organizationId }, data: { lastMemberId: next.id } });
    const updated = await applyAssignment(tx, lead, {
      memberId: next.id,
      memberName: next.user.name,
      method: "ROUND_ROBIN",
      reason: opts.reason,
    });
    await notifyAssignee(tx, updated, next.id);
    return { lead: updated, method: "ROUND_ROBIN", memberId: next.id };
  }

  if (settings.assignment.useFallbackManager) {
    // Fallback managers don't consume a rotation slot. With several, share among them by fewest open leads.
    const fallbacks = members.filter(
      (m) => m.status === "ACTIVE" && m.isFallbackManager && isAvailableNow(m, now) && m.id !== opts.excludeMemberId,
    );
    if (fallbacks.length) {
      const loads = await tx.lead.groupBy({
        by: ["assignedMemberId"],
        where: { organizationId, assignedMemberId: { in: fallbacks.map((f) => f.id) }, status: { notIn: ["CONVERTED", "LOST"] } },
        _count: { _all: true },
      });
      const load = new Map(loads.map((l) => [l.assignedMemberId, l._count._all]));
      const chosen = [...fallbacks].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0]!;
      const updated = await applyAssignment(tx, lead, {
        memberId: chosen.id,
        memberName: chosen.user.name,
        method: "FALLBACK",
        reason: opts.reason ?? "Nobody in the rotation was available",
      });
      await notifyAssignee(tx, updated, chosen.id);
      return { lead: updated, method: "FALLBACK", memberId: chosen.id };
    }
  }

  await notifyUnassigned(tx, lead, "Nobody on the team was available to take it.");
  return { lead, method: "UNASSIGNED", memberId: null };
}

async function notifyAssignee(tx: Tx, lead: Lead, memberId: string) {
  await notify(tx, {
    organizationId: lead.organizationId,
    memberIds: [memberId],
    event: "leadAssigned",
    title: `New lead: ${lead.name}`,
    body: lead.subject ?? undefined,
    leadId: lead.id,
  });
}

async function notifyUnassigned(tx: Tx, lead: Lead, why: string) {
  await notify(tx, {
    organizationId: lead.organizationId,
    memberIds: await managerMemberIds(tx, lead.organizationId),
    event: "unassignedLead",
    title: `Unassigned lead: ${lead.name}`,
    body: `${why} Assign it from the leads list.`,
    leadId: lead.id,
  });
}

/**
 * Preview for the settings screen: the rotation in order, who is skipped and who is next.
 * Read-only — takes no lock, so under heavy traffic it is a best-effort snapshot.
 */
export async function previewRotation(organizationId: string) {
  const now = new Date();
  const [cursor, members] = await Promise.all([
    prisma.assignmentCursor.findUnique({ where: { organizationId } }),
    prisma.organizationMember.findMany({ where: { organizationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: ringSelect }),
  ]);
  const ring = members.filter((m) => m.status === "ACTIVE" && m.receivesLeads);
  const last = cursor?.lastMemberId ? (members.find((m) => m.id === cursor.lastMemberId) ?? null) : null;
  const next = pickNext(ring, last, (m) => isEligible(m, now));
  return {
    ring: ring.map((m) => ({ id: m.id, name: m.user.name, role: m.role, available: isEligible(m, now), isNext: m.id === next?.id })),
    lastAssignedId: cursor?.lastMemberId ?? null,
    nextId: next?.id ?? null,
    fallbacks: members
      .filter((m) => m.status === "ACTIVE" && m.isFallbackManager)
      .map((m) => ({ id: m.id, name: m.user.name, available: isAvailableNow(m, now) })),
  };
}
