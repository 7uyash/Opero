"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/fetcher";

export function WizardNav({ step, total }: { step: number; total: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const go = async (to: number) => {
    setBusy(true);
    try {
      await api("/api/automation/setup", { method: "PATCH", body: { step: to } });
    } finally {
      router.push(to > total ? "/automation" : `/automation/setup?step=${to}`);
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center justify-between border-t border-border pt-4">
      {step > 1 ? (
        <Button variant="ghost" onClick={() => router.push(`/automation/setup?step=${step - 1}`)}>
          ← Back
        </Button>
      ) : (
        <span />
      )}
      <span className="text-sm text-muted-foreground">
        Step {step} of {total} · you can come back to any step later
      </span>
      <Button loading={busy} onClick={() => go(step + 1)}>
        {step === total ? "Finish" : "Continue →"}
      </Button>
    </div>
  );
}
