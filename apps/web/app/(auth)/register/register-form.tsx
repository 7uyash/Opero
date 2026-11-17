"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { BUSINESS_TYPES } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { api, ApiRequestError } from "@/lib/fetcher";

const FIELDS = ["name", "email", "password", "businessName", "businessEmail", "businessType", "website", "timezone"];

export function RegisterForm({ timezones }: { timezones: string[] }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const [timezone, setTimezone] = useState("UTC");

  // Default to the browser's timezone.
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && timezones.includes(tz)) setTimezone(tz);
  }, [timezones]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = Object.fromEntries(FIELDS.map((k) => [k, String(f.get(k) ?? "")]));
    setLoading(true);
    setError(undefined);
    setFields({});
    try {
      await api("/api/auth/register", { body });
      router.replace("/dashboard");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.body.message);
        setFields(err.body.fields ?? {});
      } else setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  const invalid = (k: string) => ({
    "aria-invalid": !!fields[k],
    "aria-describedby": fields[k] ? `${k}-error` : undefined,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your business account</CardTitle>
        <CardDescription>It takes about a minute. You can invite your team right after.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-6" noValidate>
          {error && <Alert tone="error">{error}</Alert>}

          <fieldset className="space-y-4">
            <legend className="mb-2 text-sm font-semibold text-muted-foreground">About you</legend>
            <Field id="name" label="Your name" error={fields.name}>
              <Input id="name" name="name" autoComplete="name" required {...invalid("name")} />
            </Field>
            <Field id="email" label="Your email" hint="You'll use this to sign in." error={fields.email}>
              <Input id="email" name="email" type="email" autoComplete="email" required {...invalid("email")} />
            </Field>
            <Field
              id="password"
              label="Password"
              hint="At least 10 characters, with a letter and a number."
              error={fields.password}
            >
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                {...invalid("password")}
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="mb-2 text-sm font-semibold text-muted-foreground">About your business</legend>
            <Field id="businessName" label="Business name" error={fields.businessName}>
              <Input id="businessName" name="businessName" autoComplete="organization" required {...invalid("businessName")} />
            </Field>
            <Field
              id="businessEmail"
              label="Business email"
              hint="Used as the sender address for customer emails."
              error={fields.businessEmail}
            >
              <Input id="businessEmail" name="businessEmail" type="email" required {...invalid("businessEmail")} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="businessType" label="Business type" optional error={fields.businessType}>
                <Select id="businessType" name="businessType" defaultValue="">
                  <option value="">Select…</option>
                  {BUSINESS_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="timezone" label="Timezone" error={fields.timezone}>
                <Select id="timezone" name="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {timezones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replaceAll("_", " ")}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field id="website" label="Website" optional error={fields.website}>
              <Input id="website" name="website" type="url" placeholder="https://example.com" {...invalid("website")} />
            </Field>
          </fieldset>

          <Button type="submit" className="w-full" size="lg" loading={loading}>
            Create account
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
