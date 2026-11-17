"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useSubmit } from "@/lib/use-submit";

/** Safe retry: re-sends the same message record, so the customer can't get two copies. */
export function RetryButton({ executionId, needsConfirm }: { executionId: string; needsConfirm: boolean }) {
  const router = useRouter();
  const { submit, loading, error } = useSubmit();
  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="secondary"
        loading={loading}
        onClick={async () => {
          if (needsConfirm && !confirm("Sending was interrupted, so the customer may already have this message. Send it again anyway?")) return;
          if (await submit(`/api/automation/executions/${executionId}/retry`, { body: { confirmPossibleDuplicate: needsConfirm } })) router.refresh();
        }}
      >
        Retry
      </Button>
      {error && <p className="max-w-48 text-xs text-destructive">{error}</p>}
    </div>
  );
}
