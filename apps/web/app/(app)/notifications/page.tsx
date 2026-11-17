import type { Metadata } from "next";
import { listNotifications } from "@lfm/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOrganization, requireAuth } from "@/lib/session";
import { NotificationList } from "./notification-list";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const { ctx } = await requireAuth();
  const [{ items, unread }, org] = await Promise.all([listNotifications(ctx, { limit: 100 }), getOrganization(ctx.organizationId)]);
  return (
    <div className="mx-auto max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <NotificationList
            unread={unread}
            timeZone={org.timezone}
            items={items.map((n) => ({
              id: n.id,
              type: n.type,
              title: n.title,
              body: n.body,
              leadId: n.leadId,
              read: !!n.readAt,
              createdAt: n.createdAt.toISOString(),
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
