import { FOLLOW_UP_STATUS_LABELS, type FollowUpStatus } from "@lfm/shared";
import { FollowUpActions } from "@/components/follow-up-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { ScheduleFollowUp } from "./schedule-follow-up";

type Task = {
  id: string;
  title: string | null;
  status: FollowUpStatus;
  dueAt: string;
  statusReason: string | null;
  note: string | null;
  completedBy: string | null;
};

const PENDING: FollowUpStatus[] = ["SCHEDULED", "DUE", "IN_PROGRESS"];

export function FollowUpsCard({ leadId, tasks, timeZone, canManage, closed }: { leadId: string; tasks: Task[]; timeZone: string; canManage: boolean; closed: boolean }) {
  const pending = tasks.filter((t) => PENDING.includes(t.status)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const past = tasks.filter((t) => !PENDING.includes(t.status)).slice(0, 8);
  const paused = past.filter((t) => t.status === "PAUSED");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Follow-ups</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {closed ? "Follow-ups stopped because this lead is closed." : paused.length ? "Follow-ups are paused while this lead is on hold." : "Nothing scheduled."}
          </p>
        ) : (
          <ul className="space-y-3">
            {pending.map((t) => {
              const due = new Date(t.dueAt) <= new Date();
              return (
                <li key={t.id} className="space-y-2 text-sm">
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      {t.title ?? "Follow up"}
                      {due && <Badge tone="warning">Due</Badge>}
                    </div>
                    <div className={due ? "text-warning" : "text-muted-foreground"}>{formatDateTime(t.dueAt, timeZone)}</div>
                    {t.note && <div className="text-muted-foreground">“{t.note}”</div>}
                  </div>
                  {canManage && <FollowUpActions taskId={t.id} compact />}
                </li>
              );
            })}
          </ul>
        )}
        {canManage && !closed && <ScheduleFollowUp leadId={leadId} />}
        {past.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">History</summary>
            <ul className="mt-2 space-y-2">
              {past.map((t) => (
                <li key={t.id}>
                  <span>{t.title ?? "Follow up"}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {FOLLOW_UP_STATUS_LABELS[t.status]}
                    {t.completedBy && ` by ${t.completedBy}`}
                    {t.statusReason && ` — ${t.statusReason}`}
                  </span>
                  <div className="text-xs text-muted-foreground">{formatDateTime(t.dueAt, timeZone)}</div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
