import { can } from "@lfm/core";
import { requireAuth } from "@/lib/session";
import { SettingsTabs } from "./tabs";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { ctx } = await requireAuth();
  const tabs = [
    { href: "/settings/business", label: "Business" },
    { href: "/settings/team", label: "Team" },
    ...(can(ctx, "leads:view_all")
      ? [
          { href: "/settings/assignment", label: "Lead assignment" },
          { href: "/settings/follow-ups", label: "Follow-up schedule" },
          { href: "/settings/messages", label: "Messages" },
        ]
      : []),
    { href: "/settings/hours", label: "Working hours" },
    { href: "/settings/notifications", label: "My notifications" },
    ...(can(ctx, "audit:view") ? [{ href: "/settings/audit", label: "Audit log" }] : []),
  ];
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Your business details, team and preferences.</p>
      </header>
      <SettingsTabs tabs={tabs} />
      {children}
    </div>
  );
}
