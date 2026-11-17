import { prisma, type Db } from "@lfm/db";
import type { NotificationEvent } from "@lfm/shared";
import { resolveNotificationPrefs } from "../members/service";
import type { OrgContext } from "../tenancy/context";

export type NotifyInput = {
  organizationId: string;
  memberIds: string[];
  event: NotificationEvent;
  title: string;
  body?: string;
  leadId?: string | null;
};

/**
 * Creates in-app notifications for members who opted in to this event. Email delivery of
 * notifications is handled by the messaging engine (Task 7) using the same preferences.
 */
export async function notify(db: Db, n: NotifyInput): Promise<number> {
  const ids = [...new Set(n.memberIds)];
  if (ids.length === 0) return 0;
  const members = await db.organizationMember.findMany({
    where: { id: { in: ids }, organizationId: n.organizationId, status: "ACTIVE" },
    select: { id: true, notificationPrefs: true },
  });
  const withPrefs = members.map((m) => ({ id: m.id, prefs: resolveNotificationPrefs(m.notificationPrefs)[n.event] }));
  const recipients = withPrefs.filter((m) => m.prefs?.inApp !== false || m.prefs?.email);
  if (recipients.length === 0) return 0;
  const res = await db.notification.createMany({
    data: recipients.map((m) => ({
      organizationId: n.organizationId,
      memberId: m.id,
      type: n.event,
      title: n.title,
      body: n.body ?? null,
      leadId: n.leadId ?? null,
      // Email copies are sent by the worker (only if the business has an email account connected).
      emailPending: !!m.prefs?.email,
      // Email-only preference: keep the row for the email but don't show it as unread in the app.
      readAt: m.prefs?.inApp === false ? new Date() : null,
    })),
  });
  return res.count;
}

/** Active owners, admins and managers — who to tell about leads nobody could take. */
export async function managerMemberIds(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db.organizationMember.findMany({
    where: { organizationId, status: "ACTIVE", role: { in: ["OWNER", "ADMIN", "MANAGER"] } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function listNotifications(ctx: OrgContext, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const where = { organizationId: ctx.organizationId, memberId: ctx.memberId, ...(opts.unreadOnly ? { readAt: null } : {}) };
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 50, 200) }),
    countUnreadNotifications(ctx),
  ]);
  return { items, unread };
}

export function countUnreadNotifications(ctx: OrgContext) {
  return prisma.notification.count({ where: { organizationId: ctx.organizationId, memberId: ctx.memberId, readAt: null } });
}

/** Marks the given notifications (or all) as read — only the caller's own. */
export async function markNotificationsRead(ctx: OrgContext, ids?: string[]) {
  const res = await prisma.notification.updateMany({
    where: {
      organizationId: ctx.organizationId,
      memberId: ctx.memberId,
      readAt: null,
      ...(ids ? { id: { in: ids.slice(0, 200) } } : {}),
    },
    data: { readAt: new Date() },
  });
  return res.count;
}
