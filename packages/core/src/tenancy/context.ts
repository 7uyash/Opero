import { prisma, type Db } from "@lfm/db";
import type { Role } from "@lfm/shared";
import { Errors } from "../errors";
import { hasPermission, type Permission } from "./permissions";

/**
 * Passed to every org-scoped service function (ADR-004).
 * Services must filter every query by ctx.organizationId.
 */
export type OrgContext = {
  organizationId: string;
  userId: string;
  memberId: string;
  role: Role;
};

export async function resolveOrgContext(
  userId: string,
  organizationId: string | null | undefined,
  db: Db = prisma,
): Promise<OrgContext | null> {
  const member = organizationId
    ? await db.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      })
    : // No active org on the session: fall back to the user's oldest active membership.
      await db.organizationMember.findFirst({ where: { userId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (!member || member.status !== "ACTIVE") return null;
  return { organizationId: member.organizationId, userId, memberId: member.id, role: member.role };
}

export function assertPermission(ctx: OrgContext, permission: Permission): void {
  if (!hasPermission(ctx.role, permission)) throw Errors.forbidden();
}

export function can(ctx: OrgContext, permission: Permission): boolean {
  return hasPermission(ctx.role, permission);
}
