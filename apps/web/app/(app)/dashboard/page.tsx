import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { can, getDashboardOverview, getInstallState, listLeads } from "@lfm/core";
import { prisma } from "@lfm/db";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, ROLE_LABELS, SOURCE_LABELS, type SourceType } from "@lfm/shared";
import { StatusBadge } from "@/components/lead-badges";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercent, formatRelative } from "@/lib/format";
import { getOrganization, requireAuth } from "@/lib/session";

export const metadata: Metadata = { title: "Overview" };

function Stat({ label, value, hint, href, tone }: { label: string; value: string | number; hint?: string; href?: string; tone?: "danger" | "warning" }) {
  const body = (
    <Card className={`h-full p-4 ${href ? "transition-colors hover:bg-muted/60" : ""}`}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone === "danger" ? "text-destructive" : tone === "warning" ? "text-warning" : ""}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export default async function DashboardPage() {
  const { session, ctx } = await requireAuth();
  const [org, overview, recent, memberCount, inviteCount, install, connectedSources] = await Promise.all([
    getOrganization(ctx.organizationId),
    getDashboardOverview(ctx),
    listLeads(ctx, { pageSize: 5, sort: "createdAt", dir: "desc", includeClosed: true }),
    prisma.organizationMember.count({ where: { organizationId: ctx.organizationId } }),
    prisma.invitation.count({ where: { organizationId: ctx.organizationId, revokedAt: null } }),
    getInstallState(ctx.organizationId),
    prisma.integration.count({
      where: { organizationId: ctx.organizationId, status: "CONNECTED", provider: { in: ["WEBSITE_FORM", "GMAIL", "WHATSAPP_CLOUD", "META_LEAD_ADS", "HUBSPOT"] } },
    }),
  ]);
  const { stats, team } = overview;
  const isManager = can(ctx, "dashboard:view_team");

  // Getting-started checklist; later steps are wired up as those sections are built.
  const steps: { label: string; done: boolean; href?: string }[] = [
    { label: "Create your business account", done: true },
    { label: "Invite your team", done: memberCount > 1 || inviteCount > 0, href: "/settings/team" },
    { label: "Add your first lead", done: stats.total > 0, href: "/leads/new" },
    { label: "Install Lead & Follow-up Manager", done: install.installed, href: "/automation" },
    { label: "Connect where your leads come from", done: connectedSources > 0, href: "/integrations" },
    { label: "Review messages and turn on automation", done: install.status === "ACTIVE", href: "/automation" },
  ];
  const showChecklist = isManager && steps.some((s) => !s.done);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Welcome, {session.user.name.split(" ")[0]}</h1>
        <p className="text-sm text-muted-foreground">
          {isManager ? `${org.name} at a glance` : "Your leads at a glance"} · times in {org.timezone.replaceAll("_", " ")}
        </p>
      </header>

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total leads" value={stats.total} href="/leads?includeClosed=true" />
        <Stat label="New today" value={stats.newToday} />
        <Stat label="Awaiting follow-up" value={stats.awaitingFollowUp} href="/leads?followUp=week" />
        <Stat
          label="Overdue follow-ups"
          value={stats.overdueFollowUps}
          tone={stats.overdueFollowUps ? "danger" : undefined}
          href="/leads?followUp=overdue"
        />
        <Stat label="Converted" value={stats.converted} href="/leads?status=CONVERTED" />
        <Stat label="Lost" value={stats.lost} href="/leads?status=LOST" />
        <Stat label="Conversion rate" value={formatPercent(stats.conversionRate)} hint="Converted out of all decided leads" />
        {isManager && (
          <Stat
            label="Unassigned"
            value={stats.unassigned}
            tone={stats.unassigned ? "warning" : undefined}
            href="/leads?assignee=unassigned"
            hint="Open leads nobody owns yet"
          />
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {team && (
            <Card>
              <CardHeader>
                <CardTitle>Team performance</CardTitle>
                <CardDescription>All-time numbers for each active team member.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="py-2 pr-4 font-medium">Member</th>
                      <th className="py-2 pr-4 text-right font-medium">Assigned</th>
                      <th className="py-2 pr-4 text-right font-medium">Open</th>
                      <th className="py-2 pr-4 text-right font-medium">Not yet contacted</th>
                      <th className="py-2 pr-4 text-right font-medium">Overdue</th>
                      <th className="py-2 pr-4 text-right font-medium">Converted</th>
                      <th className="py-2 text-right font-medium">Conversion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {team.map((m) => (
                      <tr key={m.memberId} className="border-b border-border last:border-0">
                        <td className="py-2 pr-4">
                          <Link href={`/leads?assignee=${m.memberId}`} className="font-medium hover:underline">
                            {m.name}
                          </Link>
                          <span className="ml-1 text-xs text-muted-foreground">
                            {ROLE_LABELS[m.role]}
                            {!m.isAvailable && " · away"}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right">{m.assigned}</td>
                        <td className="py-2 pr-4 text-right">{m.open}</td>
                        <td className={`py-2 pr-4 text-right ${m.awaitingFirstContact ? "text-warning" : ""}`}>{m.awaitingFirstContact}</td>
                        <td className={`py-2 pr-4 text-right ${m.overdue ? "font-medium text-destructive" : ""}`}>{m.overdue}</td>
                        <td className="py-2 pr-4 text-right">{m.converted}</td>
                        <td className="py-2 text-right">{formatPercent(m.conversionRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Latest leads</CardTitle>
              <Link href="/leads" className="text-sm text-primary hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent>
              {recent.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No leads yet.{" "}
                  <Link href="/leads/new" className="text-primary hover:underline">
                    Add your first lead
                  </Link>
                </p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {recent.items.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div>
                        <Link href={`/leads/${l.id}`} className="font-medium hover:underline">
                          {l.name}
                        </Link>
                        <span className="text-muted-foreground">
                          {" "}
                          · {SOURCE_LABELS[l.source]} · {l.assignedTo?.name ?? "Unassigned"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={l.status} />
                        <span className="text-xs text-muted-foreground">{formatRelative(l.createdAt)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-6">
          {showChecklist && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Get started</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3">
                  {steps.map((s) => (
                    <li key={s.label} className="flex items-center gap-3 text-sm">
                      {s.done ? (
                        <CheckCircle2 className="size-5 shrink-0 text-success" aria-label="Done" />
                      ) : (
                        <Circle className="size-5 shrink-0 text-muted-foreground" aria-label="Not done" />
                      )}
                      {s.href && !s.done ? (
                        <Link href={s.href} className="font-medium text-primary hover:underline">
                          {s.label}
                        </Link>
                      ) : (
                        <span className={s.done ? "text-muted-foreground line-through" : ""}>{s.label}</span>
                      )}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pipeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {LEAD_STATUSES.filter((s) => stats.byStatus[s]).map((s) => (
                  <li key={s} className="flex justify-between">
                    <Link href={`/leads?status=${s}`} className="hover:underline">
                      {LEAD_STATUS_LABELS[s]}
                    </Link>
                    <span className="font-medium">{stats.byStatus[s]}</span>
                  </li>
                ))}
                {stats.total === 0 && <li className="text-muted-foreground">Nothing here yet.</li>}
              </ul>
              {Object.keys(stats.bySource).length > 0 && (
                <>
                  <p className="mt-4 mb-2 text-sm font-medium">By source</p>
                  <ul className="space-y-2 text-sm">
                    {Object.entries(stats.bySource).map(([src, n]) => (
                      <li key={src} className="flex justify-between">
                        <span>{SOURCE_LABELS[src as SourceType]}</span>
                        <span className="font-medium">{n}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
