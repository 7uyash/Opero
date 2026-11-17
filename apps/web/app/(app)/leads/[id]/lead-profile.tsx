"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Pencil } from "lucide-react";
import { LEAD_PRIORITIES, PRIORITY_LABELS, type LeadPriority } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";

type Profile = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  subject: string | null;
  inquiry: string | null;
  priority: LeadPriority;
};

export function LeadProfile({ lead, canEdit }: { lead: Profile; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const { submit, loading, error, fields } = useSubmit();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = Object.fromEntries(["name", "email", "phone", "company", "subject", "inquiry", "priority"].map((k) => [k, String(f.get(k) ?? "")]));
    if (await submit(`/api/leads/${lead.id}`, { method: "PATCH", body })) {
      setEditing(false);
      router.refresh();
    }
  }

  if (!editing) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <CardTitle>Customer</CardTitle>
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden /> Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Item label="Email">{lead.email ? <a href={`mailto:${lead.email}`} className="text-primary hover:underline">{lead.email}</a> : "—"}</Item>
            <Item label="Phone">{lead.phone ? <a href={`tel:${lead.phone.replace(/\s/g, "")}`} className="text-primary hover:underline">{lead.phone}</a> : "—"}</Item>
            <Item label="Company">{lead.company ?? "—"}</Item>
            <Item label="Interested in">{lead.subject ?? "—"}</Item>
            <div className="sm:col-span-2">
              <Item label="Inquiry">
                <p className="whitespace-pre-wrap">{lead.inquiry ?? "—"}</p>
              </Item>
            </div>
          </dl>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit customer</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <Field id="name" label="Name" error={fields.name}>
            <Input id="name" name="name" defaultValue={lead.name} aria-invalid={!!fields.name} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="email" label="Email" error={fields.email}>
              <Input id="email" name="email" type="email" defaultValue={lead.email ?? ""} aria-invalid={!!fields.email} />
            </Field>
            <Field id="phone" label="Phone" error={fields.phone}>
              <Input id="phone" name="phone" type="tel" defaultValue={lead.phone ?? ""} aria-invalid={!!fields.phone} />
            </Field>
            <Field id="company" label="Company" optional>
              <Input id="company" name="company" defaultValue={lead.company ?? ""} />
            </Field>
            <Field id="priority" label="Priority">
              <Select id="priority" name="priority" defaultValue={lead.priority}>
                {LEAD_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field id="subject" label="Interested in" optional>
            <Input id="subject" name="subject" defaultValue={lead.subject ?? ""} />
          </Field>
          <Field id="inquiry" label="Inquiry" optional>
            <textarea
              id="inquiry"
              name="inquiry"
              rows={4}
              defaultValue={lead.inquiry ?? ""}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={loading}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
