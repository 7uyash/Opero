"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { DEFAULT_FOLLOW_UP_STEPS, MAX_FOLLOW_UP_STEPS } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";

type Unit = "hours" | "days";
type Ch = "EMAIL" | "WHATSAPP";
type Row = { name: string; amount: number; unit: Unit; active: boolean; channels: Ch[] };

const toRow = (s: { name: string; delayMinutes: number; active: boolean; channels?: Ch[] }): Row => {
  const channels = s.channels ?? (["EMAIL", "WHATSAPP"] as Ch[]);
  return s.delayMinutes % 1440 === 0
    ? { name: s.name, amount: s.delayMinutes / 1440, unit: "days", active: s.active, channels }
    : { name: s.name, amount: Math.round(s.delayMinutes / 60), unit: "hours", active: s.active, channels };
};
const toMinutes = (r: Row) => Math.round(r.amount * (r.unit === "days" ? 1440 : 60));

export function RulesForm({ canEdit, initial }: { canEdit: boolean; initial: { name: string; delayMinutes: number; active: boolean; channels: Ch[] }[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(initial.map(toRow));
  const { submit, loading, error, fields, success } = useSubmit();
  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save() {
    const steps = rows.map((r) => ({ name: r.name, delayMinutes: toMinutes(r), active: r.active }));
    if (!(await submit("/api/automation/follow-up-rules", { method: "PUT", body: { steps } }))) return;
    const channels = rows.map((r, i) => ({ stepIndex: i + 1, channels: r.channels }));
    if (await submit("/api/automation/follow-up-rules/channels", { method: "PUT", body: { steps: channels } }, "Follow-up schedule saved.")) router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Follow-up schedule</CardTitle>
          <CardDescription>
            Each new lead gets these reminders, counted from when it arrived — or from your team's last contact with the
            customer. Reminders only fall within your{" "}
            <Link href="/settings/hours" className="text-primary hover:underline">
              working hours
            </Link>
            . Changes apply to new and recalculated schedules.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="space-y-3">
            {rows.map((r, i) => {
              const err = fields[`steps.${i}.delayMinutes`] ?? fields[`steps.${i}.name`];
              return (
                <li key={i} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-6 text-right text-sm text-muted-foreground">{i + 1}.</span>
                    <Input
                      aria-label={`Step ${i + 1} name`}
                      value={r.name}
                      disabled={!canEdit}
                      onChange={(e) => update(i, { name: e.target.value })}
                      className="w-48"
                    />
                    <Input
                      type="number"
                      min={1}
                      aria-label={`Step ${i + 1} delay`}
                      value={r.amount}
                      disabled={!canEdit}
                      onChange={(e) => update(i, { amount: Number(e.target.value) })}
                      className="w-24"
                    />
                    <Select
                      aria-label={`Step ${i + 1} unit`}
                      value={r.unit}
                      disabled={!canEdit}
                      onChange={(e) => update(i, { unit: e.target.value as Unit })}
                      className="w-28"
                    >
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </Select>
                    <span className="text-sm text-muted-foreground">after the start</span>
                    <label className="ml-2 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={r.active}
                        disabled={!canEdit}
                        onChange={(e) => update(i, { active: e.target.checked })}
                      />
                      On
                    </label>
                    <span className="ml-2 flex items-center gap-2 text-sm text-muted-foreground">
                      Message:
                      {(["EMAIL", "WHATSAPP"] as const).map((c) => (
                        <label key={c} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={r.channels.includes(c)}
                            disabled={!canEdit}
                            onChange={(e) => update(i, { channels: e.target.checked ? [...r.channels, c] : r.channels.filter((x) => x !== c) })}
                          />
                          {c === "EMAIL" ? "Email" : "WhatsApp"}
                        </label>
                      ))}
                    </span>
                    {canEdit && rows.length > 1 && (
                      <Button variant="ghost" size="sm" aria-label={`Remove step ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    )}
                  </div>
                  {err && <p className="pl-8 text-sm text-destructive">{err}</p>}
                </li>
              );
            })}
          </ol>
          {canEdit && (
            <div className="flex flex-wrap gap-2 pl-8">
              {rows.length < MAX_FOLLOW_UP_STEPS && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const last = rows.at(-1);
                    setRows((rs) => [
                      ...rs,
                      { name: `Reminder ${rs.length + 1}`, amount: last ? (last.unit === "days" ? last.amount * 2 : 48) : 1, unit: "days", active: true, channels: last?.channels ?? ["EMAIL"] },
                    ]);
                  }}
                >
                  <Plus className="size-4" aria-hidden /> Add step
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setRows(DEFAULT_FOLLOW_UP_STEPS.map((s) => toRow({ ...s, active: true, channels: ["EMAIL", "WHATSAPP"] })))}>
                Reset to 24 h / 3 / 7 / 14 days
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">When reminders stop or pause</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>The customer replies → automatic follow-ups pause and the assigned person is told to get back to them.</li>
            <li>Someone on your team contacts the customer → the next reminders are re-timed from that moment.</li>
            <li>The lead is converted or lost → all reminders stop.</li>
            <li>The lead is put on hold → reminders pause until it's taken off hold.</li>
          </ul>
        </CardContent>
      </Card>

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
      {canEdit ? (
        <div className="flex justify-end">
          <Button onClick={save} loading={loading}>
            Save schedule
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only owners and admins can change the follow-up schedule.</p>
      )}
    </div>
  );
}
