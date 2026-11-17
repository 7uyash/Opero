"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Check, Copy, UserPlus } from "lucide-react";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { api, ApiRequestError } from "@/lib/fetcher";
import { useSubmit } from "@/lib/use-submit";

type Member = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "INVITED" | "ACTIVE" | "DISABLED";
  receivesLeads: boolean;
  isAvailable: boolean;
  unavailableUntil: string | null;
  isFallbackManager: boolean;
};
type Invitation = { id: string; email: string; name: string | null; role: Role; expiresAt: string; expired: boolean };

const MANAGER_ROLES: Role[] = ["OWNER", "ADMIN", "MANAGER"];

export function TeamManager({
  me,
  canManage,
  grantableRoles,
  members,
  invitations,
}: {
  me: { memberId: string; role: Role };
  canManage: boolean;
  grantableRoles: Role[];
  members: Member[];
  invitations: Invitation[];
}) {
  const router = useRouter();
  const [rowError, setRowError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const describeShare = (r: { reassigned: number; unassigned: number }) =>
    r.reassigned + r.unassigned === 0
      ? "They had no open leads to hand over."
      : `${r.reassigned} open lead${r.reassigned === 1 ? "" : "s"} shared with the team` +
        (r.unassigned ? `, ${r.unassigned} moved to the unassigned queue because nobody was available.` : ".");

  async function patch(memberId: string, body: Record<string, unknown>) {
    setBusy(memberId);
    setRowError(undefined);
    setNotice(undefined);
    try {
      const res = await api<{ redistributed: { reassigned: number; unassigned: number } | null }>(`/api/members/${memberId}`, {
        method: "PATCH",
        body,
      });
      if (res.redistributed) setNotice(`Deactivated. ${describeShare(res.redistributed)}`);
      router.refresh();
    } catch (err) {
      setRowError(err instanceof ApiRequestError ? err.body.message : "Could not save the change.");
    } finally {
      setBusy(undefined);
    }
  }

  async function shareLeads(m: Member) {
    if (!confirm(`Share all of ${m.name}'s open leads with the rest of the team?`)) return;
    setBusy(m.id);
    setRowError(undefined);
    setNotice(undefined);
    try {
      const r = await api<{ reassigned: number; unassigned: number }>(`/api/members/${m.id}/redistribute`, { method: "POST" });
      setNotice(`${m.name}: ${describeShare(r)}`);
      router.refresh();
    } catch (err) {
      setRowError(err instanceof ApiRequestError ? err.body.message : "Could not share the leads.");
    } finally {
      setBusy(undefined);
    }
  }

  async function revoke(id: string) {
    setBusy(id);
    try {
      await api(`/api/members/invitations/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setRowError(err instanceof ApiRequestError ? err.body.message : "Could not cancel the invitation.");
    } finally {
      setBusy(undefined);
    }
  }

  const canEditMember = (m: Member) =>
    canManage && m.id !== me.memberId && m.role !== "OWNER" && grantableRoles.includes(m.role);
  // Owners/admins/managers may edit their own assignment settings too.
  const canEditAssignment = (m: Member) => canEditMember(m) || (m.id === me.memberId && MANAGER_ROLES.includes(me.role));

  const active = members.filter((m) => m.status === "ACTIVE");
  const takingLeads = active.filter((m) => m.receivesLeads && m.isAvailable);

  return (
    <div className="space-y-6">
      {canManage && <InviteCard grantableRoles={grantableRoles} onInvited={() => router.refresh()} />}

      <Card>
        <CardHeader>
          <CardTitle>Team members</CardTitle>
          <CardDescription>
            {active.length} active · {takingLeads.length} currently receiving new leads. New leads are shared in turn among
            people who are active, receive leads and are available.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {rowError && <Alert tone="error">{rowError}</Alert>}
          {notice && <Alert tone="success">{notice}</Alert>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Role</th>
                  <th className="py-2 pr-4 font-medium">Receives leads</th>
                  <th className="py-2 pr-4 font-medium">Available</th>
                  <th className="py-2 pr-4 font-medium">Fallback</th>
                  <th className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const editable = canEditMember(m);
                  const assignEditable = canEditAssignment(m) && m.status === "ACTIVE";
                  const disabled = busy === m.id;
                  return (
                    <tr key={m.id} className="border-b border-border last:border-0 align-middle">
                      <td className="py-3 pr-4">
                        <div className="font-medium">
                          {m.name}
                          {m.id === me.memberId && <span className="ml-1 text-muted-foreground">(you)</span>}
                        </div>
                        <div className="text-muted-foreground">{m.email}</div>
                        {m.status === "DISABLED" && (
                          <Badge tone="danger" className="mt-1">
                            Deactivated
                          </Badge>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        {editable && m.status === "ACTIVE" ? (
                          <Select
                            aria-label={`Role for ${m.name}`}
                            value={m.role}
                            disabled={disabled}
                            onChange={(e) => patch(m.id, { role: e.target.value })}
                            className="h-9 w-36"
                          >
                            {grantableRoles.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          ROLE_LABELS[m.role]
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <YesNo
                          value={m.receivesLeads}
                          editable={assignEditable}
                          disabled={disabled}
                          label={`${m.name} receives leads`}
                          onChange={(v) => patch(m.id, { receivesLeads: v })}
                        />
                      </td>
                      <td className="py-3 pr-4">
                        <YesNo
                          value={m.isAvailable}
                          editable={assignEditable}
                          disabled={disabled}
                          label={`${m.name} is available`}
                          onChange={(v) => patch(m.id, { isAvailable: v, unavailableUntil: null })}
                        />
                        {m.unavailableUntil && new Date(m.unavailableUntil) > new Date() && (
                          <div className="text-xs text-muted-foreground">
                            Away until {new Date(m.unavailableUntil).toLocaleDateString()}
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        {MANAGER_ROLES.includes(m.role) ? (
                          <YesNo
                            value={m.isFallbackManager}
                            editable={assignEditable}
                            disabled={disabled}
                            label={`${m.name} is a fallback manager`}
                            onChange={(v) => patch(m.id, { isFallbackManager: v })}
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="space-x-2 py-3 text-right whitespace-nowrap">
                        {canManage && m.status === "ACTIVE" && (editable || m.id === me.memberId) && (
                          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => shareLeads(m)}>
                            Share open leads
                          </Button>
                        )}
                        {editable &&
                          (m.status === "ACTIVE" ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={disabled}
                              onClick={() => {
                                if (
                                  confirm(
                                    `Deactivate ${m.name}? They lose access immediately and their open leads are shared with the team.`,
                                  )
                                ) {
                                  void patch(m.id, { status: "DISABLED" });
                                }
                              }}
                            >
                              Deactivate
                            </Button>
                          ) : (
                            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => patch(m.id, { status: "ACTIVE" })}>
                              Reactivate
                            </Button>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Fallback managers receive leads when nobody else is available. If there is no fallback manager, those leads wait
            in the unassigned queue.
          </p>
        </CardContent>
      </Card>

      {invitations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending invitations</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border text-sm">
              {invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <div className="font-medium">{i.name || i.email}</div>
                    <div className="text-muted-foreground">
                      {i.name && `${i.email} · `}
                      {ROLE_LABELS[i.role]} ·{" "}
                      {i.expired ? (
                        <span className="text-destructive">expired</span>
                      ) : (
                        `expires ${new Date(i.expiresAt).toLocaleDateString()}`
                      )}
                    </div>
                  </div>
                  {canManage && grantableRoles.includes(i.role) && (
                    <Button size="sm" variant="ghost" disabled={busy === i.id} onClick={() => revoke(i.id)}>
                      Cancel invitation
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function YesNo({
  value,
  editable,
  disabled,
  label,
  onChange,
}: {
  value: boolean;
  editable: boolean;
  disabled?: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  if (!editable) return <span className={value ? "" : "text-muted-foreground"}>{value ? "Yes" : "No"}</span>;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${value ? "bg-primary" : "bg-input"}`}
    >
      <span className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${value ? "translate-x-4.5" : "translate-x-0.5"}`} />
    </button>
  );
}

function InviteCard({ grantableRoles, onInvited }: { grantableRoles: Role[]; onInvited: () => void }) {
  const { submit, loading, error, fields } = useSubmit();
  const [role, setRole] = useState<Role>(grantableRoles.includes("SALESPERSON") ? "SALESPERSON" : grantableRoles[0]!);
  const [link, setLink] = useState<{ url: string; email: string; emailed: boolean }>();
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const res = await submit<{ inviteUrl: string; invitation: { email: string }; emailSent: boolean }>("/api/members", {
      body: { email: f.get("email"), name: f.get("name"), role },
    });
    if (res) {
      setLink({ url: res.inviteUrl, email: res.invitation.email, emailed: res.emailSent });
      setCopied(false);
      form.reset();
      onInvited();
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a team member</CardTitle>
        <CardDescription>Each person gets their own login. They only see what their role allows.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-[1fr_1fr_12rem_auto] sm:items-end" noValidate>
          <Field id="invite-email" label="Email" error={fields.email}>
            <Input id="invite-email" name="email" type="email" required aria-invalid={!!fields.email} />
          </Field>
          <Field id="invite-name" label="Name" optional>
            <Input id="invite-name" name="name" />
          </Field>
          <Field id="invite-role" label="Role" error={fields.role}>
            <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {grantableRoles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" loading={loading}>
            <UserPlus className="size-4" aria-hidden />
            Invite
          </Button>
        </form>
        <p className="text-sm text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
        {error && <Alert tone="error">{error}</Alert>}
        {link && (
          <Alert tone="success">
            <p>
              {link.emailed ? (
                <>
                  We emailed the invitation to <strong>{link.email}</strong>. You can also share this link — it works once and expires in 7 days.
                </>
              ) : (
                <>
                  Invitation created for <strong>{link.email}</strong>. Send them this link — it works once and expires in 7 days. Invitation
                  emails are sent automatically once an email account is connected under Integrations.
                </>
              )}
            </p>
            <div className="mt-2 flex gap-2">
              <Input readOnly value={link.url} aria-label="Invitation link" className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button
                type="button"
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(link.url);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
