"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { LEAD_STATUS_LABELS, type LeadStatus } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";

export function LeadActions({
  leadId,
  status,
  nextStatuses,
  assignedMemberId,
  canAssign,
  members,
}: {
  leadId: string;
  status: LeadStatus;
  nextStatuses: LeadStatus[];
  assignedMemberId: string | null;
  canAssign: boolean;
  members: { id: string; name: string; isAvailable: boolean }[];
}) {
  const router = useRouter();
  const { submit, loading, error } = useSubmit();
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState("");
  const closed = status === "CONVERTED" || status === "LOST";

  const setStatus = async (next: LeadStatus, why?: string) => {
    if (await submit(`/api/leads/${leadId}/status`, { body: { status: next, reason: why } })) {
      setLosing(false);
      setReason("");
      router.refresh();
    }
  };

  const assign = async (memberId: string) => {
    if (await submit(`/api/leads/${leadId}/assign`, { body: { memberId: memberId || null } })) router.refresh();
  };

  const otherStatuses = nextStatuses.filter((s) => s !== "CONVERTED" && s !== "LOST");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        {!closed && !losing && (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" disabled={loading} onClick={() => setStatus("CONVERTED")} className="text-success">
              <CheckCircle2 className="size-4" aria-hidden /> Converted
            </Button>
            <Button variant="secondary" disabled={loading} onClick={() => setLosing(true)} className="text-destructive">
              <XCircle className="size-4" aria-hidden /> Lost
            </Button>
          </div>
        )}

        {losing && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <Field id="lost-reason" label="Why was this lead lost?" optional>
              <Input
                id="lost-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Chose a competitor, budget, no response"
              />
            </Field>
            <p className="text-xs text-muted-foreground">Marking a lead lost stops all automatic messages to this customer.</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setLosing(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="destructive" loading={loading} onClick={() => setStatus("LOST", reason || undefined)}>
                Mark as lost
              </Button>
            </div>
          </div>
        )}

        <Field id="status" label={closed ? "Reopen as" : "Change status"}>
          <Select
            id="status"
            value=""
            disabled={loading}
            onChange={(e) => e.target.value && setStatus(e.target.value as LeadStatus)}
          >
            <option value="">{LEAD_STATUS_LABELS[status]} — choose…</option>
            {otherStatuses.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>

        {canAssign && (
          <Field id="assignee" label="Assigned to">
            <Select id="assignee" value={assignedMemberId ?? ""} disabled={loading} onChange={(e) => assign(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.isAvailable ? "" : " (away)"}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </CardContent>
    </Card>
  );
}
