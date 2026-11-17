import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can, getLeadAutomationSettings, previewRotation } from "@lfm/core";
import { requireAuth } from "@/lib/session";
import { AssignmentForm } from "./assignment-form";

export const metadata: Metadata = { title: "Lead assignment" };

export default async function AssignmentPage() {
  const { ctx } = await requireAuth();
  if (!can(ctx, "leads:view_all")) notFound();
  const [settings, rotation] = await Promise.all([getLeadAutomationSettings(ctx.organizationId), previewRotation(ctx.organizationId)]);
  return (
    <AssignmentForm
      canEdit={can(ctx, "automation:configure")}
      initial={{
        mode: settings.assignment.mode,
        useFallbackManager: settings.assignment.useFallbackManager,
        redistributeOnDeactivate: settings.assignment.redistributeOnDeactivate,
        duplicatePolicy: settings.duplicates.policy,
      }}
      rotation={rotation}
    />
  );
}
