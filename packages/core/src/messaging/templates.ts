import { prisma, type Db, type MessageTemplate } from "@lfm/db";
import { previewTemplateSchema, saveTemplateSchema, type MessageChannel, type SaveTemplateInput } from "@lfm/shared";
import { audit } from "../audit/audit";
import { getLeadAutomationSettings } from "../automation/settings";
import { Errors } from "../errors";
import { findAccessibleLead } from "../leads/service";
import { assertPermission, type OrgContext } from "../tenancy/context";
import { findUnknownVariables, renderTemplate, sampleValues, valuesForLead } from "./render";

/** Starting templates, based on the product specification. They start as drafts. */
export const DEFAULT_TEMPLATES: { key: string; channel: MessageChannel; name: string; subject?: string; body: string }[] = [
  {
    key: "ACKNOWLEDGEMENT",
    channel: "EMAIL",
    name: "Acknowledgement email",
    subject: "We've received your inquiry!",
    body:
      "Hi {{customer_name}},\n\nThank you for contacting {{business_name}}.\n\n" +
      "We've received your inquiry and our team will review your requirements. One of our representatives will get back to you shortly.\n\n" +
      "Regards,\n{{business_name}}",
  },
  {
    key: "ACKNOWLEDGEMENT",
    channel: "WHATSAPP",
    name: "Acknowledgement WhatsApp",
    body: "Hi {{customer_name}}, thanks for contacting {{business_name}}! We've received your inquiry and our team will get back to you shortly.",
  },
  {
    key: "FOLLOW_UP",
    channel: "EMAIL",
    name: "Follow-up email",
    subject: "Following up on your inquiry",
    body:
      "Hi {{customer_name}},\n\nJust following up on your inquiry regarding {{inquiry_subject}}.\n\n" +
      "We'd be happy to help if you have any questions.\n\nRegards,\n{{employee_name}}\n{{business_name}}",
  },
  {
    key: "FOLLOW_UP",
    channel: "WHATSAPP",
    name: "Follow-up WhatsApp",
    body: "Hi {{customer_name}}, just following up on your inquiry regarding {{inquiry_subject}}. We'd be happy to help if you have any questions. — {{employee_name}}, {{business_name}}",
  },
];

export async function ensureDefaultTemplates(organizationId: string, db: Db = prisma) {
  await db.messageTemplate.createMany({
    data: DEFAULT_TEMPLATES.map((t) => ({ organizationId, ...t, approval: "DRAFT" as const })),
    skipDuplicates: true,
  });
}

export async function listTemplates(ctx: OrgContext) {
  await ensureDefaultTemplates(ctx.organizationId);
  return prisma.messageTemplate.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: [{ key: "asc" }, { channel: "asc" }],
  });
}

/**
 * The template to use for a message. Follow-up step n prefers FOLLOW_UP_<n> and falls back to FOLLOW_UP.
 */
export async function resolveTemplate(db: Db, organizationId: string, key: string, channel: MessageChannel): Promise<MessageTemplate | null> {
  const keys = /^FOLLOW_UP_\d+$/.test(key) ? [key, "FOLLOW_UP"] : [key];
  const found = await db.messageTemplate.findMany({ where: { organizationId, channel, key: { in: keys } } });
  for (const k of keys) {
    const t = found.find((f) => f.key === k);
    if (t) return t;
  }
  return null;
}

/** Saves a template. Any change to an approved template sends it back to draft for re-approval. */
export async function saveTemplate(ctx: OrgContext, raw: SaveTemplateInput, ip?: string | null) {
  assertPermission(ctx, "templates:manage");
  const input = saveTemplateSchema.parse(raw);
  if (input.channel === "EMAIL" && !input.subject) {
    throw Errors.validation("Email templates need a subject.", { subject: "Enter a subject" });
  }
  const settings = await getLeadAutomationSettings(ctx.organizationId);
  const custom = Object.keys(settings.messaging.customVariables);
  const unknown = [...findUnknownVariables(input.body, custom), ...findUnknownVariables(input.subject ?? "", custom)];
  if (unknown.length) {
    throw Errors.validation(`Unknown variable${unknown.length > 1 ? "s" : ""}: ${unknown.map((u) => `{{${u}}}`).join(", ")}`, {
      body: "Check the variable names",
    });
  }
  const existing = await prisma.messageTemplate.findUnique({
    where: { organizationId_key_channel: { organizationId: ctx.organizationId, key: input.key, channel: input.channel } },
  });
  const changed =
    !existing ||
    existing.body !== input.body ||
    (existing.subject ?? undefined) !== (input.subject ?? undefined) ||
    (existing.providerTemplateName ?? undefined) !== input.providerTemplateName ||
    (existing.providerLanguage ?? undefined) !== (input.providerLanguage ?? undefined);

  const template = await prisma.messageTemplate.upsert({
    where: { organizationId_key_channel: { organizationId: ctx.organizationId, key: input.key, channel: input.channel } },
    update: {
      subject: input.subject ?? null,
      body: input.body,
      providerTemplateName: input.providerTemplateName ?? null,
      providerLanguage: input.providerLanguage ?? null,
      ...(changed ? { approval: "DRAFT", approvedAt: null, approvedById: null } : {}),
    },
    create: {
      organizationId: ctx.organizationId,
      key: input.key,
      channel: input.channel,
      name: `${input.key.replaceAll("_", " ").toLowerCase()} ${input.channel.toLowerCase()}`,
      subject: input.subject ?? null,
      body: input.body,
      providerTemplateName: input.providerTemplateName ?? null,
      providerLanguage: input.providerLanguage ?? null,
    },
  });
  if (changed) {
    await audit({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: "template.updated",
      targetType: "template",
      targetId: template.id,
      ip,
      metadata: { key: template.key, channel: template.channel, backToDraft: existing?.approval === "APPROVED" },
    });
  }
  return template;
}

export async function setTemplateApproval(ctx: OrgContext, templateId: string, approved: boolean, ip?: string | null) {
  assertPermission(ctx, "templates:approve");
  const t = await prisma.messageTemplate.findFirst({ where: { id: templateId, organizationId: ctx.organizationId } });
  if (!t) throw Errors.notFound("Template");
  if (approved && t.channel === "EMAIL" && !t.subject) throw Errors.validation("Add a subject before approving this email template.");
  const updated = await prisma.messageTemplate.update({
    where: { id: t.id },
    data: approved
      ? { approval: "APPROVED", approvedAt: new Date(), approvedById: ctx.userId }
      : { approval: "DRAFT", approvedAt: null, approvedById: null },
  });
  await audit({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: approved ? "template.approved" : "template.unapproved",
    targetType: "template",
    targetId: t.id,
    ip,
    metadata: { key: t.key, channel: t.channel },
  });
  return updated;
}

/** Renders a draft template with a real lead (if given and accessible) or sample data. */
export async function previewTemplate(ctx: OrgContext, raw: { subject?: string; body: string; leadId?: string }) {
  const input = previewTemplateSchema.parse(raw);
  const [org, settings] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }),
    getLeadAutomationSettings(ctx.organizationId),
  ]);
  let values = sampleValues(org);
  if (input.leadId) {
    const lead = await findAccessibleLead(ctx, input.leadId);
    const member = lead.assignedMemberId
      ? await prisma.organizationMember.findUnique({ where: { id: lead.assignedMemberId }, include: { user: { select: { name: true } } } })
      : null;
    values = valuesForLead(lead, org, member?.user.name);
  }
  const custom = settings.messaging.customVariables;
  const body = renderTemplate(input.body, values, custom);
  const subject = input.subject ? renderTemplate(input.subject, values, custom) : null;
  return {
    subject: subject?.output ?? null,
    body: body.output,
    missing: [...new Set([...body.missing, ...(subject?.missing ?? [])])],
    unknown: [...new Set([...body.unknown, ...(subject?.unknown ?? [])])],
  };
}
