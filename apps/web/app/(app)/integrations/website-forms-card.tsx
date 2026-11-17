"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Globe } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";
import { CopyField, IntegrationShell, type IntegrationStatus } from "./shell";

type Form = { id: string; name: string; status: IntegrationStatus; webhookKey: string; allowedOrigins: string[]; lastError: string | null };

export function WebsiteFormsCard({ forms, baseUrl }: { forms: Form[]; baseUrl: string }) {
  const router = useRouter();
  const create = useSubmit();
  const [secret, setSecret] = useState<{ id: string; value: string }>();
  const active = forms.filter((f) => f.status !== "DISCONNECTED");
  const status: IntegrationStatus = active.some((f) => f.status === "CONNECTED") ? "CONNECTED" : active.length ? "PENDING" : "NOT_CONNECTED";

  return (
    <IntegrationShell
      title="Website form"
      description="Capture inquiries from your website — use our ready-made form, or send submissions from your own form or backend."
      status={status}
      statusLabel={status === "PENDING" ? "Waiting for first submission" : undefined}
      icon={<Globe className="size-5" aria-hidden />}
    >
      {create.error && <Alert tone="error">{create.error}</Alert>}
      {active.length === 0 && <p className="text-sm text-muted-foreground">No website form yet.</p>}
      {active.map((f) => (
        <FormDetails key={f.id} form={f} baseUrl={baseUrl} newSecret={secret?.id === f.id ? secret.value : undefined} onSecret={(value) => setSecret({ id: f.id, value })} />
      ))}
      <Button
        variant={active.length ? "secondary" : "primary"}
        loading={create.loading}
        onClick={async () => {
          const r = await create.submit<{ integration: { id: string }; secret: string }>("/api/integrations/website", {
            body: { name: active.length ? `Website form ${active.length + 1}` : "Website form" },
          });
          if (r) {
            setSecret({ id: r.integration.id, value: r.secret });
            router.refresh();
          }
        }}
      >
        {active.length ? "Add another form" : "Create a website form"}
      </Button>
    </IntegrationShell>
  );
}

function FormDetails({ form, baseUrl, newSecret, onSecret }: { form: Form; baseUrl: string; newSecret?: string; onSecret: (s: string) => void }) {
  const router = useRouter();
  const action = useSubmit();
  const [tab, setTab] = useState<"hosted" | "html" | "server">("hosted");
  const [origins, setOrigins] = useState(form.allowedOrigins.join(", "));
  const hosted = `${baseUrl}/f/${form.webhookKey}`;
  const formEndpoint = `${baseUrl}/api/webhooks/website/${form.webhookKey}/form`;
  const serverEndpoint = `${baseUrl}/api/webhooks/website/${form.webhookKey}`;

  const iframe = `<iframe src="${hosted}" title="Contact form" style="width:100%;max-width:520px;height:640px;border:0"></iframe>`;
  const html = `<form id="lfm-form">
  <input name="name" placeholder="Your name" required>
  <input name="email" type="email" placeholder="Email">
  <input name="phone" placeholder="Phone">
  <textarea name="message" placeholder="How can we help?"></textarea>
  <label><input type="checkbox" name="whatsapp_opt_in"> Contact me on WhatsApp</label>
  <input name="lfm_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
  <button type="submit">Send</button>
</form>
<script>
  (function () {
    var f = document.getElementById("lfm-form"), started = Date.now();
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var data = Object.fromEntries(new FormData(f));
      data.lfm_started = started; data.page_url = location.href;
      data.submission_id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
      fetch("${formEndpoint}", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
        .then(function (r) { return r.json(); })
        .then(function (r) { f.innerHTML = "<p>" + (r.message || (r.error && r.error.message) || "Thank you!") + "</p>"; });
    });
  })();
</script>`;
  const curl = `BODY='{"name":"Rahul Sharma","email":"rahul@example.com","message":"Need a website"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$LFM_SECRET" | sed 's/^.* //')
curl -X POST "${serverEndpoint}" \\
  -H "Content-Type: application/json" -H "X-LFM-Timestamp: $TS" \\
  -H "X-LFM-Signature: sha256=$SIG" -H "Idempotency-Key: <your submission id>" \\
  -d "$BODY"`;

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{form.name}</p>
        <span className="text-xs text-muted-foreground">{form.status === "CONNECTED" ? "Receiving leads" : "No submissions yet"}</span>
      </div>
      {newSecret && (
        <Alert tone="success">
          <p className="mb-2">Your signing secret — copy it now, it won't be shown again. Only needed for “From your server”.</p>
          <CopyField label="Signing secret" value={newSecret} secret />
        </Alert>
      )}
      {action.error && <Alert tone="error">{action.error}</Alert>}
      {action.success && <Alert tone="success">{action.success}</Alert>}

      <div role="tablist" className="flex gap-1 text-sm">
        {(
          [
            ["hosted", "Ready-made form"],
            ["html", "Your own HTML form"],
            ["server", "From your server"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1 ${tab === k ? "bg-muted font-medium" : "text-muted-foreground"}`}>
            {l}
          </button>
        ))}
      </div>
      {tab === "hosted" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Share the link, or paste the embed code into your website builder (WordPress, Wix, Webflow…).{" "}
            <a href={hosted} target="_blank" rel="noreferrer" className="text-primary hover:underline">
              Open the form
            </a>
          </p>
          <CopyField label="Form link" value={hosted} />
          <CopyField label="Embed code" value={iframe} multiline />
        </div>
      )}
      {tab === "html" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Rename the fields to match your design; we recognise common names like name, email, phone and message.</p>
          <CopyField label="HTML + script" value={html} multiline />
          <div className="space-y-1">
            <label htmlFor={`origins-${form.id}`} className="text-sm font-medium">
              Websites allowed to use this form
            </label>
            <div className="flex gap-2">
              <Input id={`origins-${form.id}`} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://www.example.com, https://example.com" />
              <Button
                variant="secondary"
                loading={action.loading}
                onClick={async () => {
                  const allowedOrigins = origins.split(",").map((s) => s.trim()).filter(Boolean);
                  if (await action.submit(`/api/integrations/website/${form.id}`, { method: "PATCH", body: { allowedOrigins } }, "Saved.")) router.refresh();
                }}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Leave empty to accept any site. Spam protection (hidden field, timing, rate limits) always applies.</p>
          </div>
        </div>
      )}
      {tab === "server" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            For developers: sign each request with your secret. Requests older than 5 minutes are rejected; resending with the same Idempotency-Key never
            creates a second lead.
          </p>
          <CopyField label="Endpoint" value={serverEndpoint} />
          <CopyField label="Example" value={curl} multiline />
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button
          size="sm"
          variant="secondary"
          loading={action.loading}
          onClick={async () => {
            const r = await action.submit<{ outcome: string; leadId: string }>(`/api/integrations/website/${form.id}/test`, { method: "POST" });
            if (r) {
              action.setSuccess(r.outcome === "merged" ? "Test received — added to your existing test lead." : "Test received — a test lead was created (check Leads).");
              router.refresh();
            }
          }}
        >
          Send a test submission
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            if (!confirm("Create a new signing secret? Anything using the old one stops working.")) return;
            const r = await action.submit<{ secret: string }>(`/api/integrations/website/${form.id}/rotate`, { method: "POST" });
            if (r) onSecret(r.secret);
          }}
        >
          New signing secret
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={async () => {
            if (!confirm("Stop accepting submissions from this form?")) return;
            if (await action.submit(`/api/integrations/${form.id}`, { method: "DELETE" })) router.refresh();
          }}
        >
          Turn off
        </Button>
      </div>
    </div>
  );
}
