"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { INTERACTION_CHANNELS, INTERACTION_CHANNEL_LABELS } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";
import { cn } from "@/lib/utils";

/** Add a note, or log that you contacted the customer (which is not the same as the customer replying). */
export function ActivityComposer({ leadId, notesOnly }: { leadId: string; notesOnly?: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"contact" | "reply" | "note">(notesOnly ? "note" : "contact");
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<(typeof INTERACTION_CHANNELS)[number]>("PHONE");
  const [awaiting, setAwaiting] = useState(true);
  const { submit, loading, error } = useSubmit();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ok =
      mode === "note"
        ? await submit(`/api/leads/${leadId}/activities`, { body: { body: text } })
        : mode === "reply"
          ? await submit(`/api/leads/${leadId}/customer-reply`, { body: { channel, note: text || undefined } })
          : await submit(`/api/leads/${leadId}/interactions`, { body: { channel, note: text || undefined, awaitingCustomer: awaiting } });
    if (ok) {
      setText("");
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-border p-3">
      {!notesOnly && (
        <div role="tablist" className="flex gap-1 text-sm">
          {(
            [
              ["contact", "I contacted them"],
              ["reply", "They got back to us"],
              ["note", "Add note"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn("rounded-md px-3 py-1", mode === m ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {mode !== "note" && (
        <div className="flex flex-wrap items-center gap-3">
          <Select aria-label="How did you contact them?" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} className="h-9 w-48">
            {INTERACTION_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {INTERACTION_CHANNEL_LABELS[c]}
              </option>
            ))}
          </Select>
          {mode === "contact" ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={awaiting} onChange={(e) => setAwaiting(e.target.checked)} />
              Now waiting for the customer to respond
            </label>
          ) : (
            <span className="text-sm text-muted-foreground">Pauses automatic follow-ups and reminds the assigned person to respond.</span>
          )}
        </div>
      )}
      <textarea
        aria-label={mode === "note" ? "Note" : "What happened?"}
        placeholder={
          mode === "note"
            ? "Write a note for your team…"
            : mode === "reply"
              ? "What did they say? (optional)"
              : "What happened? e.g. Sent quotation, call back Thursday (optional)"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
      />
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" loading={loading} disabled={mode === "note" && !text.trim()}>
          {mode === "note" ? "Add note" : mode === "reply" ? "Record reply" : "Log contact"}
        </Button>
      </div>
    </form>
  );
}
