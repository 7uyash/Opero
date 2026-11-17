"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/fetcher";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Item = { id: string; type: string; title: string; body: string | null; leadId: string | null; read: boolean; createdAt: string };

export function NotificationList({ items, unread, timeZone }: { items: Item[]; unread: number; timeZone: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function open(n: Item) {
    if (!n.read) await api("/api/notifications/read", { body: { ids: [n.id] } }).catch(() => undefined);
    if (n.leadId) router.push(`/leads/${n.leadId}`);
    router.refresh();
  }

  if (items.length === 0) return <p className="text-sm text-muted-foreground">You're all caught up. New leads and replies will show up here.</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{unread ? `${unread} unread` : "All read"}</span>
        {unread > 0 && (
          <Button
            variant="ghost"
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await api("/api/notifications/read", { body: {} }).catch(() => undefined);
              setBusy(false);
              router.refresh();
            }}
          >
            Mark all as read
          </Button>
        )}
      </div>
      <ul className="divide-y divide-border">
        {items.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => open(n)}
              className={cn("flex w-full items-start gap-3 px-2 py-3 text-left text-sm hover:bg-muted/60", !n.read && "font-medium")}
            >
              <span
                className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")}
                aria-label={n.read ? undefined : "Unread"}
              />
              <span className="flex-1">
                <span className="block">{n.title}</span>
                {n.body && <span className="block font-normal text-muted-foreground">{n.body}</span>}
              </span>
              <time className="shrink-0 text-xs font-normal text-muted-foreground" dateTime={n.createdAt}>
                {formatDateTime(n.createdAt, timeZone)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
