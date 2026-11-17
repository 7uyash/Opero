"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, ApiRequestError } from "@/lib/fetcher";

export function LoginForm({ notice }: { notice?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fields, setFields] = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setLoading(true);
    setError(undefined);
    setFields({});
    try {
      await api("/api/auth/login", { body: { email: form.get("email"), password: form.get("password") } });
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back. Sign in to manage your leads.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {notice && <Alert tone="info">{notice}</Alert>}
          {error && <Alert tone="error">{error}</Alert>}
          <Field id="email" label="Email" error={fields.email}>
            <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={!!fields.email} />
          </Field>
          <Field id="password" label="Password" error={fields.password}>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              aria-invalid={!!fields.password}
            />
          </Field>
          <Button type="submit" className="w-full" loading={loading}>
            Sign in
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            New here?{" "}
            <Link href="/register" className="font-medium text-primary hover:underline">
              Create a business account
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
