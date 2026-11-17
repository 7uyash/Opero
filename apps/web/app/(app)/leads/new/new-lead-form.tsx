"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { LEAD_PRIORITIES, LEAD_STATUS_LABELS, PRIORITY_LABELS, type LeadStatus } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { api, ApiRequestError } from "@/lib/fetcher";

type Duplicate = { id: string; name: string; email: string | null; phone: string | null; status: LeadStatus; assignedTo: string | null; matchedOn: string[] };

export function NewLeadForm({
  canAssign,
  members,
  autoLabel,
}: {
  canAssign: boolean;
  members: { id: string; name: string; isAvailable: boolean }[];
  autoLabel: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = useState<Duplicate>();

  async function send(onDuplicate: "check" | "merge" | "create") {
    const f = new FormData(formRef.current!);
    const body: Record<string, unknown> = { onDuplicate };
    for (const k of ["name", "email", "phone", "company", "subject", "inquiry", "priority"]) body[k] = String(f.get(k) ?? "");
    if (canAssign) {
      const a = String(f.get("assignedMemberId") ?? "");
      // "auto" → omit so the server uses round-robin; "" → unassigned queue.
      if (a !== "auto") body.assignedMemberId = a === "" ? null : a;
    }
    setLoading(true);
    setError(undefined);
    setFields({});
    try {
      const res = await api<{ lead: { id: string } }>("/api/leads", { body });
      router.push(`/leads/${res.lead.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.body.code === "DUPLICATE_FOUND") {
          setDuplicate((err.body.details as { duplicate: Duplicate }).duplicate);
        } else {
          setError(err.body.message);
          setFields(err.body.fields ?? {});
        }
      } else setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setDuplicate(undefined);
    void send("check");
  }

  const inv = (k: string) => ({ "aria-invalid": !!fields[k] });

  return (
    <Card>
      <CardContent className="pt-6">
        <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <Field id="name" label="Customer name" error={fields.name}>
            <Input id="name" name="name" required {...inv("name")} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="email" label="Email" error={fields.email} hint="Email or phone is required.">
              <Input id="email" name="email" type="email" {...inv("email")} />
            </Field>
            <Field id="phone" label="Phone" error={fields.phone} hint="Local numbers use your business's country.">
              <Input id="phone" name="phone" type="tel" {...inv("phone")} />
            </Field>
          </div>
          <Field id="company" label="Company" optional>
            <Input id="company" name="company" />
          </Field>
          <Field id="subject" label="What are they interested in?" optional>
            <Input id="subject" name="subject" placeholder="e.g. Website redesign" />
          </Field>
          <Field id="inquiry" label="Inquiry details" optional>
            <textarea
              id="inquiry"
              name="inquiry"
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="priority" label="Priority">
              <Select id="priority" name="priority" defaultValue="NORMAL">
                {LEAD_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            {canAssign ? (
              <Field id="assignedMemberId" label="Assign to" error={fields.assignedMemberId}>
                <Select id="assignedMemberId" name="assignedMemberId" defaultValue="auto">
                  <option value="auto">{autoLabel}</option>
                  <option value="">Leave unassigned</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.isAvailable ? "" : " (away)"}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <p className="self-end pb-2 text-sm text-muted-foreground">This lead will be assigned to you.</p>
            )}
          </div>

          {duplicate && (
            <Alert tone="info">
              <p className="font-medium">This looks like an existing lead</p>
              <p className="mt-1">
                <Link href={`/leads/${duplicate.id}`} className="text-primary hover:underline" target="_blank">
                  {duplicate.name}
                </Link>{" "}
                ({[duplicate.email, duplicate.phone].filter(Boolean).join(" · ")}) has the same {duplicate.matchedOn.join(" and ")}. Status:{" "}
                {LEAD_STATUS_LABELS[duplicate.status]}
                {duplicate.assignedTo ? `, assigned to ${duplicate.assignedTo}` : ", unassigned"}.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" loading={loading} onClick={() => send("merge")}>
                  Add to existing lead
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={loading} onClick={() => send("create")}>
                  Create a separate lead
                </Button>
              </div>
            </Alert>
          )}

          {!duplicate && (
            <div className="flex justify-end gap-2">
              <Link href="/leads" className="inline-flex h-10 items-center px-4 text-sm text-muted-foreground hover:text-foreground">
                Cancel
              </Link>
              <Button type="submit" loading={loading}>
                Add lead
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
