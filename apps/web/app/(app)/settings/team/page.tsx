import type { Metadata } from "next";
import { can, listMembers, manageableRoles } from "@lfm/core";
import { requireAuth } from "@/lib/session";
import { TeamManager } from "./team-manager";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const { ctx } = await requireAuth();
  const { members, invitations } = await listMembers(ctx);
  return (
    <TeamManager
      me={{ memberId: ctx.memberId, role: ctx.role }}
      canManage={can(ctx, "members:manage")}
      grantableRoles={manageableRoles(ctx.role)}
      members={members.map((m) => ({ ...m, unavailableUntil: m.unavailableUntil?.toISOString() ?? null, createdAt: m.createdAt.toISOString() }))}
      invitations={invitations.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() }))}
    />
  );
}
