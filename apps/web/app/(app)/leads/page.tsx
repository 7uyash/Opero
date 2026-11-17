import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { can, listAssignableMembers, listLeads } from "@lfm/core";
import { SOURCE_LABELS } from "@lfm/shared";
import { PriorityBadge, StatusBadge } from "@/components/lead-badges";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatDate, formatDateTime } from "@/lib/format";
import { getOrganization, requireAuth } from "@/lib/session";
import { LeadFilters } from "./lead-filters";

export const metadata: Metadata = { title: "Leads" };

type SP = Record<string, string | undefined>;

function hrefWith(sp: SP, changes: SP) {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...changes })) if (v) next.set(k, v);
  const s = next.toString();
  return s ? `/leads?${s}` : "/leads";
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { ctx } = await requireAuth();
  const sp = await searchParams;
  const [result, org, members] = await Promise.all([
    listLeads(ctx, sp as never),
    getOrganization(ctx.organizationId),
    can(ctx, "leads:view_all") ? listAssignableMembers(ctx) : Promise.resolve([]),
  ]);
  const tz = org.timezone;
  const { items, total, page, pageCount, query } = result;
  const filtered = Object.keys(sp).some((k) => !["sort", "dir", "page"].includes(k) && sp[k]);

  const SortHeader = ({ field, label }: { field: typeof query.sort; label: string }) => {
    const active = query.sort === field;
    const dir = active && query.dir === "desc" ? "asc" : "desc";
    return (
      <Link href={hrefWith(sp, { sort: field, dir, page: undefined })} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        {active && (query.dir === "desc" ? <ArrowDown className="size-3" aria-label="descending" /> : <ArrowUp className="size-3" aria-label="ascending" />)}
      </Link>
    );
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="hidden text-sm text-muted-foreground sm:block">
            {can(ctx, "leads:view_all") ? "Every inquiry your business has received." : "Leads assigned to you."}
          </p>
        </div>
        <Link
          href="/leads/new"
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          <Plus className="size-4" aria-hidden /> <span>Add<span className="hidden sm:inline"> lead</span></span>
        </Link>
      </header>

      <LeadFilters members={members.map((m) => ({ id: m.id, name: m.name }))} showAssignee={can(ctx, "leads:view_all")} />

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-medium">{filtered ? "No leads match these filters" : "No leads yet"}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {filtered ? (
                <Link href="/leads" className="text-primary hover:underline">
                  Clear filters
                </Link>
              ) : (
                "Add your first lead by hand, or connect your website form to capture inquiries automatically."
              )}
            </p>
          </div>
        ) : (
          <>
          {/* Phones: one tappable card per lead. */}
          <ul className="divide-y divide-border md:hidden">
            {items.map((l) => {
              const overdue = l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date();
              return (
                <li key={l.id}>
                  <Link href={`/leads/${l.id}`} className="block px-4 py-3 active:bg-muted">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate font-medium text-primary">{l.name}</span>
                      <StatusBadge status={l.status} />
                    </div>
                    {l.subject && <p className="truncate text-sm text-muted-foreground">{l.subject}</p>}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {SOURCE_LABELS[l.source]} · {l.assignedTo?.name ?? <span className="text-warning">Unassigned</span>}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      {l.nextFollowUpAt ? (
                        <span className={overdue ? "font-medium text-destructive" : "text-muted-foreground"}>
                          {overdue ? "Overdue: " : "Follow up "}
                          {formatDateTime(l.nextFollowUpAt, tz)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Added {formatDate(l.createdAt, tz)}</span>
                      )}
                      <PriorityBadge priority={l.priority} />
                      {l.possibleDuplicate && <Badge tone="warning">Possible duplicate</Badge>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">
                    <SortHeader field="name" label="Name" />
                  </th>
                  <th className="px-4 py-2 font-medium">Contact</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Assigned to</th>
                  <th className="px-4 py-2 font-medium">
                    <SortHeader field="status" label="Status" />
                  </th>
                  <th className="px-4 py-2 font-medium">
                    <SortHeader field="lastContactAt" label="Last contact" />
                  </th>
                  <th className="px-4 py-2 font-medium">
                    <SortHeader field="nextFollowUpAt" label="Next follow-up" />
                  </th>
                  <th className="px-4 py-2 font-medium">
                    <SortHeader field="createdAt" label="Created" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => {
                  const overdue = l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date();
                  return (
                    <tr key={l.id} className="border-t border-border hover:bg-muted/50">
                      <td className="px-4 py-3">
                        <Link href={`/leads/${l.id}`} className="font-medium text-primary hover:underline">
                          {l.name}
                        </Link>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          <PriorityBadge priority={l.priority} />
                          {l.possibleDuplicate && <Badge tone="warning">Possible duplicate</Badge>}
                        </div>
                        {l.subject && <div className="max-w-56 truncate text-xs text-muted-foreground">{l.subject}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-56 truncate">{l.email ?? "—"}</div>
                        <div className="text-muted-foreground">{l.phone ?? ""}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{SOURCE_LABELS[l.source]}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {l.assignedTo?.name ?? <span className="text-warning">Unassigned</span>}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={l.status} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDateTime(l.lastContactAt, tz)}</td>
                      <td className={`px-4 py-3 whitespace-nowrap ${overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                        {formatDateTime(l.nextFollowUpAt, tz)}
                        {overdue && <span className="sr-only"> (overdue)</span>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDate(l.createdAt, tz)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

      {total > 0 && (
        <nav aria-label="Pagination" className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {total} lead{total === 1 ? "" : "s"} · page {page} of {pageCount}
          </span>
          <div className="flex gap-3">
            {page > 1 && (
              <Link href={hrefWith(sp, { page: String(page - 1) })} className="text-primary hover:underline">
                ← Previous
              </Link>
            )}
            {page < pageCount && (
              <Link href={hrefWith(sp, { page: String(page + 1) })} className="text-primary hover:underline">
                Next →
              </Link>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
