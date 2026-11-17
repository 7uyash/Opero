import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Circle, AlertTriangle } from "lucide-react";
import { SETUP_STEPS, can, getActivationStatus, getInstallState, getLeadAutomationSettings } from "@lfm/core";
import { CHANNEL_LABELS } from "@lfm/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAuth } from "@/lib/session";
import { ActivationButtons } from "./activation-buttons";
import { InstallButton } from "./install-button";

export const metadata: Metadata = { title: "Automation" };

const STATUS = {
  ACTIVE: { label: "On", tone: "success" as const, text: "Approved messages are being sent automatically." },
  PAUSED: { label: "Paused", tone: "warning" as const, text: "Automatic messages are paused. Leads, assignment and reminders keep working." },
  DRAFT: { label: "Not turned on yet", tone: "neutral" as const, text: "Finish the checklist, then turn on automatic messages." },
};

export default async function AutomationPage() {
  const { ctx } = await requireAuth();
  if (!can(ctx, "leads:view_all")) notFound();
  const [status, settings, install] = await Promise.all([
    getActivationStatus(ctx.organizationId),
    getLeadAutomationSettings(ctx.organizationId),
    getInstallState(ctx.organizationId),
  ]);

  // Marketplace card: the automation hasn't been installed for this business yet.
  if (!install.installed) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Automations</h1>
          <p className="text-sm text-muted-foreground">Ready-made automations for your business. Install one to set it up step by step.</p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Lead &amp; Follow-up Manager</CardTitle>
            <CardDescription>Automatically capture leads, assign employees, communicate with customers and manage follow-ups.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
              <li>• Website, email, WhatsApp, Facebook/Instagram and CRM leads</li>
              <li>• Fair round-robin assignment</li>
              <li>• Follow-up reminders on a schedule</li>
              <li>• Approved email & WhatsApp messages</li>
            </ul>
            {can(ctx, "automation:configure") ? <InstallButton /> : <p className="text-sm text-muted-foreground">Ask the business owner to install it.</p>}
          </CardContent>
        </Card>
      </div>
    );
  }
  const s = STATUS[status.status];
  const m = settings.messaging;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {install.setupStep < SETUP_STEPS.length && can(ctx, "automation:configure") && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-blue-50/50 p-4 text-sm">
          <span>Setup is {Math.round(((install.setupStep - 1) / SETUP_STEPS.length) * 100)}% done.</span>
          <Link href={`/automation/setup?step=${install.setupStep}`} className="font-medium text-primary hover:underline">
            Continue setup →
          </Link>
        </div>
      )}
      <header>
        <h1 className="text-2xl font-semibold">Lead &amp; Follow-up Manager</h1>
        <p className="text-sm text-muted-foreground">Capture leads, assign your team, message customers and never miss a follow-up.</p>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Automatic messages</CardTitle>
            <CardDescription>{s.text}</CardDescription>
          </div>
          <Badge tone={s.tone}>{s.label}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2 text-sm">
            {status.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-3">
                {c.ok ? (
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-label="Done" />
                ) : c.required ? (
                  <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-label="To do" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-label="Recommended" />
                )}
                <div>
                  {c.href && !c.ok ? (
                    <Link href={c.href} className="font-medium text-primary hover:underline">
                      {c.label}
                    </Link>
                  ) : (
                    <span className={c.ok ? "text-muted-foreground" : "font-medium"}>{c.label}</span>
                  )}
                  {!c.required && !c.ok && <span className="ml-2 text-xs text-muted-foreground">(recommended)</span>}
                  {c.detail && !c.ok && <p className="text-muted-foreground">{c.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
          {can(ctx, "automation:activate") ? (
            <ActivationButtons status={status.status} canActivate={status.canActivate} />
          ) : (
            <p className="text-sm text-muted-foreground">Only owners and admins can turn automatic messages on or off.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What happens automatically</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm">
            <li>
              <span className="font-medium">New lead → assigned to the next team member in turn.</span>{" "}
              <Link href="/settings/assignment" className="text-primary hover:underline">
                Change
              </Link>
            </li>
            <li>
              <span className="font-medium">
                {m.acknowledgement.enabled
                  ? `Acknowledgement sent by ${m.acknowledgement.channels.map((c) => CHANNEL_LABELS[c].toLowerCase()).join(" and ")}.`
                  : "No acknowledgement is sent."}
              </span>{" "}
              <Link href="/settings/messages" className="text-primary hover:underline">
                Change
              </Link>
            </li>
            <li>
              <span className="font-medium">Follow-up reminders on a schedule, with follow-up messages to the customer {m.followUpMessages.enabled ? "turned on" : "turned off"}.</span>{" "}
              <Link href="/settings/follow-ups" className="text-primary hover:underline">
                Change
              </Link>
            </li>
            <li>
              <span className="font-medium">
                Messages go out {m.sendingHours.mode === "ALWAYS" ? "at any time" : m.sendingHours.mode === "CUSTOM" ? "during your custom sending hours" : "during working hours"}
                {m.fallbackChannel ? `, falling back to ${CHANNEL_LABELS[m.fallbackChannel].toLowerCase()} if needed` : ""}.
              </span>
            </li>
            <li className="text-muted-foreground">
              Everything stops when the customer replies, opts out, converts or is marked lost. See every step in{" "}
              <Link href="/activity" className="text-primary hover:underline">
                Automation activity
              </Link>
              .
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
