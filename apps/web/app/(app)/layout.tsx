import { countUnreadNotifications, listMyOrganizations } from "@lfm/core";
import { ROLE_LABELS } from "@lfm/shared";
import { AppNav } from "@/components/app-nav";
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

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border bg-muted md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 p-4 md:block">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{org.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {session.user.name} · {ROLE_LABELS[ctx.role]}
            </p>
            <OrgSwitcher current={org.id} organizations={myOrgs} />
          </div>
          <div className="md:hidden">
            <SignOutButton />
          </div>
        </div>
        <AppNav role={ctx.role} unread={unread} />
        <div className="hidden p-4 md:block">
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}
