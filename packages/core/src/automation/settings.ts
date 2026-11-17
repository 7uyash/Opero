import { prisma, type Db, type Prisma } from "@lfm/db";
import {
  LEAD_FOLLOWUP_AUTOMATION,
  leadAutomationSettingsSchema,
  updateAssignmentSettingsSchema,
  type LeadAutomationSettings,
  type UpdateAssignmentSettingsInput,
} from "@lfm/shared";
import { audit } from "../audit/audit";
import { assertPermission, type OrgContext } from "../tenancy/context";

/** Reads the automation settings, applying defaults for anything not configured yet. */
export async function getLeadAutomationSettings(organizationId: string, db: Db = prisma): Promise<LeadAutomationSettings> {
  const row = await db.automationConfig.findUnique({
    where: { organizationId_automationKey: { organizationId, automationKey: LEAD_FOLLOWUP_AUTOMATION } },
  });
  const parsed = leadAutomationSettingsSchema.safeParse(row?.settings ?? {});
  return parsed.success ? parsed.data : leadAutomationSettingsSchema.parse({});
}

/** Deep-merges a partial settings patch into the stored settings (creating the config row if needed). */
export async function patchLeadAutomationSettings(
  organizationId: string,
  patch: (current: LeadAutomationSettings) => LeadAutomationSettings,
  db: Db = prisma,
): Promise<LeadAutomationSettings> {
  const current = await getLeadAutomationSettings(organizationId, db);
  const next = leadAutomationSettingsSchema.parse(patch(current));
  await db.automationConfig.upsert({
    where: { organizationId_automationKey: { organizationId, automationKey: LEAD_FOLLOWUP_AUTOMATION } },
    update: { settings: next as Prisma.InputJsonValue },
    create: { organizationId, automationKey: LEAD_FOLLOWUP_AUTOMATION, settings: next as Prisma.InputJsonValue },
  });
  return next;
}

export async function updateAssignmentSettings(ctx: OrgContext, raw: UpdateAssignmentSettingsInput, ip?: string | null) {
  assertPermission(ctx, "automation:configure");
  const input = updateAssignmentSettingsSchema.parse(raw);
  const next = await patchLeadAutomationSettings(ctx.organizationId, (s) => ({
    ...s,
    assignment: {
      ...s.assignment,
      ...(input.mode !== undefined && { mode: input.mode }),
      ...(input.useFallbackManager !== undefined && { useFallbackManager: input.useFallbackManager }),
      ...(input.redistributeOnDeactivate !== undefined && { redistributeOnDeactivate: input.redistributeOnDeactivate }),
    },
    duplicates: { ...s.duplicates, ...(input.duplicatePolicy !== undefined && { policy: input.duplicatePolicy }) },
  }));
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "automation.assignment_updated",
    targetType: "automation",
    targetId: LEAD_FOLLOWUP_AUTOMATION,
    ip,
    metadata: input,
  });
  return next;
}
