import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { can, listAssignableMembers, listFollowUpCenter } from "@lfm/core";
import { FOLLOW_UP_VIEWS, FOLLOW_UP_VIEW_LABELS, LEAD_STATUS_LABELS, type FollowUpView } from "@lfm/shared";
import { FollowUpActions } from "@/components/follow-up-actions";
import { StatusBadge } from "@/components/lead-badges";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatDateTime, formatRelative } from "@/lib/format";
import { requireAuth } from "@/lib/session";
import { cn } from "@/lib/utils";
import { AssigneeFilter } from "./assignee-filter";

export const metadata: Metadata = { title: "Follow-ups" };

const EMPTY: Record<FollowUpView, string> = {
  due_today: "Nothing due today. Nice work.",
  overdue: "No overdue follow-ups.",
  upcoming: "No follow-ups scheduled after today.",
  waiting: "No leads are waiting on the customer right now.",
  awaiting_employee: "Every lead has been taken care of.",
  failed: "No failed messages. Messages that can't be delivered will show up here.",
};

const sp = z.object({ view: z.enum(FOLLOW_UP_VIEWS).catch("due_today"), assignee: z.string().max(64).optional() });

export default async function FollowUpsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { ctx } = await requireAuth();
  const { view, assignee } = sp.parse(await searchParams);
  const [data, members] = await Promise.all([
    listFollowUpCenter(ctx, view, { assignee }),
    can(ctx, "leads:view_all") ? listAssignableMembers(ctx) : Promise.resolve([]),
  ]);
  const tz = data.timezone;
  const href = (v: FollowUpView) => `/follow-ups?view=${v}${assignee ? `&assignee=${assignee}` : ""}`;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Follow-ups</h1>
          <p className="text-sm text-muted-foreground">
            Reminders are created automatically for every lead and pause when the customer replies.
          </p>
        </div>
        {members.length > 0 && <AssigneeFilter members={members.map((m) => ({ id: m.id, name: m.name }))} />}
      </header>

      <nav aria-label="Follow-up views" className="flex gap-1 overflow-x-auto border-b border-border">
        {FOLLOW_UP_VIEWS.map((v) => (
          <Link
            key={v}
            href={href(v)}
            aria-current={v === view ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm",
              v === view ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {FOLLOW_UP_VIEW_LABELS[v]}
            <Badge tone={v === "overdue" && data.summary[v] ? "danger" : v === "failed" && data.summary[v] ? "warning" : "neutral"}>
              {data.summary[v]}
            </Badge>
          </Link>
        ))}
      </nav>

      <Card>
        {data.tasks.length + data.leads.length + data.messages.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">{EMPTY[view]}</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <Link href={`/leads/${t.lead.id}`} className="font-medium text-primary hover:underline">
                    {t.lead.name}
                  </Link>
                  <span className="ml-2 inline-flex">
                    <StatusBadge status={t.lead.status} />
                  </span>
                  <p className="text-sm">{t.title}</p>
                  <p className={cn("text-sm", view === "overdue" ? "text-destructive" : "text-muted-foreground")}>
                    {t.status === "DUE" ? "Due" : "Scheduled for"} {formatDateTime(t.dueAt, tz)} ({formatRelative(t.dueAt)})
                    {" · "}
                    {t.lead.assignedMember?.user.name ?? "Unassigned"}
                  </p>
                  {t.note && <p className="mt-1 text-sm text-muted-foreground">“{t.note}”</p>}
                </div>
                <div className="w-full sm:w-auto sm:max-w-md">
                  <FollowUpActions taskId={t.id} />
                </div>
              </li>
            ))}
            {data.leads.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <Link href={`/leads/${l.id}`} className="font-medium text-primary hover:underline">
                    {l.name}
                  </Link>
                  <span className="ml-2 inline-flex">
                    <StatusBadge status={l.status} />
                  </span>
                  <p className="text-sm text-muted-foreground">
                    {view === "waiting"
                      ? `Last contacted ${formatRelative(l.lastContactAt)}`
                      : l.status === "FOLLOW_UP_DUE"
                        ? "A follow-up or customer reply needs attention"
                        : `${LEAD_STATUS_LABELS[l.status]} · arrived ${formatRelative(l.createdAt)}, not contacted yet`}
                    {" · "}
                    {l.assignedMember?.user.name ?? "Unassigned"}
                    {l.nextFollowUpAt && ` · next follow-up ${formatDateTime(l.nextFollowUpAt, tz)}`}
                  </p>
                </div>
              </li>
            ))}
            {data.messages.map((m) => (
              <li key={m.id} className="p-4 text-sm">
                <Link href={`/leads/${m.lead.id}`} className="font-medium text-primary hover:underline">
                  {m.lead.name}
                </Link>
                <p className="text-muted-foreground">
                  {m.channel} message failed {formatRelative(m.failedAt)} — {m.lastError ?? "unknown error"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
