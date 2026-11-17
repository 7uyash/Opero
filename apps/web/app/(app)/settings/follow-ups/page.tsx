import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can, getFollowUpRules } from "@lfm/core";
import { requireAuth } from "@/lib/session";
import { RulesForm } from "./rules-form";

export const metadata: Metadata = { title: "Follow-up schedule" };

export default async function FollowUpRulesPage() {
  const { ctx } = await requireAuth();
  if (!can(ctx, "leads:view_all")) notFound();
  const rules = await getFollowUpRules(ctx.organizationId);
  return (
    <RulesForm
      canEdit={can(ctx, "automation:configure")}
      initial={rules.map((r) => ({ name: r.name, delayMinutes: r.delayMinutes, active: r.active, channels: r.channels as ("EMAIL" | "WHATSAPP")[] }))}
    />
  );
}
