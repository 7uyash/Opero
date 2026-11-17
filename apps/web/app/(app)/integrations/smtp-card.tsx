"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { api, ApiRequestError } from "@/lib/fetcher";

type Integration = {
  id: string;
  status: "NOT_CONNECTED" | "PENDING" | "CONNECTED" | "ERROR" | "DISCONNECTED";
  lastError: string | null;
  lastTestedAt: string | null;
  config: Record<string, string | number | boolean>;
} | null;

const STATUS: Record<string, { label: string; tone: "success" | "danger" | "neutral" | "warning" }> = {
  CONNECTED: { label: "Connected", tone: "success" },
  ERROR: { label: "Needs attention", tone: "danger" },
  DISCONNECTED: { label: "Disconnected", tone: "neutral" },
  NOT_CONNECTED: { label: "Not connected", tone: "neutral" },
  PENDING: { label: "Checking…", tone: "warning" },
};

/** Common providers, so non-technical owners don't need to know server names. */
const PRESETS: Record<string, { host: string; port: number; secure: boolean; hint: string }> = {
  custom: { host: "", port: 587, secure: false, hint: "Ask your email provider for these details." },
  gmail: { host: "smtp.gmail.com", port: 465, secure: true, hint: "Use an app password (Google Account → Security → App passwords)." },
  outlook: { host: "smtp.office365.com", port: 587, secure: false, hint: "Your Microsoft 365 email and password (SMTP must be allowed by your admin)." },
  zoho: { host: "smtp.zoho.com", port: 465, secure: true, hint: "Your Zoho Mail address and password or app password." },
};

export function SmtpCard({ integration, defaults, myEmail }: { integration: Integration; defaults: { fromEmail: string; fromName: string }; myEmail: string }) {
  const router = useRouter();
  const connected = integration?.status === "CONNECTED";
  const [editing, setEditing] = useState(!integration || integration.status === "DISCONNECTED");
  const [preset, setPreset] = useState("custom");
  const cfg = integration?.config ?? {};
  const [form, setForm] = useState({
    host: String(cfg.host ?? ""),
    port: Number(cfg.port ?? 587),
    secure: Boolean(cfg.secure ?? false),
    username: "",
    password: "",
    fromEmail: String(cfg.fromEmail ?? defaults.fromEmail),
    fromName: String(cfg.fromName ?? defaults.fromName),
    replyTo: String(cfg.replyTo ?? ""),
  });
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (k: keyof typeof form, v: string | number | boolean) => setForm((f) => ({ ...f, [k]: v }));

  async function run(label: string, fn: () => Promise<{ test?: { ok: boolean; error?: string; detail?: string } } | void>, ok: string) {
    setBusy(label);
    setMessage(undefined);
    setFields({});
    try {
      const res = await fn();
      if (res && res.test && !res.test.ok) setMessage({ tone: "error", text: res.test.error ?? "Test failed" });
      else setMessage({ tone: "success", text: (res && res.test?.detail) || ok });
      router.refresh();
      return true;
    } catch (err) {
      if (err instanceof ApiRequestError) {
        const test = (err.body as unknown as { test?: { error?: string } }).test;
        setMessage({ tone: "error", text: test?.error ?? err.body.message });
        setFields(err.body.fields ?? {});
      } else setMessage({ tone: "error", text: "Something went wrong." });
      router.refresh();
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  async function onConnect(e: FormEvent) {
    e.preventDefault();
    const ok = await run("connect", () => api("/api/integrations/connect", { body: { provider: "SMTP", ...form } }), "Connected. Your email account works.");
    if (ok) setEditing(false);
  }

  const status = STATUS[integration?.status ?? "NOT_CONNECTED"]!;

  return (
    <Card>
      <CardHeader className="flex flex-col-reverse items-start gap-2 sm:flex-row sm:justify-between sm:gap-4">
        <div className="flex gap-3">
          <Mail className="mt-1 size-5 text-muted-foreground" aria-hidden />
          <div>
            <CardTitle>Email (SMTP)</CardTitle>
            <CardDescription>
              Sends acknowledgements, follow-ups and team notifications from your own business email address.
            </CardDescription>
          </div>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {integration?.status === "ERROR" && integration.lastError && !message && <Alert tone="error">{integration.lastError}</Alert>}
        {message && <Alert tone={message.tone}>{message.text}</Alert>}

        {!editing && integration && (
          <>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Sends as</dt>
                <dd>
                  {String(cfg.fromName)} &lt;{String(cfg.fromEmail)}&gt;
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Server</dt>
                <dd>
                  {String(cfg.host)}:{String(cfg.port)}
                </dd>
              </div>
              {integration.lastTestedAt && (
                <div>
                  <dt className="text-muted-foreground">Last checked</dt>
                  <dd>{new Date(integration.lastTestedAt).toLocaleString()}</dd>
                </div>
              )}
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={busy === "test"} onClick={() => run("test", () => api(`/api/integrations/${integration.id}/test`, { body: {} }), "Connection works.")}>
                Test connection
              </Button>
              {connected && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "send"}
                  onClick={() => run("send", () => api(`/api/integrations/${integration.id}/test`, { body: { sendTo: myEmail } }), `Test email sent to ${myEmail}`)}
                >
                  Send me a test email
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Change settings
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                loading={busy === "disconnect"}
                onClick={() => {
                  if (confirm("Disconnect email? Automatic emails stop until you connect again.")) {
                    void run("disconnect", () => api(`/api/integrations/${integration.id}`, { method: "DELETE" }), "Disconnected.");
                  }
                }}
              >
                Disconnect
              </Button>
            </div>
          </>
        )}

        {editing && (
          <form onSubmit={onConnect} className="space-y-4" noValidate>
            <Field id="preset" label="Email provider">
              <Select
                id="preset"
                value={preset}
                onChange={(e) => {
                  const p = PRESETS[e.target.value]!;
                  setPreset(e.target.value);
                  if (e.target.value !== "custom") setForm((f) => ({ ...f, host: p.host, port: p.port, secure: p.secure }));
                }}
              >
                <option value="custom">Other / custom</option>
                <option value="gmail">Google Workspace / Gmail</option>
                <option value="outlook">Microsoft 365 / Outlook</option>
                <option value="zoho">Zoho Mail</option>
              </Select>
            </Field>
            <p className="text-sm text-muted-foreground">{PRESETS[preset]!.hint}</p>
            <div className="grid gap-4 sm:grid-cols-[1fr_7rem_10rem]">
              <Field id="host" label="SMTP server" error={fields.host}>
                <Input id="host" value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.example.com" />
              </Field>
              <Field id="port" label="Port" error={fields.port}>
                <Input id="port" type="number" value={form.port} onChange={(e) => set("port", Number(e.target.value))} />
              </Field>
              <Field id="secure" label="Security">
                <Select id="secure" value={form.secure ? "tls" : "starttls"} onChange={(e) => set("secure", e.target.value === "tls")}>
                  <option value="starttls">STARTTLS (587)</option>
                  <option value="tls">SSL/TLS (465)</option>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="username" label="Username" optional>
                <Input id="username" autoComplete="off" value={form.username} onChange={(e) => set("username", e.target.value)} placeholder="usually your email address" />
              </Field>
              <Field id="password" label="Password" optional hint={integration ? "Leave empty to keep the saved password." : undefined}>
                <Input id="password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => set("password", e.target.value)} />
              </Field>
              <Field id="fromName" label="Sender name" error={fields.fromName}>
                <Input id="fromName" value={form.fromName} onChange={(e) => set("fromName", e.target.value)} />
              </Field>
              <Field id="fromEmail" label="Sender email" error={fields.fromEmail}>
                <Input id="fromEmail" type="email" value={form.fromEmail} onChange={(e) => set("fromEmail", e.target.value)} />
              </Field>
              <Field id="replyTo" label="Replies go to" optional hint="Defaults to the sender email." error={fields.replyTo}>
                <Input id="replyTo" type="email" value={form.replyTo} onChange={(e) => set("replyTo", e.target.value)} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">Your password is encrypted and never shown again.</p>
            <div className="flex justify-end gap-2">
              {integration && integration.status !== "DISCONNECTED" && (
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
              <Button type="submit" loading={busy === "connect"}>
                Connect and test
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
