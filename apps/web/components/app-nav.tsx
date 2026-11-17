"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Bell, CalendarClock, Inbox, LayoutDashboard, Plug, Settings, Users, Zap } from "lucide-react";
import type { Role } from "@lfm/shared";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; roles?: Role[]; match?: string; badge?: "unread" };

/** Main navigation; items are hidden from roles that cannot use them. */
const NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/leads", label: "Leads", icon: Inbox },
  { href: "/follow-ups", label: "Follow-ups", icon: CalendarClock },
  { href: "/notifications", label: "Notifications", icon: Bell, badge: "unread" },
  { href: "/automation", label: "Automation", icon: Zap, roles: ["OWNER", "ADMIN", "MANAGER"] },
  { href: "/activity", label: "Activity", icon: Activity, roles: ["OWNER", "ADMIN", "MANAGER"] },
  { href: "/integrations", label: "Integrations", icon: Plug, roles: ["OWNER", "ADMIN"] },
  { href: "/settings/team", label: "Team", icon: Users, match: "/settings/team" },
  { href: "/settings/business", label: "Settings", icon: Settings, match: "/settings" },
];

export function AppNav({ role, unread }: { role: Role; unread: number }) {
  const pathname = usePathname();
  const items = NAV.filter((i) => !i.roles || i.roles.includes(role));
  // The most specific matching item wins (so /settings/team highlights Team, not Settings).
  const activeHref = items
    .filter((i) => pathname === (i.match ?? i.href) || pathname.startsWith(`${i.match ?? i.href}/`))
    .sort((a, b) => (b.match ?? b.href).length - (a.match ?? a.href).length)[0]?.href;

  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
      {items.map(({ href, label, icon: Icon, badge }) => {
        const active = href === activeHref;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm",
              active ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
            {badge === "unread" && unread > 0 && (
              <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-xs leading-none font-medium text-primary-foreground">
                {unread > 99 ? "99+" : unread}
                <span className="sr-only"> unread</span>
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
