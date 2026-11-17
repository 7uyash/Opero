"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Send } from "lucide-react";
import { CHANNEL_LABELS, MESSAGE_STATUS_LABELS, type MessageChannel } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import { useSubmit } from "@/lib/use-submit";

type Msg = {
  id: string;
  direction: "OUTBOUND" | "INBOUND";
  channel: string;
  purpose: string;
  subject: string | null;
  body: string;
  status: string;
  lastError: string | null;
  failureKind: string | null;
  scheduledFor: string | null;
  createdAt: string;
};

const PURPOSE: Record<string, string> = {
  acknowledgement: "Automatic acknowledgement",
  follow_up: "Automatic follow-up",
  fallback: "Automatic (fallback channel)",
  manual: "Sent by team",
  reply: "Customer",
};

const TONE: Record<string, "success" | "danger" | "warning" | "neutral" | "info"> = {
  SENT: "success",
  DELIVERED: "success",
  READ: "success",
  FAILED: "danger",
  QUEUED: "warning",
  SENDING: "warning",
  CANCELLED: "neutral",
  RECEIVED: "info",
};

export function MessagesCard({
  leadId,
  messages,
  timeZone,
  canSend,
  channels,
  consents,
  defaultSubject,
}: {
  leadId: string;
  messages: Msg[];
  timeZone: string;
  canSend: boolean;
  /** Channels this customer can be reached on, with whether the business has it connected. */
  channels: { channel: MessageChannel; available: boolean; reason?: string }[];
  consents: Record<MessageChannel, "OPTED_IN" | "OPTED_OUT" | null>;
  defaultSubject: string;
}) {
  const router = useRouter();
  const usable = channels.filter((c) => c.available);
  const [channel, setChannel] = useState<MessageChannel>(usable[0]?.channel ?? "EMAIL");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const send = useSubmit();
  const action = useSubmit();

  async function onSend() {
    const ok = await send.submit("/api/messages/send", {
      body: { leadId, channel, subject: channel === "EMAIL" ? subject : undefined, body, clientRequestId: requestId },
    });
    if (ok) {
      setBody("");
      setRequestId(crypto.randomUUID()); // next message is a new request
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Messages</CardTitle>
        <div className="flex flex-wrap gap-2 text-xs">
          {(Object.keys(consents) as MessageChannel[]).map((c) => (
            <button
              key={c}
              type="button"
              disabled={!canSend || action.loading}
              onClick={async () => {
                const optedOut = consents[c] !== "OPTED_OUT";
                if (optedOut && !confirm(`Stop all ${CHANNEL_LABELS[c].toLowerCase()} messages to this customer?`)) return;
                if (await action.submit(`/api/leads/${leadId}/consent`, { body: { channel: c, optedOut } })) router.refresh();
              }}
              className="rounded-full border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-60"
              title="Click to change"
            >
              {CHANNEL_LABELS[c]}: {consents[c] === "OPTED_OUT" ? "opted out" : consents[c] === "OPTED_IN" ? "opted in" : "no preference"}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {action.error && <Alert tone="error">{action.error}</Alert>}
        {canSend && (
          <div className="space-y-2 rounded-md border border-border p-3">
            {usable.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {channels.map((c) => `${CHANNEL_LABELS[c.channel]}: ${c.reason}`).join(" · ")}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as MessageChannel)} className="h-9 w-36">
                    {usable.map((c) => (
                      <option key={c.channel} value={c.channel}>
                        {CHANNEL_LABELS[c.channel]}
                      </option>
                    ))}
                  </Select>
                  {channel === "EMAIL" && (
                    <Input aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="h-9 min-w-0 flex-1" />
                  )}
                </div>
                <textarea
                  aria-label="Message"
                  rows={4}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write to the customer…"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                />
                {send.error && <Alert tone="error">{send.error}</Alert>}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Sending counts as contacting the customer and re-times follow-ups.</span>
                  <Button size="sm" onClick={onSend} loading={send.loading} disabled={!body.trim()}>
                    <Send className="size-4" aria-hidden /> Send
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          <ul className="space-y-3">
            {messages.map((m) => (
              <li key={m.id} className={`rounded-md border p-3 text-sm ${m.direction === "INBOUND" ? "border-primary/30 bg-blue-50/40" : "border-border"}`}>
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {m.direction === "INBOUND" ? <ArrowDownLeft className="size-3.5" aria-label="Received" /> : <ArrowUpRight className="size-3.5" aria-label="Sent" />}
                  <span>{CHANNEL_LABELS[m.channel as MessageChannel] ?? m.channel}</span>
                  <span>· {PURPOSE[m.purpose] ?? m.purpose}</span>
                  <span>· {formatDateTime(m.createdAt, timeZone)}</span>
                  <Badge tone={TONE[m.status] ?? "neutral"}>{MESSAGE_STATUS_LABELS[m.status] ?? m.status}</Badge>
                </div>
                {m.subject && <p className="font-medium">{m.subject}</p>}
                <p className="line-clamp-6 whitespace-pre-wrap">{m.body}</p>
                {m.status === "QUEUED" && m.scheduledFor && new Date(m.scheduledFor) > new Date() && (
                  <p className="mt-1 text-xs text-muted-foreground">Waiting for sending hours — goes out {formatDateTime(m.scheduledFor, timeZone)}</p>
                )}
                {m.lastError && (m.status === "FAILED" || m.status === "CANCELLED" || m.status === "QUEUED") && (
                  <p className={`mt-1 text-xs ${m.status === "FAILED" ? "text-destructive" : "text-muted-foreground"}`}>
                    {m.status === "QUEUED" ? `Retrying: ${m.lastError}` : m.lastError}
                  </p>
                )}
                {m.status === "FAILED" && canSend && <RetryMessage id={m.id} needsConfirm={m.failureKind === "delivery_unknown"} />}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RetryMessage({ id, needsConfirm }: { id: string; needsConfirm: boolean }) {
  const router = useRouter();
  const { submit, loading, error } = useSubmit();
  return (
    <div className="mt-2">
      <Button
        size="sm"
        variant="secondary"
        loading={loading}
        onClick={async () => {
          if (needsConfirm && !confirm("Sending was interrupted, so the customer may already have this. Send again?")) return;
          if (await submit(`/api/messages/${id}/retry`, { body: { confirmPossibleDuplicate: needsConfirm } })) router.refresh();
        }}
      >
        Retry
      </Button>
      {error && <span className="ml-2 text-xs text-destructive">{error}</span>}
    </div>
  );
}
