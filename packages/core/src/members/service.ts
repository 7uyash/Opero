import { prisma, isUniqueViolation, type Prisma } from "@lfm/db";
import {
  DEFAULT_NOTIFICATION_PREFS,
  acceptInvitationSchema,
  inviteMemberSchema,
  passwordSchema,
  updateMemberSchema,
  updateMyMembershipSchema,
  type AcceptInvitationInput,
  type InviteMemberInput,
  type NotificationPrefs,
  type Role,
  type UpdateMemberInput,
  type UpdateMyMembershipInput,
} from "@lfm/shared";
import { redistributeOpenLeads } from "../assignment/service";
import { getLeadAutomationSettings } from "../automation/settings";
import { audit } from "../audit/audit";
import { hashPassword, verifyPassword } from "../auth/password";
import { createSession, type SessionMeta } from "../auth/sessions";
import { AppError, Errors } from "../errors";
import { hashToken, randomToken } from "../crypto/tokens";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { manageableRoles } from "../tenancy/permissions";

export const INVITATION_TTL_DAYS = 7;

const memberInclude = { user: { select: { id: true, name: true, email: true } } } as const;

export type MemberView = Awaited<ReturnType<typeof listMembers>>["members"][number];

export async function listMembers(ctx: OrgContext) {
  assertPermission(ctx, "members:view");
  const [members, invitations] = await Promise.all([
    prisma.organizationMember.findMany({
      where: { organizationId: ctx.organizationId },
      include: memberInclude,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.invitation.findMany({
      where: { organizationId: ctx.organizationId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, name: true, role: true, expiresAt: true, createdAt: true },
    }),
  ]);
  return {
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      status: m.status,
      receivesLeads: m.receivesLeads,
      isAvailable: m.isAvailable,
      unavailableUntil: m.unavailableUntil,
      isFallbackManager: m.isFallbackManager,
      createdAt: m.createdAt,
    })),
    invitations: invitations.map((i) => ({ ...i, expired: i.expiresAt.getTime() < Date.now() })),
  };
}

async function findMemberOrThrow(ctx: OrgContext, memberId: string) {
  // Always scope by organization (ADR-004): an id from another business is "not found".
  const member = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId: ctx.organizationId },
    include: memberInclude,
  });
  if (!member) throw Errors.notFound("Team member");
  return member;
}

function canManageRole(actor: Role, target: Role) {
  return manageableRoles(actor).includes(target);
}

/**
 * Owner/admin/manager updates another member. Rules:
 *  - OWNER memberships can't have their role or status changed here.
 *  - The actor may only touch members whose role they can manage, and only grant roles they can manage.
 *  - Nobody can disable or change the role of themselves.
 *  - Owners can edit their own assignment settings (receivesLeads, availability, fallback).
 */
export async function updateMember(ctx: OrgContext, memberId: string, raw: UpdateMemberInput, ip?: string | null) {
  const input = updateMemberSchema.parse(raw);
  const target = await findMemberOrThrow(ctx, memberId);
  const isSelf = target.id === ctx.memberId;
  const changesRoleOrStatus = input.role !== undefined || input.status !== undefined;

  if (changesRoleOrStatus) {
    assertPermission(ctx, "members:manage");
    if (isSelf) throw Errors.forbidden("You can't change your own role or deactivate yourself.");
    if (target.role === "OWNER") throw Errors.forbidden("The owner's role and access can't be changed.");
  }
  if (!isSelf) {
    assertPermission(ctx, "members:manage");
    if (!canManageRole(ctx.role, target.role)) throw Errors.forbidden("You can't manage this team member.");
  } else if (ctx.role !== "OWNER" && ctx.role !== "ADMIN" && ctx.role !== "MANAGER") {
    // Salespeople use updateMyMembership for availability.
    throw Errors.forbidden();
  }
  if (input.role !== undefined && !canManageRole(ctx.role, input.role)) {
    throw Errors.forbidden("You can't give someone that role.");
  }
  if (input.isFallbackManager && !["OWNER", "ADMIN", "MANAGER"].includes(input.role ?? target.role)) {
    throw Errors.validation("Only owners, admins or managers can be the fallback manager.", {
      isFallbackManager: "Choose a manager, admin or owner",
    });
  }

  const data: Prisma.OrganizationMemberUpdateInput = {};
  if (input.role !== undefined) data.role = input.role;
  if (input.status !== undefined) data.status = input.status;
  if (input.receivesLeads !== undefined) data.receivesLeads = input.receivesLeads;
  if (input.isAvailable !== undefined) data.isAvailable = input.isAvailable;
  if (input.unavailableUntil !== undefined) {
    data.unavailableUntil = input.unavailableUntil ? new Date(input.unavailableUntil) : null;
  }
  if (input.isFallbackManager !== undefined) data.isFallbackManager = input.isFallbackManager;
  // A demoted salesperson can no longer be the fallback manager.
  if (input.role === "SALESPERSON") data.isFallbackManager = false;

  const updated = await prisma.organizationMember.update({ where: { id: target.id }, data, include: memberInclude });

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(data) as (keyof typeof updated)[]) {
    const from = target[key as keyof typeof target];
    const to = updated[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to } as { from: unknown; to: unknown };
  }
  if (Object.keys(changes).length) {
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: input.status === "DISABLED" ? "member.deactivated" : input.status === "ACTIVE" ? "member.reactivated" : "member.updated",
      targetType: "member",
      targetId: target.id,
      ip,
      metadata: { member: target.user.email, changes } as Prisma.InputJsonValue,
    });
  }

  // A deactivated member can't work their leads any more: share them with the team.
  if (input.status === "DISABLED" && target.status !== "DISABLED") {
    const settings = await getLeadAutomationSettings(ctx.organizationId);
    if (settings.assignment.redistributeOnDeactivate) {
      const result = await redistributeOpenLeads(ctx.organizationId, target.id, {
        actorUserId: ctx.userId,
        reason: `${target.user.name} was deactivated`,
      });
      return Object.assign(updated, { redistributed: result });
    }
  }
  return Object.assign(updated, { redistributed: null as { reassigned: number; unassigned: number } | null });
}

/** Any member can update their own availability and notification preferences. */
export async function updateMyMembership(ctx: OrgContext, raw: UpdateMyMembershipInput) {
  const input = updateMyMembershipSchema.parse(raw);
  const current = await findMemberOrThrow(ctx, ctx.memberId);
  const data: Prisma.OrganizationMemberUpdateInput = {};
  if (input.isAvailable !== undefined) data.isAvailable = input.isAvailable;
  if (input.unavailableUntil !== undefined) {
    data.unavailableUntil = input.unavailableUntil ? new Date(input.unavailableUntil) : null;
  }
  if (input.notificationPrefs !== undefined) {
    data.notificationPrefs = {
      ...resolveNotificationPrefs(current.notificationPrefs),
      ...input.notificationPrefs,
    };
  }
  return prisma.organizationMember.update({ where: { id: ctx.memberId }, data, include: memberInclude });
}

export function resolveNotificationPrefs(stored: unknown): Required<NotificationPrefs> {
  const s = (stored && typeof stored === "object" ? stored : {}) as NotificationPrefs;
  return { ...DEFAULT_NOTIFICATION_PREFS, ...s } as Required<NotificationPrefs>;
}

// ───────────────────────────── Invitations ─────────────────────────────

/**
 * Creates an invitation and returns the one-time token. The raw token is never stored;
 * only its keyed hash is (ADR-003). Re-inviting the same email replaces the previous invitation.
 */
export async function inviteMember(ctx: OrgContext, raw: InviteMemberInput, ip?: string | null) {
  assertPermission(ctx, "members:manage");
  const input = inviteMemberSchema.parse(raw);
  if (!canManageRole(ctx.role, input.role)) throw Errors.forbidden("You can't invite someone with that role.");

  const existingMember = await prisma.organizationMember.findFirst({
    where: { organizationId: ctx.organizationId, user: { email: input.email } },
  });
  if (existingMember) {
    throw Errors.conflict(
      existingMember.status === "DISABLED"
        ? "This person is already on the team but deactivated. Reactivate them instead."
        : "This person is already on your team.",
      { email: "Already a team member" },
    );
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
  const invitation = await prisma.$transaction(async (tx) => {
    await tx.invitation.updateMany({
      where: { organizationId: ctx.organizationId, email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const inv = await tx.invitation.create({
      data: {
        organizationId: ctx.organizationId,
        email: input.email,
        name: input.name || null,
        role: input.role,
        tokenHash: hashToken(token),
        invitedById: ctx.userId,
        expiresAt,
      },
    });
    await audit(
      {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: "member.invited",
        targetType: "invitation",
        targetId: inv.id,
        ip,
        metadata: { email: input.email, role: input.role },
      },
      tx,
    );
    return inv;
  });
  return { invitation, token };
}

export async function revokeInvitation(ctx: OrgContext, invitationId: string, ip?: string | null) {
  assertPermission(ctx, "members:manage");
  const inv = await prisma.invitation.findFirst({
    where: { id: invitationId, organizationId: ctx.organizationId, acceptedAt: null, revokedAt: null },
  });
  if (!inv) throw Errors.notFound("Invitation");
  if (!canManageRole(ctx.role, inv.role)) throw Errors.forbidden();
  await prisma.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "member.invitation_revoked",
    targetType: "invitation",
    targetId: inv.id,
    ip,
    metadata: { email: inv.email },
  });
}

async function findUsableInvitation(token: string) {
  const inv = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { organization: { select: { id: true, name: true } } },
  });
  if (!inv || inv.revokedAt) throw new AppError("INVITATION_INVALID", "This invitation link is not valid. Ask for a new one.", 404);
  if (inv.acceptedAt) throw new AppError("INVITATION_USED", "This invitation has already been used. Sign in instead.", 410);
  if (inv.expiresAt.getTime() < Date.now()) {
    throw new AppError("INVITATION_EXPIRED", "This invitation has expired. Ask for a new one.", 410);
  }
  return inv;
}

/** Public preview shown on the accept page. */
export async function previewInvitation(token: string) {
  const inv = await findUsableInvitation(token);
  const hasAccount = (await prisma.user.count({ where: { email: inv.email } })) > 0;
  return { organizationName: inv.organization.name, email: inv.email, name: inv.name, role: inv.role, hasAccount };
}

/**
 * Accepts an invitation. New users choose a name + password; existing users confirm with their
 * password. The invitation is claimed with a conditional update so it can only be used once.
 */
export async function acceptInvitation(raw: AcceptInvitationInput, meta: SessionMeta = {}) {
  const input = acceptInvitationSchema.parse(raw);
  const inv = await findUsableInvitation(input.token);
  const existingUser = await prisma.user.findUnique({ where: { email: inv.email } });

  if (existingUser) {
    if (!(await verifyPassword(input.password, existingUser.passwordHash))) {
      throw new AppError("INVALID_CREDENTIALS", "Incorrect password for this account.", 401, { password: "Incorrect password" });
    }
  } else {
    if (!input.name) throw Errors.validation("Enter your name.", { name: "Enter your name" });
    const pw = passwordSchema.safeParse(input.password);
    if (!pw.success) throw Errors.validation("Choose a stronger password.", { password: pw.error.issues[0]!.message });
  }
  const newPasswordHash = existingUser ? null : await hashPassword(input.password);

  try {
    const { userId, memberId } = await prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw new AppError("INVITATION_USED", "This invitation has already been used.", 410);

      const user =
        existingUser ??
        (await tx.user.create({ data: { email: inv.email, name: input.name!, passwordHash: newPasswordHash! } }));
      const member = await tx.organizationMember.create({
        data: { organizationId: inv.organizationId, userId: user.id, role: inv.role, status: "ACTIVE" },
      });
      await audit(
        {
          organizationId: inv.organizationId,
          actorUserId: user.id,
          action: "member.joined",
          targetType: "member",
          targetId: member.id,
          ip: meta.ip,
          metadata: { email: inv.email, role: inv.role },
        },
        tx,
      );
      return { userId: user.id, memberId: member.id };
    });
    const session = await createSession(userId, inv.organizationId, meta);
    return { organizationId: inv.organizationId, userId, memberId, session };
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.conflict("You're already a member of this business. Sign in instead.");
    throw err;
  }
}
