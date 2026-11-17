"use client";

import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useSubmit } from "@/lib/use-submit";

export function ActivationButtons({ status, canActivate }: { status: "ACTIVE" | "PAUSED" | "DRAFT"; canActivate: boolean }) {
  const router = useRouter();
  const { submit, loading, error } = useSubmit();
  const go = async (path: string) => {
    if (await submit(path, { method: "POST" })) router.refresh();
  };
  return (
    <div className="space-y-3">
      {error && <Alert tone="error">{error}</Alert>}
      {status === "ACTIVE" ? (
        <Button
          variant="secondary"
          loading={loading}
          onClick={() => {
            if (confirm("Pause automatic messages? Nothing more is sent to customers until you turn it back on.")) void go("/api/automation/pause");
          }}
        >
          Pause automatic messages
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={loading} disabled={!canActivate} onClick={() => go("/api/automation/activate")}>
            Turn on automatic messages
          </Button>
          {!canActivate && <span className="text-sm text-muted-foreground">Complete the items above first.</span>}
        </div>
      )}
    </div>
  );
}
