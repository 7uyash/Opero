import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { can, listExecutions } from "@lfm/core";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { getOrganization, requireAuth } from "@/lib/session";
import { cn } from "@/lib/utils";
import { RetryButton } from "./retry-button";

export const metadata: Metadata = { title: "Automation activity" };

/** Plain-language names for execution events. */
const EVENT_LABELS: Record<string, string> = {
  "followup.scheduled": "Follow-ups scheduled",
  "followup.reminder_due": "Follow-up reminder due",
  "followup.paused_customer_replied": "Follow-ups paused — customer replied",
  "message.acknowledgement": "Acknowledgement message",
  "message.follow_up": "Follow-up message",
  "message.manual": "Message from team member",
  "message.fallback": "Message on fallback channel",
  "message.acknowledgement_skipped": "Acknowledgement not sent on some channels",
  "message.follow_up_skipped": "Follow-up message not sent on some channels",
  "message.reply_received": "Customer reply received",
};

const STATUS_TONE = { SUCCESS: "success", FAILED: "danger", RETRYING: "warning", SKIPPED: "neutral" } as const;
const STATUS_LABEL = { SUCCESS: "Success", FAILED: "Failed", RETRYING: "Will retry", SKIPPED: "Skipped" } as const;

const sp = z.object({
  status: z.enum(["SUCCESS", "FAILED", "RETRYING", "SKIPPED"]).optional().catch(undefined),
  event: z.enum(["message", "followup"]).optional().catch(undefined),
  cursor: z.string().max(64).optional(),
});

function detail(e: { error: string | null; output: unknown }): string | null {
  if (e.error) return e.error;
  const o = (e.output ?? {}) as Record<string, unknown>;
  if (Array.isArray(o.reasons)) return (o.reasons as string[]).join(" · ");
  if (typeof o.reason === "string") return o.reason;
  if (typeof o.title === "string") return o.title;
  if (typeof o.steps === "number") return `${o.steps} reminder${o.steps === 1 ? "" : "s"}`;
  if (typeof o.nextAttemptInSeconds === "number") return `Next try in ${Math.round(o.nextAttemptInSeconds / 60)} min`;
  return null;
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { ctx } = await requireAuth();
  if (!can(ctx, "executions:view")) notFound();
  const q = sp.parse(await searchParams);
  const [{ items, nextCursor }, org] = await Promise.all([
    listExecutions(ctx, { status: q.status, eventPrefix: q.event, cursor: q.cursor }),
    getOrganization(ctx.organizationId),
  ]);
  const link = (changes: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: q.status, event: q.event, ...changes })) if (v) p.set(k, v);
    return `/activity${p.size ? `?${p}` : ""}`;
  };
  const filter = (label: string, changes: Record<string, string | undefined>, active: boolean) => (
    <Link
      href={link({ ...changes, cursor: undefined })}
      className={cn("rounded-full border px-3 py-1 text-sm", active ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted")}
    >
      {label}
    </Link>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Automation activity</h1>
        <p className="text-sm text-muted-foreground">Every step the automation took, newest first. Failed messages can be retried safely — a customer never gets a duplicate.</p>
      </header>
      <div className="flex flex-wrap gap-2">
        {filter("Everything", { status: undefined, event: undefined }, !q.status && !q.event)}
        {filter("Failed", { status: "FAILED" }, q.status === "FAILED")}
        {filter("Retrying", { status: "RETRYING" }, q.status === "RETRYING")}
        {filter("Skipped", { status: "SKIPPED" }, q.status === "SKIPPED")}
        {filter("Messages", { event: "message" }, q.event === "message")}
        {filter("Follow-ups", { event: "followup" }, q.event === "followup")}
      </div>
      <Card className="overflow-x-auto">
        {items.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">Nothing here yet. Activity appears as leads arrive and follow-ups run.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">What happened</th>
                <th className="px-4 py-2 font-medium">Lead</th>
                <th className="px-4 py-2 font-medium">Result</th>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const d = detail(e);
                const canRetry = can(ctx, "executions:retry") && e.status === "FAILED" && e.message?.status === "FAILED" && e.retryable;
                return (
                  <tr key={e.id} className="border-t border-border align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{EVENT_LABELS[e.eventType] ?? e.eventType}</div>
                      {d && <div className={cn("max-w-md", e.status === "FAILED" ? "text-destructive" : "text-muted-foreground")}>{d}</div>}
                      {e.attempt > 1 && <div className="text-xs text-muted-foreground">Attempt {e.attempt}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {e.lead ? (
                        <Link href={`/leads/${e.lead.id}`} className="text-primary hover:underline">
                          {e.lead.name}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDateTime(e.createdAt, org.timezone)}</td>
                    <td className="px-4 py-3 text-right">
                      {canRetry && <RetryButton executionId={e.id} needsConfirm={e.message?.failureKind === "delivery_unknown"} />}
                      {e.status === "FAILED" && e.message?.status && e.message.status !== "FAILED" && (
                        <span className="text-xs text-muted-foreground">Retried</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <div className="flex gap-4 text-sm">
        {q.cursor && (
          <Link href={link({ cursor: undefined })} className="text-primary hover:underline">
            ← Newest
          </Link>
        )}
        {nextCursor && (
          <Link href={link({ cursor: nextCursor })} className="text-primary hover:underline">
            Older →
          </Link>
        )}
      </div>
    </div>
  );
}
