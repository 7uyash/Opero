"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { BUSINESS_TYPES } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";

type Values = {
  name: string;
  email: string;
  businessType: string;
  website: string;
  timezone: string;
  defaultCountry: string;
};

export function BusinessForm({ initial, canEdit, timezones }: { initial: Values; canEdit: boolean; timezones: string[] }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const { submit, loading, error, fields, success } = useSubmit();
  const set = (k: keyof Values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await submit("/api/organizations", { method: "PATCH", body: values }, "Business details saved.");
    if (ok) router.refresh();
  }

  const types: string[] = [...BUSINESS_TYPES];
  if (values.businessType && !types.includes(values.businessType)) types.unshift(values.businessType);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Business details</CardTitle>
        <CardDescription>
          {canEdit ? "Shown to your team and used in customer messages." : "Only the business owner can change these details."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          {success && <Alert tone="success">{success}</Alert>}
          <fieldset disabled={!canEdit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="name" label="Business name" error={fields.name}>
                <Input id="name" value={values.name} onChange={set("name")} aria-invalid={!!fields.name} />
              </Field>
              <Field id="email" label="Business email" error={fields.email}>
                <Input id="email" type="email" value={values.email} onChange={set("email")} aria-invalid={!!fields.email} />
              </Field>
              <Field id="businessType" label="Business type" optional>
                <Select id="businessType" value={values.businessType} onChange={set("businessType")}>
                  <option value="">Select…</option>
                  {types.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              </Field>
              <Field id="website" label="Website" optional error={fields.website}>
                <Input
                  id="website"
                  type="url"
                  placeholder="https://example.com"
                  value={values.website}
                  onChange={set("website")}
                  aria-invalid={!!fields.website}
                />
              </Field>
              <Field id="timezone" label="Timezone" hint="Follow-ups and working hours use this timezone." error={fields.timezone}>
                <Select id="timezone" value={values.timezone} onChange={set("timezone")}>
                  {timezones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replaceAll("_", " ")}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                id="defaultCountry"
                label="Default country code"
                hint="Used to read phone numbers without a country prefix, e.g. IN, US, GB."
                error={fields.defaultCountry}
              >
                <Input
                  id="defaultCountry"
                  maxLength={2}
                  value={values.defaultCountry}
                  onChange={set("defaultCountry")}
                  aria-invalid={!!fields.defaultCountry}
                  className="uppercase"
                />
              </Field>
            </div>
          </fieldset>
          {canEdit && (
            <div className="flex justify-end">
              <Button type="submit" loading={loading}>
                Save changes
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
