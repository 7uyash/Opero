import { countUnreadNotifications, listMyOrganizations } from "@lfm/core";
import { ROLE_LABELS } from "@lfm/shared";
import { AppNav, MobileNav } from "@/components/app-nav";
import { OrgSwitcher } from "@/components/org-switcher";
import { SignOutButton } from "@/components/sign-out-button";
import { getOrganization, requireAuth } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, ctx } = await requireAuth();
  const [org, myOrgs, unread] = await Promise.all([
    getOrganization(ctx.organizationId),
    listMyOrganizations(session.user.id),
    countUnreadNotifications(ctx),
  ]);

  const who = (
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold">{org.name}</p>
      <p className="truncate text-xs text-muted-foreground">
        {session.user.name} · {ROLE_LABELS[ctx.role]}
      </p>
    </div>
  );

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden border-r border-border bg-muted md:block md:w-60 md:shrink-0">
        <div className="sticky top-0">
          <div className="p-4">
            {who}
            <OrgSwitcher current={org.id} organizations={myOrgs} />
          </div>
          <AppNav role={ctx.role} unread={unread} />
          <div className="p-4">
            <SignOutButton />
          </div>
        </div>
      </aside>

      {/* Phone top bar */}
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur md:hidden">
        <div className="min-w-0 py-2.5">{who}</div>
      </header>

      {/* min-w-0 stops wide content (tables) from stretching the page sideways on phones. */}
      <main className="min-w-0 flex-1 px-4 pt-5 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:px-8 md:py-6">{children}</main>

      <MobileNav
        role={ctx.role}
        unread={unread}
        footer={
          <div className="space-y-3">
            {who}
            <OrgSwitcher current={org.id} organizations={myOrgs} />
            <SignOutButton />
          </div>
        }
      />
    </div>
  );
}
