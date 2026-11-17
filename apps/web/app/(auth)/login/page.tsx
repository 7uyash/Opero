import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const NOTICES: Record<string, string> = {
  "no-organization": "Your account isn't part of an active business. Ask the business owner to invite you again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const auth = await getAuth();
  if (auth?.ctx) redirect("/dashboard");
  const { error } = await searchParams;
  return <LoginForm notice={error ? NOTICES[error] : undefined} />;
}
