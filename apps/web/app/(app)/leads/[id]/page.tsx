import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AppError,
  can,
  getChannelIntegration,
  getLeadConsents,
  getLeadDetail,
  getLeadTimeline,
  listAssignableMembers,
  listLeadFollowUps,
  listLeadMessages,
} from "@lfm/core";
import { prisma } from "@lfm/db";
import { allowedNextStatuses, SOURCE_LABELS } from "@lfm/shared";
import { PriorityBadge, StatusBadge } from "@/components/lead-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatRelative } from "@/lib/format";
import { getOrganization, requireAuth } from "@/lib/session";
import { LeadActions } from "./lead-actions";
import { QuickContact } from "./quick-contact";
import { LeadProfile } from "./lead-profile";
import { Timeline } from "./timeline";
import { ActivityComposer } from "./activity-composer";
import { FollowUpsCard } from "./follow-ups-card";
import { MessagesCard } from "./messages-card";

export const metadata: Metadata = { title: "Lead" };

const METHOD_LABELS = { ROUND_ROBIN: "automatic turn", MANUAL: "by hand", FALLBACK: "fallback manager", UNASSIGNED: "unassigned" } as const;

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireAuth();
  const { id } = await params;

  let lead: Awaited<ReturnType<typeof getLeadDetail>>;
  try {
    lead = await getLeadDetail(ctx, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const [timeline, org, members, followUps, messages, consents, emailConn, waConn] = await Promise.all([
    getLeadTimeline(ctx, id),
    getOrganization(ctx.organizationId),
    can(ctx, "leads:assign") ? listAssignableMembers(ctx) : Promise.resolve([]),
    listLeadFollowUps(ctx, id),
    listLeadMessages(ctx, id),
    getLeadConsents(id),
    getChannelIntegration(prisma, ctx.organizationId, "EMAIL"),
    getChannelIntegration(prisma, ctx.organizationId, "WHATSAPP"),
  ]);
  const channelState = (ch: "EMAIL" | "WHATSAPP", address: string | null, connected: boolean) =>
    !address
      ? { channel: ch, available: false, reason: ch === "EMAIL" ? "no email address" : "no valid phone number" }
      : consents[ch] === "OPTED_OUT"
        ? { channel: ch, available: false, reason: "customer opted out" }
        : !connected
          ? { channel: ch, available: false, reason: "not connected yet" }
          : { channel: ch, available: true };
  const tz = org.timezone;
  const closed = lead.status === "CONVERTED" || lead.status === "LOST";

  return (
    <div className="mx-auto max-w-6xl space-y-5 md:space-y-6">
      <nav className="text-sm">
        <Link href="/leads" className="text-muted-foreground hover:text-foreground">
          ← All leads
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3 md:gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{lead.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge status={lead.status} />
            <PriorityBadge priority={lead.priority} />
            <span>
              {SOURCE_LABELS[lead.sourceType]} · added {formatRelative(lead.createdAt)}
            </span>
            {lead.assignedMember ? <span>· {lead.assignedMember.user.name}</span> : <Badge tone="warning">Unassigned</Badge>}
          </div>
        </div>
        <QuickContact phone={lead.phoneE164} email={lead.email} />
      </header>

      {lead.duplicateOf && (
        <div className="rounded-md border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          Possible duplicate of{" "}
          <Link href={`/leads/${lead.duplicateOf.id}`} className="font-medium underline">
            {lead.duplicateOf.name}
          </Link>
          . Review both and mark one as lost if they're the same inquiry.
        </div>
      )}

      {/* Phones: one column ordered by what you need first (actions, follow-ups, details, history).
          Desktop: details and history on the left, actions on the right. */}
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="contents lg:block lg:space-y-6">
          <div className="order-3 lg:order-none">
          <LeadProfile
            lead={{
              id: lead.id,
              name: lead.name,
              email: lead.email,
              phone: lead.phone,
              company: lead.company,
              subject: lead.subject,
              inquiry: lead.inquiry,
              priority: lead.priority,
            }}
            canEdit={can(ctx, "leads:update")}
          />
          </div>

          <div className="order-5 lg:order-none">
          <MessagesCard
            leadId={lead.id}
            timeZone={tz}
            canSend={can(ctx, "messages:send")}
            consents={consents}
            defaultSubject={lead.subject ? `Re: ${lead.subject}` : `Your inquiry with ${org.name}`}
            channels={[channelState("EMAIL", lead.email, !!emailConn), channelState("WHATSAPP", lead.phoneE164, !!waConn)]}
            messages={messages.map((m) => ({
              id: m.id,
              direction: m.direction,
              channel: m.channel,
              purpose: m.purpose,
              subject: m.subject,
              body: m.body,
              status: m.status,
              lastError: m.lastError,
              failureKind: m.failureKind,
              scheduledFor: m.scheduledFor?.toISOString() ?? null,
              createdAt: m.createdAt.toISOString(),
            }))}
          />
          </div>

          <Card className="order-4 lg:order-none">
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {can(ctx, "leads:update") && <ActivityComposer leadId={lead.id} notesOnly={closed} />}
              <Timeline entries={timeline.map((t) => ({ ...t, occurredAt: t.occurredAt.toISOString() }))} timeZone={tz} />
            </CardContent>
          </Card>
        </div>

        <aside className="contents lg:block lg:space-y-6">
          <div className="order-1 lg:order-none">
          <LeadActions
            leadId={lead.id}
            status={lead.status}
            nextStatuses={allowedNextStatuses(lead.status)}
            assignedMemberId={lead.assignedMemberId}
            canAssign={can(ctx, "leads:assign")}
            members={members.map((m) => ({ id: m.id, name: m.name, isAvailable: m.isAvailable }))}
          />
          </div>
          <div className="order-2 lg:order-none">
          <FollowUpsCard
            leadId={lead.id}
            timeZone={tz}
            closed={closed}
            canManage={can(ctx, "followups:manage")}
            tasks={followUps.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              dueAt: t.dueAt.toISOString(),
              statusReason: t.statusReason,
              note: t.note,
              completedBy: t.completedBy?.user.name ?? null,
            }))}
          />
          </div>
          <Card className="order-6 lg:order-none">
            <CardHeader>
              <CardTitle className="text-base">Key dates</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                {[
                  ["Created", lead.createdAt],
                  ["Last contact by team", lead.lastContactAt],
                  ["Last reply from customer", lead.lastCustomerReplyAt],
                  ["Next follow-up", lead.nextFollowUpAt],
                  ["Converted", lead.convertedAt],
                  ["Lost", lead.lostAt],
                ]
                  .filter(([label, v]) => v || ["Created", "Last contact by team", "Next follow-up"].includes(label as string))
                  .map(([label, v]) => (
                    <div key={label as string} className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">{label as string}</dt>
                      <dd className="text-right">{formatDateTime(v as Date | null, tz)}</dd>
                    </div>
                  ))}
                {lead.lostReason && (
                  <div>
                    <dt className="text-muted-foreground">Reason lost</dt>
                    <dd>{lead.lostReason}</dd>
                  </div>
                )}
              </dl>
            </CardContent>
          </Card>
          {lead.assignments.length > 0 && (
            <Card className="order-7 lg:order-none">
              <CardHeader>
                <CardTitle className="text-base">Assignment history</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-2 text-sm">
                  {lead.assignments.map((a) => (
                    <li key={a.id}>
                      <span className="font-medium">{a.member?.user.name ?? "Unassigned queue"}</span>
                      <span className="text-muted-foreground"> · {METHOD_LABELS[a.method]}</span>
                      <div className="text-xs text-muted-foreground">
                        {formatDateTime(a.createdAt, tz)}
                        {a.reason && ` · ${a.reason}`}
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
