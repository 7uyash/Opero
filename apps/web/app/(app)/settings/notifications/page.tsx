import type { Metadata } from "next";
import { resolveNotificationPrefs } from "@lfm/core";
import { prisma } from "@lfm/db";
import { requireAuth } from "@/lib/session";
import { NotificationsForm } from "./notifications-form";

export const metadata: Metadata = { title: "My notifications" };

export default async function NotificationsPage() {
  const { ctx } = await requireAuth();
  const me = await prisma.organizationMember.findUniqueOrThrow({ where: { id: ctx.memberId } });
  return (
    <NotificationsForm
      initialPrefs={resolveNotificationPrefs(me.notificationPrefs)}
      initialAvailable={me.isAvailable}
      initialUntil={me.unavailableUntil?.toISOString() ?? null}
      receivesLeads={me.receivesLeads}
    />
  );
}
