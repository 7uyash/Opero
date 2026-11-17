import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can, getLeadAutomationSettings, listTemplates } from "@lfm/core";
import { requireAuth } from "@/lib/session";
import { MessagingSettingsForm } from "./messaging-settings-form";
import { TemplateEditor } from "./template-editor";

export const metadata: Metadata = { title: "Messages" };

export default async function MessagesSettingsPage() {
  const { ctx } = await requireAuth();
  if (!can(ctx, "leads:view_all")) notFound();
  const [templates, settings] = await Promise.all([listTemplates(ctx), getLeadAutomationSettings(ctx.organizationId)]);
  const canEdit = can(ctx, "templates:manage");
  const canApprove = can(ctx, "templates:approve");

  return (
    <div className="space-y-6">
      <MessagingSettingsForm canEdit={can(ctx, "automation:configure")} initial={settings.messaging} />
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Message templates</h2>
          <p className="text-sm text-muted-foreground">
            Automatic messages only use <strong>approved</strong> templates. Editing an approved template sends it back to draft until it's approved again.
          </p>
        </div>
        {(["ACKNOWLEDGEMENT", "FOLLOW_UP"] as const).map((key) => (
          <TemplateEditor
            key={key}
            templateKey={key}
            canEdit={canEdit}
            canApprove={canApprove}
            customVariables={Object.keys(settings.messaging.customVariables)}
            templates={templates
              .filter((t) => t.key === key)
              .map((t) => ({
                id: t.id,
                channel: t.channel as "EMAIL" | "WHATSAPP",
                subject: t.subject,
                body: t.body,
                approval: t.approval,
                approvedAt: t.approvedAt?.toISOString() ?? null,
                providerTemplateName: t.providerTemplateName,
                providerLanguage: t.providerLanguage,
              }))}
          />
        ))}
      </section>
    </div>
  );
}
