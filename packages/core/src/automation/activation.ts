import { prisma } from "@lfm/db";
import { LEAD_FOLLOWUP_AUTOMATION, updateMessagingSettingsSchema, type MessageChannel, type UpdateMessagingSettingsInput } from "@lfm/shared";
import { previewRotation } from "../assignment/round-robin";
import { audit } from "../audit/audit";
import { Errors } from "../errors";
import { getFollowUpRules } from "../followups/engine";
import { getChannelIntegration } from "../integrations/service";
import { ensureDefaultTemplates, resolveTemplate } from "../messaging/templates";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { getLeadAutomationSettings, patchLeadAutomationSettings } from "./settings";

export type ActivationCheck = { id: string; label: string; ok: boolean; required: boolean; detail?: string; href?: string };

/**
 * What must be true before automatic messages may go out. Business owners see this as a checklist;
 * activation is refused until every required item passes.
 */
export async function getActivationStatus(organizationId: string) {
  await ensureDefaultTemplates(organizationId);
  const [config, settings, rotation, rules] = await Promise.all([
    prisma.automationConfig.findUnique({
      where: { organizationId_automationKey: { organizationId, automationKey: LEAD_FOLLOWUP_AUTOMATION } },
    }),
    getLeadAutomationSettings(organizationId),
    previewRotation(organizationId),
    getFollowUpRules(organizationId),
  ]);
  const m = settings.messaging;
  const connected: Record<MessageChannel, boolean> = {
    EMAIL: !!(await getChannelIntegration(prisma, organizationId, "EMAIL")),
    WHATSAPP: !!(await getChannelIntegration(prisma, organizationId, "WHATSAPP")),
  };
  const followUpChannels = [...new Set(rules.filter((r) => r.active).flatMap((r) => r.channels))] as MessageChannel[];
  const wanted = new Set<MessageChannel>([
    ...(m.acknowledgement.enabled ? m.acknowledgement.channels : []),
    ...(m.followUpMessages.enabled ? followUpChannels : []),
  ]);

  const checks: ActivationCheck[] = [
    {
      id: "team",
      label: "Someone is available to receive leads",
      ok: rotation.ring.some((r) => r.available) || rotation.fallbacks.some((f) => f.available),
      required: false,
      detail: "Otherwise new leads wait in the unassigned queue.",
      href: "/settings/team",
    },
    {
      id: "channel",
      label: "Email or WhatsApp is connected",
      ok: connected.EMAIL || connected.WHATSAPP,
      required: m.autoSend && wanted.size > 0,
      href: "/integrations",
    },
  ];
  for (const ch of wanted) {
    if (!connected[ch]) {
      checks.push({
        id: `connected-${ch}`,
        label: `${ch === "EMAIL" ? "Email" : "WhatsApp"} is connected`,
        ok: false,
        required: false,
        detail: `Messages set to go by ${ch === "EMAIL" ? "email" : "WhatsApp"} will use the fallback channel until it's connected.`,
        href: "/integrations",
      });
      continue;
    }
    const keys = [
      ...(m.acknowledgement.enabled && m.acknowledgement.channels.includes(ch) ? ["ACKNOWLEDGEMENT"] : []),
      ...(m.followUpMessages.enabled && followUpChannels.includes(ch) ? ["FOLLOW_UP"] : []),
    ];
    for (const key of keys) {
      const t = await resolveTemplate(prisma, organizationId, key, ch);
      checks.push({
        id: `template-${key}-${ch}`,
        label: `${key === "ACKNOWLEDGEMENT" ? "Acknowledgement" : "Follow-up"} ${ch === "EMAIL" ? "email" : "WhatsApp"} template approved`,
        ok: t?.approval === "APPROVED",
        required: m.autoSend,
        href: "/settings/messages",
      });
    }
  }
  return {
    status: config?.status ?? "DRAFT",
    activatedAt: config?.activatedAt ?? null,
    autoSend: m.autoSend,
    checks,
    canActivate: checks.every((c) => c.ok || !c.required),
  };
}

export async function activateAutomation(ctx: OrgContext, ip?: string | null) {
  assertPermission(ctx, "automation:activate");
  const status = await getActivationStatus(ctx.organizationId);
  if (!status.canActivate) {
    const missing = status.checks.filter((c) => c.required && !c.ok).map((c) => c.label);
    throw Errors.validation(`Before turning on automatic messages: ${missing.join("; ")}.`);
  }
  await patchLeadAutomationSettings(ctx.organizationId, (s) => s); // ensure the config row exists
  await prisma.automationConfig.update({
    where: { organizationId_automationKey: { organizationId: ctx.organizationId, automationKey: LEAD_FOLLOWUP_AUTOMATION } },
    data: { status: "ACTIVE", activatedAt: new Date(), activatedById: ctx.userId },
  });
  await audit({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "automation.activated", targetType: "automation", ip });
  return getActivationStatus(ctx.organizationId);
}

/** Pausing stops automatic messages immediately; queued ones are cancelled when they come up. */
export async function pauseAutomation(ctx: OrgContext, ip?: string | null) {
  assertPermission(ctx, "automation:activate");
  await patchLeadAutomationSettings(ctx.organizationId, (s) => s);
  await prisma.automationConfig.update({
    where: { organizationId_automationKey: { organizationId: ctx.organizationId, automationKey: LEAD_FOLLOWUP_AUTOMATION } },
    data: { status: "PAUSED" },
  });
  await audit({ organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "automation.paused", targetType: "automation", ip });
  return getActivationStatus(ctx.organizationId);
}

export async function updateMessagingSettings(ctx: OrgContext, raw: UpdateMessagingSettingsInput, ip?: string | null) {
  assertPermission(ctx, "automation:configure");
  const i = updateMessagingSettingsSchema.parse(raw);
  const next = await patchLeadAutomationSettings(ctx.organizationId, (s) => ({
    ...s,
    messaging: {
      ...s.messaging,
      ...(i.autoSend !== undefined && { autoSend: i.autoSend }),
      acknowledgement: {
        enabled: i.acknowledgementEnabled ?? s.messaging.acknowledgement.enabled,
        channels: i.acknowledgementChannels ?? s.messaging.acknowledgement.channels,
      },
      followUpMessages: { enabled: i.followUpMessagesEnabled ?? s.messaging.followUpMessages.enabled },
      sendingHours: {
        mode: i.sendingHoursMode ?? s.messaging.sendingHours.mode,
        custom: i.customSendingHours ?? s.messaging.sendingHours.custom,
      },
      ...(i.fallbackChannel !== undefined && { fallbackChannel: i.fallbackChannel }),
      ...(i.customVariables !== undefined && { customVariables: i.customVariables }),
    },
  }));
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: "automation.messaging_updated",
    targetType: "automation",
    ip,
    metadata: { fields: Object.keys(i) },
  });
  return next.messaging;
}

/** Which channels each follow-up step sends an automatic message on. */
export async function updateFollowUpStepChannels(ctx: OrgContext, steps: { stepIndex: number; channels: MessageChannel[] }[]) {
  assertPermission(ctx, "automation:configure");
  await prisma.$transaction(
    steps.map((s) =>
      prisma.followUpRule.updateMany({
        where: { organizationId: ctx.organizationId, stepIndex: s.stepIndex },
        data: { channels: [...new Set(s.channels)] },
      }),
    ),
  );
  return getFollowUpRules(ctx.organizationId);
}
