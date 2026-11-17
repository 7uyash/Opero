"use client";

import { useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function HostedForm({
  formKey,
  businessName,
  title,
  successMessage,
  askCompany,
  whatsAppOptInLabel,
}: {
  formKey: string;
  businessName: string;
  title: string;
  successMessage: string;
  askCompany: boolean;
  whatsAppOptInLabel: string | null;
}) {
  const started = useRef(Date.now());
  // One id per page load: a double click or network retry can't create two leads.
  const submissionId = useRef(typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(successMessage);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const data = Object.fromEntries(f) as Record<string, unknown>;
    if (!data.email && !data.phone) return setError("Please enter an email address or a phone number.");
    data.lfm_started = started.current;
    data.submission_id = submissionId.current;
    data.page_url = document.referrer || location.href;
    setState("sending");
    setError(undefined);
    try {
      const res = await fetch(`/api/webhooks/website/${encodeURIComponent(formKey)}/form`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error?.message ?? "Something went wrong. Please try again.");
      setDone(j?.message ?? successMessage);
      setState("done");
    } catch (err) {
      setError((err as Error).message);
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <div className="rounded-lg border border-border p-6">
        <h1 className="text-lg font-semibold">Thank you!</h1>
        <p className="mt-2 text-sm text-muted-foreground">{done}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-border p-6" noValidate>
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{businessName} will get back to you shortly.</p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <Field id="name" label="Your name">
        <Input id="name" name="name" required autoComplete="name" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="email" label="Email">
          <Input id="email" name="email" type="email" autoComplete="email" />
        </Field>
        <Field id="phone" label="Phone">
          <Input id="phone" name="phone" type="tel" autoComplete="tel" />
        </Field>
      </div>
      {askCompany && (
        <Field id="company" label="Company" optional>
          <Input id="company" name="company" autoComplete="organization" />
        </Field>
      )}
      <Field id="message" label="How can we help?">
        <textarea id="message" name="message" rows={4} className="w-full rounded-md border border-input px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring" />
      </Field>
      {whatsAppOptInLabel && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="whatsapp_opt_in" className="mt-0.5 size-4 accent-primary" />
          {whatsAppOptInLabel}
        </label>
      )}
      {/* Honeypot: hidden from people, filled in by bots. */}
      <input name="lfm_hp" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 opacity-0" />
      <Button type="submit" className="w-full" loading={state === "sending"}>
        Send
      </Button>
    </form>
  );
}
