"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { CHANNEL_LABELS, TEMPLATE_KEY_LABELS, TEMPLATE_VARIABLES, type MessageChannel } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/fetcher";
import { useSubmit } from "@/lib/use-submit";
import { cn } from "@/lib/utils";

type Template = {
  id: string;
  channel: MessageChannel;
  subject: string | null;
  body: string;
  approval: "DRAFT" | "APPROVED";
  approvedAt: string | null;
  providerTemplateName: string | null;
  providerLanguage: string | null;
};

export function TemplateEditor({
  templateKey,
  templates,
  canEdit,
  canApprove,
  customVariables,
}: {
  templateKey: string;
  templates: Template[];
  canEdit: boolean;
  canApprove: boolean;
  customVariables: string[];
}) {
  const router = useRouter();
  const channels = (["EMAIL", "WHATSAPP"] as const).filter((c) => templates.some((t) => t.channel === c));
  const [channel, setChannel] = useState<MessageChannel>(channels[0] ?? "EMAIL");
  const t = templates.find((x) => x.channel === channel)!;
  const [subject, setSubject] = useState(t.subject ?? "");
  const [body, setBody] = useState(t.body);
  const [waName, setWaName] = useState(t.providerTemplateName ?? "");
  const [waLang, setWaLang] = useState(t.providerLanguage ?? "en");
  const [preview, setPreview] = useState<{ subject: string | null; body: string; unknown: string[] }>();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const { submit, loading, error, fields, success, setSuccess } = useSubmit();

  // Reset the form when switching channel or after a save refreshed the data.
  useEffect(() => {
    setSubject(t.subject ?? "");
    setBody(t.body);
    setWaName(t.providerTemplateName ?? "");
    setWaLang(t.providerLanguage ?? "en");
  }, [t.id, t.subject, t.body, t.providerTemplateName, t.providerLanguage]);

  // Live preview with sample data.
  useEffect(() => {
    const h = setTimeout(async () => {
      try {
        setPreview(await api("/api/messages/templates/preview", { body: { subject: channel === "EMAIL" ? subject : undefined, body } }));
      } catch {
        /* preview is best effort */
      }
    }, 300);
    return () => clearTimeout(h);
  }, [subject, body, channel]);

  const dirty = body !== t.body || (subject || null) !== (t.subject || null) || (waName || null) !== (t.providerTemplateName || null);

  function insert(variable: string) {
    const el = bodyRef.current;
    const token = `{{${variable}}}`;
    if (!el) return setBody((b) => b + token);
    const [s, e] = [el.selectionStart, el.selectionEnd];
    const next = body.slice(0, s) + token + body.slice(e);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  }

  const saveRequest = () =>
    submit(
      "/api/messages/templates",
      {
        method: "PUT",
        body: {
          key: templateKey,
          channel,
          subject: channel === "EMAIL" ? subject : undefined,
          body,
          providerTemplateName: channel === "WHATSAPP" ? waName : undefined,
          providerLanguage: channel === "WHATSAPP" ? waLang : undefined,
        },
      },
      t.approval === "APPROVED" ? "Saved. Approve it again to use it for automatic messages." : "Saved.",
    );

  async function save() {
    if (await saveRequest()) router.refresh();
  }

  async function approve(approved: boolean) {
    // "Save and approve": save the edits first; stop if saving failed (e.g. unknown variable).
    if (dirty && approved && !(await saveRequest())) return;
    if (await submit(`/api/messages/templates/${t.id}/approve`, { body: { approved } }, approved ? "Approved — automatic messages will use it." : "Moved back to draft.")) {
      router.refresh();
    }
  }

  const meta = TEMPLATE_KEY_LABELS[templateKey]!;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">{meta.label}</CardTitle>
          <CardDescription>{meta.description}</CardDescription>
        </div>
        <div role="tablist" className="flex gap-1 rounded-md bg-muted p-1 text-sm">
          {channels.map((c) => {
            const tc = templates.find((x) => x.channel === c)!;
            return (
              <button
                key={c}
                role="tab"
                aria-selected={channel === c}
                onClick={() => {
                  setChannel(c);
                  setSuccess(undefined);
                }}
                className={cn("flex items-center gap-1.5 rounded px-3 py-1", channel === c ? "bg-background font-medium shadow-xs" : "text-muted-foreground")}
              >
                {CHANNEL_LABELS[c]}
                {tc.approval === "APPROVED" && <CheckCircle2 className="size-3.5 text-success" aria-label="approved" />}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              {t.approval === "APPROVED" ? <Badge tone="success">Approved</Badge> : <Badge tone="warning">Draft — not used yet</Badge>}
              {dirty && <span className="text-muted-foreground">Unsaved changes</span>}
            </div>
            {channel === "EMAIL" && (
              <Field id={`${templateKey}-subject`} label="Subject" error={fields.subject}>
                <Input id={`${templateKey}-subject`} value={subject} disabled={!canEdit} onChange={(e) => setSubject(e.target.value)} />
              </Field>
            )}
            <Field id={`${templateKey}-body`} label="Message" error={fields.body}>
              <textarea
                id={`${templateKey}-body`}
                ref={bodyRef}
                rows={9}
                value={body}
                disabled={!canEdit}
                onChange={(e) => setBody(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:outline-2 focus-visible:outline-ring"
              />
            </Field>
            {canEdit && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Insert a detail:</p>
                <div className="flex flex-wrap gap-1">
                  {[...Object.entries(TEMPLATE_VARIABLES).map(([k, v]) => [k, v.label] as const), ...customVariables.map((k) => [k, k] as const)].map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => insert(k)}
                      className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-muted"
                      title={`{{${k}}}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {channel === "WHATSAPP" && (
              <div className="space-y-2 rounded-md border border-border p-3 text-sm">
                <p className="text-muted-foreground">
                  WhatsApp only lets businesses start a conversation with a template approved by Meta. Create it in WhatsApp Manager, then enter its exact
                  name here. Within 24 hours of the customer's last message, the text above is sent as is.
                </p>
                <div className="grid gap-2 sm:grid-cols-[1fr_6rem]">
                  <Input aria-label="WhatsApp template name" placeholder="e.g. inquiry_received" value={waName} disabled={!canEdit} onChange={(e) => setWaName(e.target.value)} aria-invalid={!!fields.providerTemplateName} />
                  <Input aria-label="Language code" value={waLang} disabled={!canEdit} onChange={(e) => setWaLang(e.target.value)} />
                </div>
                {fields.providerTemplateName && <p className="text-destructive">{fields.providerTemplateName}</p>}
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Preview with sample details</p>
            <div className="rounded-md border border-border bg-muted/40 p-4 text-sm">
              {channel === "EMAIL" && <p className="mb-2 border-b border-border pb-2 font-medium">{preview?.subject ?? subject}</p>}
              <p className="whitespace-pre-wrap">{preview?.body ?? body}</p>
            </div>
            {preview && preview.unknown.length > 0 && (
              <p className="mt-2 text-sm text-destructive">Unknown: {preview.unknown.map((u) => `{{${u}}}`).join(", ")}</p>
            )}
          </div>
        </div>

        {error && <div className="mt-4"><Alert tone="error">{error}</Alert></div>}
        {success && <div className="mt-4"><Alert tone="success">{success}</Alert></div>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {canEdit && (
            <Button variant="secondary" onClick={save} loading={loading} disabled={!dirty}>
              Save draft
            </Button>
          )}
          {canApprove &&
            (t.approval === "APPROVED" && !dirty ? (
              <Button variant="ghost" onClick={() => approve(false)} disabled={loading}>
                Stop using this template
              </Button>
            ) : (
              <Button onClick={() => approve(true)} loading={loading}>
                {dirty ? "Save and approve" : "Approve"}
              </Button>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
