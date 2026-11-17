"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";

type Invite = { organizationName: string; email: string; name: string | null; role: Role; hasAccount: boolean };

export function AcceptForm({ token, invite }: { token: string; invite: Invite }) {
  const router = useRouter();
  const { submit, loading, error, fields } = useSubmit();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const res = await submit("/api/invitations/accept", {
      body: { token, password: f.get("password"), ...(invite.hasAccount ? {} : { name: f.get("name") }) },
    });
    if (res) {
      router.replace("/dashboard");
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Join {invite.organizationName}</CardTitle>
        <CardDescription>
          You've been invited as <strong>{ROLE_LABELS[invite.role]}</strong>. {ROLE_DESCRIPTIONS[invite.role]}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <Field id="email" label="Email">
            <Input id="email" value={invite.email} readOnly disabled />
          </Field>
          {invite.hasAccount ? (
            <Field id="password" label="Your password" hint="You already have an account — confirm it's you." error={fields.password}>
              <Input id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={!!fields.password} />
            </Field>
          ) : (
            <>
              <Field id="name" label="Your name" error={fields.name}>
                <Input id="name" name="name" defaultValue={invite.name ?? ""} autoComplete="name" required aria-invalid={!!fields.name} />
              </Field>
              <Field id="password" label="Choose a password" hint="At least 10 characters, with a letter and a number." error={fields.password}>
                <Input id="password" name="password" type="password" autoComplete="new-password" required aria-invalid={!!fields.password} />
              </Field>
            </>
          )}
          <Button type="submit" className="w-full" loading={loading}>
            Join team
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
