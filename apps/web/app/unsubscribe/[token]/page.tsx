import type { Metadata } from "next";
import { AppError, describeUnsubscribe } from "@lfm/core";
import { UnsubscribeForm } from "./unsubscribe-form";

export const metadata: Metadata = { title: "Email preferences", robots: { index: false } };

/** Public page linked from every customer email. No sign-in; the signed token identifies the customer. */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const decoded = decodeURIComponent(token);
  let info: Awaited<ReturnType<typeof describeUnsubscribe>> | null = null;
  try {
    info = await describeUnsubscribe(decoded);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-xs">
        {info ? (
          <UnsubscribeForm token={decoded} businessName={info.businessName} initiallyOptedOut={info.optedOut} />
        ) : (
          <>
            <h1 className="text-lg font-semibold">Link not valid</h1>
            <p className="mt-2 text-sm text-muted-foreground">This unsubscribe link is incomplete or has been changed. Please use the link from the email.</p>
          </>
        )}
      </div>
    </main>
  );
}
