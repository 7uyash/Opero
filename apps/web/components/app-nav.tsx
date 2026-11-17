"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, Bell, CalendarClock, Inbox, LayoutDashboard, Menu, Plug, Settings, Users, X, Zap } from "lucide-react";
import type { Role } from "@lfm/shared";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; short?: string; icon: typeof LayoutDashboard; roles?: Role[]; match?: string; badge?: "unread"; primary?: boolean };

/** Main navigation; items are hidden from roles that cannot use them. */
const NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", short: "Home", icon: LayoutDashboard, primary: true },
  { href: "/leads", label: "Leads", icon: Inbox, primary: true },
  { href: "/follow-ups", label: "Follow-ups", icon: CalendarClock, primary: true },
  { href: "/notifications", label: "Notifications", short: "Alerts", icon: Bell, badge: "unread", primary: true },
  { href: "/automation", label: "Automation", icon: Zap, roles: ["OWNER", "ADMIN", "MANAGER"] },
  { href: "/activity", label: "Activity", icon: Activity, roles: ["OWNER", "ADMIN", "MANAGER"] },
  { href: "/integrations", label: "Integrations", icon: Plug, roles: ["OWNER", "ADMIN"] },
  { href: "/settings/team", label: "Team", icon: Users, match: "/settings/team" },
  { href: "/settings/business", label: "Settings", icon: Settings, match: "/settings" },
];

function useNav(role: Role) {
  const pathname = usePathname();
  const items = NAV.filter((i) => !i.roles || i.roles.includes(role));
  // The most specific matching item wins (so /settings/team highlights Team, not Settings).
  const activeHref = items
    .filter((i) => pathname === (i.match ?? i.href) || pathname.startsWith(`${i.match ?? i.href}/`))
    .sort((a, b) => (b.match ?? b.href).length - (a.match ?? a.href).length)[0]?.href;
  return { items, activeHref, pathname };
}

function UnreadBadge({ unread, className }: { unread: number; className?: string }) {
  if (unread <= 0) return null;
  return (
    <span className={cn("rounded-full bg-primary px-1.5 py-0.5 text-xs leading-none font-medium text-primary-foreground", className)}>
      {unread > 99 ? "99+" : unread}
      <span className="sr-only"> unread</span>
    </span>
  );
}

/** Desktop sidebar navigation. */
export function AppNav({ role, unread }: { role: Role; unread: number }) {
  const { items, activeHref } = useNav(role);
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 px-2 pb-2">
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
            {badge === "unread" && <UnreadBadge unread={unread} className="ml-auto" />}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Phone navigation: a bottom tab bar with the four everyday screens (in thumb reach), and
 * "More" for everything else, the business switcher and sign-out.
 */
export function MobileNav({ role, unread, footer }: { role: Role; unread: number; footer: React.ReactNode }) {
  const { items, activeHref, pathname } = useNav(role);
  const [open, setOpen] = useState(false);
  const primary = items.filter((i) => i.primary);
  const more = items.filter((i) => !i.primary);
  const moreActive = more.some((i) => i.href === activeHref);

  // Close the sheet on navigation and with the Escape key.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const tab = "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]";
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {primary.map(({ href, label, short, icon: Icon, badge }) => {
          const active = href === activeHref;
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn(tab, active ? "font-medium text-primary" : "text-muted-foreground")}>
              <span className="relative">
                <Icon className="size-5" aria-hidden />
                {badge === "unread" && <UnreadBadge unread={unread} className="absolute -top-2 left-3 px-1 text-[10px]" />}
              </span>
              {short ?? label}
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-controls="more-sheet" className={cn(tab, moreActive ? "font-medium text-primary" : "text-muted-foreground")}>
          <Menu className="size-5" aria-hidden />
          More
        </button>
      </nav>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="More" id="more-sheet">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-semibold">More</p>
              <button type="button" onClick={() => setOpen(false)} className="-mr-2 rounded-md p-2 text-muted-foreground" aria-label="Close">
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <ul className="grid grid-cols-2 gap-2">
              {more.map(({ href, label, icon: Icon }) => (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={href === activeHref ? "page" : undefined}
                    className={cn(
                      "flex min-h-12 items-center gap-2 rounded-lg border border-border px-3 text-sm",
                      href === activeHref ? "border-primary font-medium text-primary" : "text-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-border pt-3">{footer}</div>
          </div>
        </div>
      )}
    </>
  );
}
