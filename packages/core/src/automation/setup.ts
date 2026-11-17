import { prisma } from "@lfm/db";
import { LEAD_FOLLOWUP_AUTOMATION, SOURCE_SELECTION_SCHEMA } from "@lfm/shared";
import { audit } from "../audit/audit";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { getLeadAutomationSettings, patchLeadAutomationSettings } from "./settings";

/** Setup wizard steps (PLAN §9): Sources → Team → Assignment → Follow-ups → Messages → Review. */
export const SETUP_STEPS = ["sources", "team", "assignment", "follow-ups", "messages", "review"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

const where = (organizationId: string) => ({ organizationId_automationKey: { organizationId, automationKey: LEAD_FOLLOWUP_AUTOMATION } });

export async function getInstallState(organizationId: string) {
  const c = await prisma.automationConfig.findUnique({ where: where(organizationId) });
  // Installed = started from the marketplace card, or already turned on at some point.
  const installed = !!c && (c.setupStep > 0 || c.status !== "DRAFT");
  return { installed, setupStep: installed ? Math.max(c!.setupStep, 1) : 0, status: c?.status ?? "DRAFT" };
}

/** "Install automation": creates the configuration in DRAFT and starts the wizard. Idempotent. */
export async function installAutomation(ctx: OrgContext, ip?: string | null) {
  assertPermission(ctx, "automation:configure");
  await patchLeadAutomationSettings(ctx.organizationId, (s) => s);
  const c = await prisma.automationConfig.findUniqueOrThrow({ where: where(ctx.organizationId) });
  if (c.setupStep === 0) {
    await prisma.automationConfig.update({ where: { id: c.id }, data: { setupStep: 1 } });
    await audit({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "automation.installed", targetType: "automation", ip });
  }
  return getInstallState(ctx.organizationId);
}

/** Remembers the furthest wizard step reached (1-based). */
export async function setSetupStep(ctx: OrgContext, step: number) {
  assertPermission(ctx, "automation:configure");
  const s = Math.min(Math.max(Math.trunc(step), 1), SETUP_STEPS.length);
  await patchLeadAutomationSettings(ctx.organizationId, (x) => x);
  const c = await prisma.automationConfig.findUniqueOrThrow({ where: where(ctx.organizationId) });
  if (s > c.setupStep) await prisma.automationConfig.update({ where: { id: c.id }, data: { setupStep: s } });
  return getInstallState(ctx.organizationId);
}

/** Which lead sources the business wants. Selecting a source never marks it connected. */
export async function updateSourceSelection(ctx: OrgContext, raw: { selected: string[] }) {
  assertPermission(ctx, "automation:configure");
  const { selected } = SOURCE_SELECTION_SCHEMA.parse(raw);
  const next = await patchLeadAutomationSettings(ctx.organizationId, (s) => ({ ...s, sources: { selected } }));
  return next.sources;
}

export async function getSourceSelection(organizationId: string) {
  return (await getLeadAutomationSettings(organizationId)).sources.selected;
}
