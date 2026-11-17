"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import { toLocalInput } from "@/components/follow-up-actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";

export function ScheduleFollowUp({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600_000)));
  const [title, setTitle] = useState("");
  const { submit, loading, error, fields } = useSubmit();

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <CalendarPlus className="size-4" aria-hidden /> Schedule a follow-up
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      <Input aria-label="What to do" placeholder="e.g. Call back about the quote" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Input type="datetime-local" aria-label="When" value={when} onChange={(e) => setWhen(e.target.value)} aria-invalid={!!fields.dueAt} />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          loading={loading}
          onClick={async () => {
            if (await submit(`/api/leads/${leadId}/follow-ups`, { body: { dueAt: new Date(when).toISOString(), title: title || undefined } })) {
              setOpen(false);
              setTitle("");
              router.refresh();
            }
          }}
        >
          Schedule
        </Button>
      </div>
    </div>
  );
}
