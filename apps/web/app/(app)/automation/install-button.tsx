"use client";

import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useSubmit } from "@/lib/use-submit";

export function InstallButton() {
  const router = useRouter();
  const { submit, loading, error } = useSubmit();
  return (
    <div className="space-y-2">
      {error && <Alert tone="error">{error}</Alert>}
      <Button
        loading={loading}
        onClick={async () => {
          if (await submit("/api/automation/install", { method: "POST" })) router.push("/automation/setup?step=1");
        }}
      >
        Install automation
      </Button>
    </div>
  );
}
