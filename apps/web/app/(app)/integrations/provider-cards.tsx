"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Facebook, Mail, MessageCircle, Users } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { api, ApiRequestError } from "@/lib/fetcher";
import { useSubmit } from "@/lib/use-submit";
import { CopyField, IntegrationShell, RequiresSetup, type IntegrationStatus } from "./shell";

export type ProviderState = {
  id: string;
  status: IntegrationStatus;
  name: string;
  lastError: string | null;
  lastTestedAt: string | null;
  config: Record<string, unknown>;
} | null;

/** Connect-and-test for form-based providers; shows the provider's own error when the test fails. */
function useConnect() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const run = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setMessage(undefined);
    setFields({});
    try {
      const r = await api<{ test: { ok: boolean; error?: string; detail?: string } }>("/api/integrations/connect", { body });
      setMessage(r.test.ok ? { tone: "success", text: r.test.detail ?? ok } : { tone: "error", text: r.test.error ?? "Connection failed" });
      router.refresh();
      return r.test.ok;
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setMessage({ tone: "error", text: err.body.message });
        setFields(err.body.fields ?? {});
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, message, fields };
}

function DisconnectButton({ id, what }: { id: string; what: string }) {
  const router = useRouter();
  const { submit, loading } = useSubmit();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-destructive"
      loading={loading}
      onClick={async () => {
        if (confirm(`Disconnect ${what}? Saved credentials are deleted.`) && (await submit(`/api/integrations/${id}`, { method: "DELETE" }))) router.refresh();
      }}
    >
      Disconnect
    </Button>
  );
}

// ───────────────────────────── WhatsApp ─────────────────────────────

export function WhatsAppCard({ state, baseUrl, missingEnv }: { state: ProviderState; baseUrl: string; missingEnv: string[] }) {
  const c = useConnect();
  const cfg = state?.config ?? {};
  const connected = state?.status === "CONNECTED";
  const [editing, setEditing] = useState(!state || state.status === "DISCONNECTED");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await c.run(
      { provider: "WHATSAPP_CLOUD", phoneNumberId: f.get("phoneNumberId"), businessAccountId: f.get("businessAccountId"), accessToken: f.get("accessToken") || undefined },
      "Connected.",
    );
    if (ok) setEditing(false);
  }

  return (
    <IntegrationShell
      title="WhatsApp Business"
      description="Send acknowledgements and follow-ups on WhatsApp and turn new WhatsApp chats into leads. Uses the official WhatsApp Business Platform."
      status={state?.status ?? "NOT_CONNECTED"}
      icon={<MessageCircle className="size-5" aria-hidden />}
    >
      {state?.status === "ERROR" && state.lastError && !c.message && <Alert tone="error">{state.lastError}</Alert>}
      {c.message && <Alert tone={c.message.tone}>{c.message.text}</Alert>}
      {missingEnv.length > 0 && (
        <RequiresSetup missing={missingEnv} docs="Sending works without them, but incoming messages and delivery receipts need the Meta app secret and webhook verify token." />
      )}
      {connected && !editing && (
        <p className="text-sm">
          {String(cfg.verifiedName ?? "")} {cfg.displayPhoneNumber ? `· ${String(cfg.displayPhoneNumber)}` : ""}
        </p>
      )}
      {editing ? (
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <p className="text-sm text-muted-foreground">
            In Meta Business Suite → WhatsApp Manager → API setup, copy the Phone number ID and WhatsApp Business Account ID, and create a permanent system-user
            access token with the whatsapp_business_messaging permission.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="phoneNumberId" label="Phone number ID" error={c.fields.phoneNumberId}>
              <Input id="phoneNumberId" name="phoneNumberId" defaultValue={String(cfg.phoneNumberId ?? "")} inputMode="numeric" />
            </Field>
            <Field id="businessAccountId" label="WhatsApp Business Account ID" optional error={c.fields.businessAccountId}>
              <Input id="businessAccountId" name="businessAccountId" defaultValue={String(cfg.businessAccountId ?? "")} inputMode="numeric" />
            </Field>
          </div>
          <Field id="accessToken" label="Access token" hint={state ? "Leave empty to keep the saved token." : "Stored encrypted; never shown again."} error={c.fields.accessToken}>
            <Input id="accessToken" name="accessToken" type="password" autoComplete="off" />
          </Field>
          <div className="flex justify-end gap-2">
            {state && state.status !== "DISCONNECTED" && (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            <Button type="submit" loading={c.busy}>
              Connect and test
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change settings
          </Button>
          {state && <DisconnectButton id={state.id} what="WhatsApp" />}
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Webhook settings for your Meta app</summary>
        <div className="mt-3 space-y-3">
          <CopyField label="Callback URL" value={`${baseUrl}/api/webhooks/whatsapp`} />
          <p className="text-muted-foreground">Verify token: the value of WHATSAPP_WEBHOOK_VERIFY_TOKEN on this server. Subscribe to the “messages” field.</p>
        </div>
      </details>
    </IntegrationShell>
  );
}

// ───────────────────────────── Meta Lead Ads ─────────────────────────────

export function MetaLeadsCard({ state, baseUrl, missingEnv }: { state: ProviderState; baseUrl: string; missingEnv: string[] }) {
  const router = useRouter();
  const select = useSubmit();
  const pages = (state?.config.pages as { id: string; name: string }[] | undefined) ?? [];
  const [page, setPage] = useState(String(state?.config.pageId ?? pages[0]?.id ?? ""));
  const choosing = state && state.status !== "DISCONNECTED" && (!state.config.pageId || state.status === "PENDING");

  return (
    <IntegrationShell
      title="Facebook & Instagram lead forms"
      description="Leads from your Facebook and Instagram lead ads arrive here instantly, with the answers from the form."
      status={state?.status ?? "NOT_CONNECTED"}
      statusLabel={state?.status === "PENDING" ? "Choose a Page" : undefined}
      icon={<Facebook className="size-5" aria-hidden />}
    >
      {missingEnv.length > 0 ? (
        <RequiresSetup missing={missingEnv} docs="Create a Meta app with the leads_retrieval permission (requires Meta App Review), then add its ID and secret to the server settings." />
      ) : (
        <>
          {state?.lastError && <Alert tone={state.status === "ERROR" ? "error" : "info"}>{state.lastError}</Alert>}
          {select.error && <Alert tone="error">{select.error}</Alert>}
          {state?.status === "CONNECTED" && <p className="text-sm">Receiving leads from <strong>{String(state.config.pageName ?? "")}</strong>.</p>}
          {choosing && pages.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <Field id="meta-page" label="Which Facebook Page runs your lead ads?">
                <Select id="meta-page" value={page} onChange={(e) => setPage(e.target.value)} className="w-72">
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                loading={select.loading}
                onClick={async () => {
                  if (await select.submit("/api/integrations/meta/page", { body: { pageId: page } })) router.refresh();
                }}
              >
                Use this Page
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <a href="/api/integrations/oauth/meta" className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
              {state && state.status !== "DISCONNECTED" ? "Reconnect with Facebook" : "Connect with Facebook"}
            </a>
            {state && state.status !== "DISCONNECTED" && <DisconnectButton id={state.id} what="Facebook" />}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Webhook settings for your Meta app</summary>
            <div className="mt-3 space-y-2">
              <CopyField label="Callback URL (Page → leadgen)" value={`${baseUrl}/api/webhooks/meta`} />
              <CopyField label="OAuth redirect URI" value={`${baseUrl}/api/integrations/callback/meta`} />
            </div>
          </details>
        </>
      )}
    </IntegrationShell>
  );
}

// ───────────────────────────── Gmail ─────────────────────────────

export function GmailCard({ state, baseUrl, missingEnv }: { state: ProviderState; baseUrl: string; missingEnv: string[] }) {
  const router = useRouter();
  const save = useSubmit();
  const [createLeads, setCreateLeads] = useState(Boolean(state?.config.createLeadsFromNewEmails));
  const connected = state?.status === "CONNECTED";
  return (
    <IntegrationShell
      title="Gmail / Google Workspace"
      description="Send from your Gmail address and automatically pick up customer replies — and, if you like, turn new emails into leads."
      status={state?.status ?? "NOT_CONNECTED"}
      icon={<Mail className="size-5" aria-hidden />}
    >
      {missingEnv.length > 0 ? (
        <RequiresSetup missing={missingEnv} docs="Create an OAuth client in Google Cloud Console (Gmail API enabled) and add its client ID and secret to the server settings." />
      ) : (
        <>
          {state?.status === "ERROR" && state.lastError && <Alert tone="error">{state.lastError}</Alert>}
          {save.error && <Alert tone="error">{save.error}</Alert>}
          {connected && (
            <>
              <p className="text-sm">
                Connected as <strong>{String(state.config.email ?? "")}</strong>. Replies are checked every minute.
              </p>
              <Toggle
                id="gmail-create"
                label="Create leads from new emails"
                description="Emails from people who aren't leads yet become new leads. Off: only replies from existing leads are recorded."
                checked={createLeads}
                onChange={async (v) => {
                  setCreateLeads(v);
                  if (await save.submit(`/api/integrations/gmail/${state.id}`, { method: "PATCH", body: { createLeadsFromNewEmails: v } })) router.refresh();
                }}
              />
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <a href="/api/integrations/oauth/gmail" className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
              {connected ? "Reconnect Google account" : "Connect with Google"}
            </a>
            {state && state.status !== "DISCONNECTED" && <DisconnectButton id={state.id} what="Gmail" />}
          </div>
          <p className="text-xs text-muted-foreground">
            OAuth redirect URI for your Google client: {baseUrl}/api/integrations/callback/gmail. Public apps using Gmail need Google's verification.
          </p>
        </>
      )}
    </IntegrationShell>
  );
}

// ───────────────────────────── HubSpot ─────────────────────────────

export function HubSpotCard({ state }: { state: ProviderState }) {
  const router = useRouter();
  const c = useConnect();
  const sync = useSubmit();
  const connected = state?.status === "CONNECTED";
  const [editing, setEditing] = useState(!state || state.status === "DISCONNECTED");
  const cfg = state?.config ?? {};

  return (
    <IntegrationShell
      title="HubSpot CRM"
      description="New contacts created in HubSpot are imported as leads (contacts that existed before connecting are left alone)."
      status={state?.status ?? "NOT_CONNECTED"}
      icon={<Users className="size-5" aria-hidden />}
    >
      {state?.status === "ERROR" && state.lastError && !c.message && <Alert tone="error">{state.lastError}</Alert>}
      {c.message && <Alert tone={c.message.tone}>{c.message.text}</Alert>}
      {sync.error && <Alert tone="error">{sync.error}</Alert>}
      {sync.success && <Alert tone="success">{sync.success}</Alert>}
      {connected && !editing && (
        <p className="text-sm text-muted-foreground">
          Checks for new contacts every {String(cfg.syncEveryMinutes ?? 15)} minutes
          {state?.lastTestedAt ? ` · last checked ${new Date(state.lastTestedAt).toLocaleString()}` : ""}.
        </p>
      )}
      {editing ? (
        <form
          className="space-y-3"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            if (await c.run({ provider: "HUBSPOT", accessToken: f.get("accessToken") || undefined, syncEveryMinutes: Number(f.get("syncEveryMinutes")) }, "Connected.")) setEditing(false);
          }}
        >
          <p className="text-sm text-muted-foreground">In HubSpot: Settings → Integrations → Private Apps → Create, with the scope crm.objects.contacts.read. Paste its access token.</p>
          <Field id="hs-token" label="Access token" hint={state ? "Leave empty to keep the saved token." : undefined} error={c.fields.accessToken}>
            <Input id="hs-token" name="accessToken" type="password" autoComplete="off" />
          </Field>
          <Field id="hs-every" label="Check for new contacts every (minutes)">
            <Input id="hs-every" name="syncEveryMinutes" type="number" min={5} defaultValue={Number(cfg.syncEveryMinutes ?? 15)} className="w-32" />
          </Field>
          <div className="flex justify-end gap-2">
            {state && state.status !== "DISCONNECTED" && (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            <Button type="submit" loading={c.busy}>
              Connect and test
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {connected && (
            <Button
              size="sm"
              variant="secondary"
              loading={sync.loading}
              onClick={async () => {
                const r = await sync.submit<{ imported: number }>(`/api/integrations/hubspot/${state!.id}/sync`, { method: "POST" });
                if (r) {
                  sync.setSuccess(r.imported ? `Imported ${r.imported} new lead${r.imported === 1 ? "" : "s"}.` : "No new contacts since the last check.");
                  router.refresh();
                }
              }}
            >
              Check now
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change settings
          </Button>
          {state && <DisconnectButton id={state.id} what="HubSpot" />}
        </div>
      )}
    </IntegrationShell>
  );
}
