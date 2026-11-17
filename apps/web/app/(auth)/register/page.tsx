import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/session";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create your business account" };

export default async function RegisterPage() {
  const auth = await getAuth();
  if (auth?.ctx) redirect("/dashboard");
  return <RegisterForm timezones={Intl.supportedValuesOf("timeZone")} />;
}
