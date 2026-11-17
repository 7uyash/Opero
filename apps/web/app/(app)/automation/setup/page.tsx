import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import {
  SETUP_STEPS,
  can,
  getActivationStatus,
  getFollowUpRules,
  getInstallState,
  getLeadAutomationSettings,
  listIntegrations,
  listMembers,
  listTemplates,
  manageableRoles,
  previewRotation,
} from "@lfm/core";
import { LEAD_SOURCE_OPTIONS, type ProviderKey } from "@lfm/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAuth } from "@/lib/session";
import { cn } from "@/lib/utils";
import { IntegrationCards } from "../../integrations/integration-cards";
import { AssignmentForm } from "../../settings/assignment/assignment-form";
import { RulesForm } from "../../settings/follow-ups/rules-form";
import { MessagingSettingsForm } from "../../settings/messages/messaging-settings-form";
import { TemplateEditor } from "../../settings/messages/template-editor";
import { TeamManager } from "../../settings/team/team-manager";
import { ActivationButtons } from "../activation-buttons";
import { SourcePicker } from "./source-picker";
import { WizardNav } from "./wizard-nav";

export const metadata: Metadata = { title: "Set up Lead & Follow-up Manager" };

const TITLES: Record<(typeof SETUP_STEPS)[number], { title: string; description: string }> = {
  sources: { title: "Where do your leads come from?", description: "Pick your sources, then connect them. A source only counts once it has been connected and tested." },
  team: { title: "Who handles leads?", description: "Invite the people who will follow up with customers. Each person gets their own login." },
  assignment: { title: "How are leads shared?", description: "New leads are given to the next available team member in turn." },
  "follow-ups": { title: "When should you follow up?", description: "Reminders for your team — and optional messages to customers — if nobody has heard back." },
  messages: { title: "What do customers receive?", description: "Review and approve the messages. Nothing is sent until you approve a template and turn on automation." },
  review: { title: "Review and turn on", description: "Check everything is ready, then turn on automatic messages." },
};

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { session, ctx } = await requireAuth();
  if (!can(ctx, "automation:configure")) notFound();
  const install = await getInstallState(ctx.organizationId);
  if (!install.installed) redirect("/automation");
  const step = z.coerce.number().int().min(1).max(SETUP_STEPS.length).catch(Math.max(1, install.setupStep)).parse((await searchParams).step);
  const key = SETUP_STEPS[step - 1]!;
  const meta = TITLES[key];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <p className="text-sm text-muted-foreground">
          <Link href="/automation" className="hover:underline">
            Lead &amp; Follow-up Manager
          </Link>{" "}
          · Setup
        </p>
        <h1 className="text-2xl font-semibold">{meta.title}</h1>
        <p className="text-sm text-muted-foreground">{meta.description}</p>
      </header>

      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Setup steps">
        {SETUP_STEPS.map((s, i) => {
          const reachable = i + 1 <= Math.max(install.setupStep, step);
          const label = `${i + 1}. ${s === "follow-ups" ? "Follow-ups" : s[0]!.toUpperCase() + s.slice(1)}`;
          return (
            <li key={s}>
              {reachable ? (
                <Link
                  href={`/automation/setup?step=${i + 1}`}
                  aria-current={i + 1 === step ? "step" : undefined}
                  className={cn("rounded-full border px-3 py-1", i + 1 === step ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted")}
                >
                  {label}
                </Link>
              ) : (
                <span className="rounded-full border border-border px-3 py-1 text-muted-foreground">{label}</span>
              )}
            </li>
          );
        })}
      </ol>

      <StepBody step={key} ctx={ctx} userEmail={session.user.email} />
      <WizardNav step={step} total={SETUP_STEPS.length} />
    </div>
  );
}

async function StepBody({ step, ctx, userEmail }: { step: (typeof SETUP_STEPS)[number]; ctx: Awaited<ReturnType<typeof requireAuth>>["ctx"]; userEmail: string }) {
  switch (step) {
    case "sources": {
      const [settings, integrations] = await Promise.all([getLeadAutomationSettings(ctx.organizationId), listIntegrations(ctx)]);
      const selected = settings.sources.selected;
      const connected = new Set(integrations.filter((i) => i.status === "CONNECTED").map((i) => i.provider));
      const providers = LEAD_SOURCE_OPTIONS.filter((o) => selected.includes(o.key)).flatMap((o) => o.providers as readonly ProviderKey[]);
      return (
        <div className="space-y-4">
          <SourcePicker
            selected={selected}
            options={LEAD_SOURCE_OPTIONS.map((o) => ({
              key: o.key,
              label: o.label,
              state: o.providers.length === 0 ? "ready" : o.providers.some((p) => connected.has(p)) ? "connected" : "not_connected",
            }))}
          />
          {providers.length > 0 && <IntegrationCards ctx={ctx} userEmail={userEmail} providers={[...new Set(providers)]} />}
        </div>
      );
    }
    case "team": {
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
    case "assignment": {
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
    case "follow-ups": {
      const rules = await getFollowUpRules(ctx.organizationId);
      return (
        <RulesForm
          canEdit={can(ctx, "automation:configure")}
          initial={rules.map((r) => ({ name: r.name, delayMinutes: r.delayMinutes, active: r.active, channels: r.channels as ("EMAIL" | "WHATSAPP")[] }))}
        />
      );
    }
    case "messages": {
      const [templates, settings] = await Promise.all([listTemplates(ctx), getLeadAutomationSettings(ctx.organizationId)]);
      return (
        <div className="space-y-6">
          <MessagingSettingsForm canEdit={can(ctx, "automation:configure")} initial={settings.messaging} />
          {(["ACKNOWLEDGEMENT", "FOLLOW_UP"] as const).map((key) => (
            <TemplateEditor
              key={key}
              templateKey={key}
              canEdit={can(ctx, "templates:manage")}
              canApprove={can(ctx, "templates:approve")}
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
        </div>
      );
    }
    case "review": {
      const status = await getActivationStatus(ctx.organizationId);
      return (
        <Card>
          <CardHeader>
            <CardTitle>Ready to go?</CardTitle>
            <CardDescription>
              Leads, assignment and reminders already work. Turning on automation also sends your approved messages to customers automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1 text-sm">
              {status.checks.map((c) => (
                <li key={c.id} className={c.ok ? "text-muted-foreground" : "font-medium"}>
                  {c.ok ? "✓" : c.required ? "○" : "!"} {c.label}
                  {!c.ok && c.href && (
                    <>
                      {" "}
                      —{" "}
                      <Link href={c.href} className="text-primary hover:underline">
                        fix
                      </Link>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {can(ctx, "automation:activate") && <ActivationButtons status={status.status} canActivate={status.canActivate} />}
          </CardContent>
        </Card>
      );
    }
  }
}
