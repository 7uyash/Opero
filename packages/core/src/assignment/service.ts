import { prisma } from "@lfm/db";
import { getLeadAutomationSettings } from "../automation/settings";
import { Errors } from "../errors";
import { applyAssignment } from "../leads/service";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { audit } from "../audit/audit";
import { ASSIGNMENT_TX } from "./constants";
import { autoAssignLead } from "./round-robin";

export { ASSIGNMENT_TX };

/**
 * Shares a member's open leads with the rest of the team using the normal rotation
 * (excluding that member). Leads nobody can take go to the unassigned queue.
 * Each lead is its own short transaction so a large backlog never holds the lock for long.
 */
export async function redistributeOpenLeads(
  organizationId: string,
  memberId: string,
  opts: { actorUserId?: string | null; reason: string },
) {
  const settings = await getLeadAutomationSettings(organizationId);
  const leads = await prisma.lead.findMany({
    where: { organizationId, assignedMemberId: memberId, status: { notIn: ["CONVERTED", "LOST"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const result = { reassigned: 0, unassigned: 0 };
  for (const { id } of leads) {
    await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id } });
      // Skip if someone already moved it meanwhile.
      if (!lead || lead.assignedMemberId !== memberId) return;
      const res = await autoAssignLead(tx, lead, { ...settings, assignment: { ...settings.assignment, mode: "ROUND_ROBIN" } }, {
        reason: opts.reason,
        excludeMemberId: memberId,
      });
      if (res.method === "UNASSIGNED") {
        await applyAssignment(tx, lead, { memberId: null, method: "UNASSIGNED", actorUserId: opts.actorUserId, reason: opts.reason });
        result.unassigned++;
      } else result.reassigned++;
    }, ASSIGNMENT_TX);
  }
  return result;
}

/** Manager action: hand all of a member's open leads to the team (e.g. before a long leave). */
export async function redistributeMemberLeads(ctx: OrgContext, memberId: string, ip?: string | null) {
  assertPermission(ctx, "leads:assign");
  const member = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId: ctx.organizationId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!member) throw Errors.notFound("Team member");
  const result = await redistributeOpenLeads(ctx.organizationId, member.id, {
    actorUserId: ctx.userId,
    reason: `Redistributed from ${member.user.name}`,
  });
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "member.leads_redistributed",
    targetType: "member",
    targetId: member.id,
    ip,
    metadata: { member: member.user.email, ...result },
  });
  return result;
}
