"use client";

import { useState } from "react";

export function UnsubscribeForm({ token, businessName, initiallyOptedOut }: { token: string; businessName: string; initiallyOptedOut: boolean }) {
  const [optedOut, setOptedOut] = useState(initiallyOptedOut);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function change(next: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/unsubscribe/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optedOut: next }),
      });
      if (!res.ok) throw new Error();
      setOptedOut(next);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{optedOut ? "You're unsubscribed" : `Emails from ${businessName}`}</h1>
      <p className="text-sm text-muted-foreground">
        {optedOut
          ? `${businessName} won't send you any more emails about your inquiry.`
          : `Don't want further emails from ${businessName} about your inquiry? You can stop them here.`}
      </p>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => change(!optedOut)}
        className={
          optedOut
            ? "text-sm text-blue-800 underline disabled:opacity-60"
            : "inline-flex h-10 items-center rounded-md bg-blue-900 px-4 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
        }
      >
        {optedOut ? "I changed my mind — keep sending me emails" : "Unsubscribe"}
      </button>
    </div>
  );
}
