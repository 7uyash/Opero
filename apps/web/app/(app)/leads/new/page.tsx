import type { Metadata } from "next";
import { can, getLeadAutomationSettings, listAssignableMembers, previewRotation } from "@lfm/core";
import { requireAuth } from "@/lib/session";
import { NewLeadForm } from "./new-lead-form";

export const metadata: Metadata = { title: "Add lead" };

export default async function NewLeadPage() {
  const { ctx } = await requireAuth();
  const canAssign = can(ctx, "leads:assign");
  const [members, settings, rotation] = await Promise.all([
    canAssign ? listAssignableMembers(ctx) : Promise.resolve([]),
    getLeadAutomationSettings(ctx.organizationId),
    previewRotation(ctx.organizationId),
  ]);
  const next = rotation.ring.find((r) => r.isNext);
  const autoLabel =
    settings.assignment.mode === "MANUAL"
      ? "Automatic (assignment is manual — goes to the queue)"
      : next
        ? `Automatic — next in turn: ${next.name}`
        : "Automatic — nobody available, uses fallback or queue";
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Add a lead</h1>
        <p className="text-sm text-muted-foreground">For inquiries that came by phone, walk-in, referral or anywhere else.</p>
      </header>
      <NewLeadForm
        canAssign={canAssign}
        autoLabel={autoLabel}
        members={members.map((m) => ({ id: m.id, name: m.name, isAvailable: m.isAvailable }))}
      />
    </div>
  );
}
