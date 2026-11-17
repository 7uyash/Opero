import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, listAuditLogs } from "@lfm/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getOrganization, requireAuth } from "@/lib/session";

export const metadata: Metadata = { title: "Audit log" };

const ACTION_LABELS: Record<string, string> = {
  "organization.created": "Created the business account",
  "organization.updated": "Updated business settings",
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in attempt",
  "member.invited": "Invited a team member",
  "member.invitation_revoked": "Cancelled an invitation",
  "member.joined": "Joined the team",
  "member.updated": "Changed a team member",
  "member.deactivated": "Deactivated a team member",
  "member.reactivated": "Reactivated a team member",
};

function describe(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  const m = metadata as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.email === "string") parts.push(m.email);
  if (typeof m.member === "string") parts.push(m.member);
  if (typeof m.role === "string") parts.push(m.role.toLowerCase());
  if (Array.isArray(m.fields)) parts.push(`changed: ${m.fields.join(", ")}`);
  if (m.changes && typeof m.changes === "object") parts.push(`changed: ${Object.keys(m.changes).join(", ")}`);
  return parts.join(" · ");
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { ctx } = await requireAuth();
  if (!can(ctx, "audit:view")) notFound();
  const { cursor } = await searchParams;
  const [{ items, nextCursor }, org] = await Promise.all([listAuditLogs(ctx, { cursor, limit: 50 }), getOrganization(ctx.organizationId)]);
  const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: org.timezone });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>Security and administration events for your business, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {items.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2 py-3">
                <div>
                  <div className="font-medium">{ACTION_LABELS[e.action] ?? e.action}</div>
                  <div className="text-muted-foreground">
                    {e.actor?.name ?? "System"}
                    {describe(e.metadata) && ` · ${describe(e.metadata)}`}
                  </div>
                </div>
                <time className="text-muted-foreground" dateTime={e.createdAt.toISOString()}>
                  {fmt.format(e.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex gap-4 text-sm">
          {cursor && (
            <Link href="/settings/audit" className="text-primary hover:underline">
              ← Newest
            </Link>
          )}
          {nextCursor && (
            <Link href={`/settings/audit?cursor=${nextCursor}`} className="text-primary hover:underline">
              Older →
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
