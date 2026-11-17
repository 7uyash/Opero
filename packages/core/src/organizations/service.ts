import { prisma, type Prisma } from "@lfm/db";
import { updateOrganizationSchema, type UpdateOrganizationInput } from "@lfm/shared";
import { audit } from "../audit/audit";
import { Errors } from "../errors";
import { assertPermission, type OrgContext } from "../tenancy/context";

export async function getOrganization(ctx: OrgContext) {
  const org = await prisma.organization.findUnique({ where: { id: ctx.organizationId } });
  if (!org) throw Errors.notFound("Business");
  return org;
}

export async function updateOrganization(ctx: OrgContext, raw: UpdateOrganizationInput, ip?: string | null) {
  assertPermission(ctx, "org:update");
  const input = updateOrganizationSchema.parse(raw);
  const before = await getOrganization(ctx);

  const data: Prisma.OrganizationUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.email !== undefined) data.email = input.email;
  if (input.businessType !== undefined) data.businessType = input.businessType;
  if (input.website !== undefined) data.website = input.website;
  if (input.timezone !== undefined) data.timezone = input.timezone;
  if (input.defaultCountry !== undefined) data.defaultCountry = input.defaultCountry;
  if (input.workingHours !== undefined) data.workingHours = input.workingHours;
  if (input.holidays !== undefined) {
    data.holidays = [...input.holidays].sort((a, b) => a.date.localeCompare(b.date));
  }

  const org = await prisma.organization.update({ where: { id: ctx.organizationId }, data });
  const changed = (Object.keys(data) as (keyof typeof before)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(org[k]),
  );
  if (changed.length) {
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: "organization.updated",
      targetType: "organization",
      targetId: ctx.organizationId,
      ip,
      metadata: { fields: changed },
    });
  }
  return org;
}

/** Organizations the user can switch to. */
export async function listMyOrganizations(userId: string) {
  const memberships = await prisma.organizationMember.findMany({
    where: { userId, status: "ACTIVE" },
    include: { organization: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({ id: m.organization.id, name: m.organization.name, role: m.role }));
}

export async function listAuditLogs(ctx: OrgContext, opts: { cursor?: string; limit?: number } = {}) {
  assertPermission(ctx, "audit:view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const rows = await prisma.auditLog.findMany({
    where: { organizationId: ctx.organizationId },
    include: { actor: { select: { name: true, email: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}
