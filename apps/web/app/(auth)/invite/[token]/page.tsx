import type { Metadata } from "next";
import Link from "next/link";
import { AppError, previewInvitation } from "@lfm/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AcceptForm } from "./accept-form";

export const metadata: Metadata = { title: "Join your team", robots: { index: false } };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let invite: Awaited<ReturnType<typeof previewInvitation>>;
  try {
    invite = await previewInvitation(decodeURIComponent(token));
  } catch (err) {
    const message = err instanceof AppError ? err.message : "This invitation link is not valid.";
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invitation unavailable</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login" className="text-sm font-medium text-primary hover:underline">
            Go to sign in
          </Link>
        </CardContent>
      </Card>
    );
  }
  return <AcceptForm token={decodeURIComponent(token)} invite={invite} />;
}
