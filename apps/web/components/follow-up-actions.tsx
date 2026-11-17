"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { INTERACTION_CHANNELS, INTERACTION_CHANNEL_LABELS } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";

/** Value for <input type="datetime-local"> in the viewer's local time. */
export function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FollowUpActions({ taskId, compact }: { taskId: string; compact?: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"none" | "done" | "reschedule">("none");
  const [contacted, setContacted] = useState(true);
  const [awaiting, setAwaiting] = useState(true);
  const [channel, setChannel] = useState<(typeof INTERACTION_CHANNELS)[number]>("PHONE");
  const [note, setNote] = useState("");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600_000)));
  const { submit, loading, error } = useSubmit();

  const done = async () => {
    if (await submit(`/api/follow-ups/${taskId}/complete`, { body: { contacted, channel, awaitingCustomer: awaiting, note: note || undefined } })) {
      setMode("none");
      router.refresh();
    }
  };
  const reschedule = async () => {
    if (await submit(`/api/follow-ups/${taskId}/reschedule`, { body: { dueAt: new Date(when).toISOString() } })) {
      setMode("none");
      router.refresh();
    }
  };
  const skip = async () => {
    if (!confirm("Skip this follow-up? The rest of the sequence stays as planned.")) return;
    if (await submit(`/api/follow-ups/${taskId}/skip`, { body: {} })) router.refresh();
  };

  if (mode === "none") {
    return (
      <div className="flex flex-wrap gap-1">
        <Button size="sm" onClick={() => setMode("done")}>
          Mark done
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setMode("reschedule")}>
          Reschedule
        </Button>
        {!compact && (
          <Button size="sm" variant="ghost" onClick={skip} disabled={loading}>
            Skip
          </Button>
        )}
        {error && <p className="w-full text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="w-full space-y-3 rounded-md border border-border bg-background p-3 text-sm">
      {mode === "done" ? (
        <>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4 accent-primary" checked={contacted} onChange={(e) => setContacted(e.target.checked)} />
            I contacted the customer
          </label>
          {contacted && (
            <div className="flex flex-wrap items-center gap-3 pl-6">
              <Select aria-label="How" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className="h-8 w-44">
                {INTERACTION_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {INTERACTION_CHANNEL_LABELS[c]}
                  </option>
                ))}
              </Select>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-primary" checked={awaiting} onChange={(e) => setAwaiting(e.target.checked)} />
                Waiting for them to respond
              </label>
            </div>
          )}
          <textarea
            aria-label="Note"
            placeholder="What happened? (optional)"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-md border border-input px-3 py-2 focus-visible:outline-2 focus-visible:outline-ring"
          />
          <p className="text-xs text-muted-foreground">
            {contacted ? "The next follow-ups are re-timed from now." : "The rest of the sequence stays as planned."}
          </p>
        </>
      ) : (
        <label className="flex flex-wrap items-center gap-2">
          New time
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-8 w-56" />
        </label>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setMode("none")}>
          Cancel
        </Button>
        <Button size="sm" loading={loading} onClick={mode === "done" ? done : reschedule}>
          {mode === "done" ? "Save" : "Reschedule"}
        </Button>
      </div>
    </div>
  );
}
