import { z } from "zod";
import { messagingSettingsSchema } from "./messaging";

export const LEAD_FOLLOWUP_AUTOMATION = "lead-followup";

export const ASSIGNMENT_MODES = ["ROUND_ROBIN", "MANUAL"] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];
export const ASSIGNMENT_MODE_LABELS: Record<AssignmentMode, { label: string; description: string }> = {
  ROUND_ROBIN: {
    label: "Share leads in turn (round-robin)",
    description: "Each new lead goes to the next available team member, so everyone gets a fair share.",
  },
  MANUAL: {
    label: "Assign by hand",
    description: "New leads wait in the unassigned queue until a manager assigns them.",
  },
};

export const DUPLICATE_POLICIES = ["MERGE", "REVIEW"] as const;
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];
export const DUPLICATE_POLICY_LABELS: Record<DuplicatePolicy, { label: string; description: string }> = {
  MERGE: {
    label: "Add to the existing lead",
    description: "When a known customer gets in touch again, their new message is added to their existing lead.",
  },
  REVIEW: {
    label: "Create a new lead and flag it",
    description: "A separate lead is created and marked as a possible duplicate for your team to review.",
  },
};

/**
 * Settings of the Lead & Follow-up automation, stored in automation_configs.settings.
 * Each section is filled in by the task that owns it; unknown keys are preserved.
 */
export const leadAutomationSettingsSchema = z
  .object({
    assignment: z
      .object({
        mode: z.enum(ASSIGNMENT_MODES).default("ROUND_ROBIN"),
        /** Use fallback managers when nobody in the rotation is available. */
        useFallbackManager: z.boolean().default(true),
        /** Share a member's open leads with the team when they are deactivated. */
        redistributeOnDeactivate: z.boolean().default(true),
      })
      .prefault({}),
    messaging: messagingSettingsSchema,
    /** Lead sources chosen in the setup wizard. Choosing a source never marks it as connected. */
    sources: z
      .object({ selected: z.array(z.string()).default(["WEBSITE", "EMAIL", "WHATSAPP", "META", "MANUAL", "CRM"]) })
      .prefault({}),
    duplicates: z
      .object({
        /** Applies to leads arriving automatically (website, email, WhatsApp…). */
        policy: z.enum(DUPLICATE_POLICIES).default("MERGE"),
      })
      .prefault({}),
  })
  .loose();
export type LeadAutomationSettings = z.infer<typeof leadAutomationSettingsSchema>;

export const updateAssignmentSettingsSchema = z.object({
  mode: z.enum(ASSIGNMENT_MODES).optional(),
  useFallbackManager: z.boolean().optional(),
  redistributeOnDeactivate: z.boolean().optional(),
  duplicatePolicy: z.enum(DUPLICATE_POLICIES).optional(),
});
export type UpdateAssignmentSettingsInput = z.infer<typeof updateAssignmentSettingsSchema>;
