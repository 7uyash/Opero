"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { WEEKDAYS, WEEKDAY_LABELS, type Holiday, type WorkingHours } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSubmit } from "@/lib/use-submit";

export function HoursForm({
  canEdit,
  timezone,
  initialHours,
  initialHolidays,
}: {
  canEdit: boolean;
  timezone: string;
  initialHours: WorkingHours;
  initialHolidays: Holiday[];
}) {
  const router = useRouter();
  const [hours, setHours] = useState<WorkingHours>(initialHours);
  const [holidays, setHolidays] = useState<Holiday[]>(initialHolidays);
  const [newHoliday, setNewHoliday] = useState<Holiday>({ date: "", name: "" });
  const { submit, loading, error, fields, success } = useSubmit();

  const setDay = (day: keyof WorkingHours, ranges: WorkingHours[keyof WorkingHours]) => setHours((h) => ({ ...h, [day]: ranges }));

  async function save() {
    const ok = await submit("/api/organizations", { method: "PATCH", body: { workingHours: hours, holidays } }, "Working hours saved.");
    if (ok) router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Working hours</CardTitle>
          <CardDescription>
            Automatic messages and follow-up reminders are only sent during these hours ({timezone.replaceAll("_", " ")}).
            Anything due outside them waits for the next opening.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!canEdit} className="divide-y divide-border">
            {WEEKDAYS.map((day) => {
              const ranges = hours[day];
              const open = ranges.length > 0;
              const err = Object.entries(fields).find(([k]) => k.startsWith(`workingHours.${day}`))?.[1];
              return (
                <div key={day} className="flex flex-wrap items-start gap-4 py-3">
                  <label className="flex w-36 items-center gap-2 pt-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={open}
                      onChange={(e) => setDay(day, e.target.checked ? [{ start: "09:00", end: "18:00" }] : [])}
                      className="size-4 accent-primary"
                    />
                    {WEEKDAY_LABELS[day]}
                  </label>
                  <div className="flex-1 space-y-2">
                    {!open && <p className="pt-2 text-sm text-muted-foreground">Closed</p>}
                    {ranges.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          type="time"
                          aria-label={`${WEEKDAY_LABELS[day]} opens`}
                          value={r.start}
                          onChange={(e) => setDay(day, ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
                          className="w-32"
                        />
                        <span className="text-sm text-muted-foreground">to</span>
                        <Input
                          type="time"
                          aria-label={`${WEEKDAY_LABELS[day]} closes`}
                          value={r.end}
                          onChange={(e) => setDay(day, ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
                          className="w-32"
                        />
                        {canEdit && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label="Remove time range"
                            onClick={() => setDay(day, ranges.filter((_, j) => j !== i))}
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        )}
                      </div>
                    ))}
                    {open && canEdit && ranges.length < 3 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDay(day, [...ranges, { start: "14:00", end: "18:00" }])}
                      >
                        <Plus className="size-4" aria-hidden /> Add break / second shift
                      </Button>
                    )}
                    {err && <p className="text-sm text-destructive">{err}</p>}
                  </div>
                </div>
              );
            })}
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Holidays</CardTitle>
          <CardDescription>No automatic messages are sent on these dates.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {holidays.length === 0 ? (
            <p className="text-sm text-muted-foreground">No holidays added yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {holidays.map((h) => (
                <li key={h.date} className="flex items-center justify-between py-2">
                  <span>
                    <span className="font-medium">
                      {new Date(`${h.date}T00:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" })}
                    </span>
                    {h.name && <span className="text-muted-foreground"> · {h.name}</span>}
                  </span>
                  {canEdit && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${h.name || h.date}`}
                      onClick={() => setHolidays((list) => list.filter((x) => x.date !== h.date))}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div className="flex flex-wrap items-end gap-2">
              <Input
                type="date"
                aria-label="Holiday date"
                value={newHoliday.date}
                onChange={(e) => setNewHoliday((h) => ({ ...h, date: e.target.value }))}
                className="w-44"
              />
              <Input
                aria-label="Holiday name"
                placeholder="Name (optional)"
                value={newHoliday.name}
                onChange={(e) => setNewHoliday((h) => ({ ...h, name: e.target.value }))}
                className="w-56"
              />
              <Button
                type="button"
                variant="secondary"
                disabled={!newHoliday.date || holidays.some((h) => h.date === newHoliday.date)}
                onClick={() => {
                  setHolidays((list) =>
                    [...list, { date: newHoliday.date, name: newHoliday.name || undefined }].sort((a, b) => a.date.localeCompare(b.date)),
                  );
                  setNewHoliday({ date: "", name: "" });
                }}
              >
                <Plus className="size-4" aria-hidden /> Add holiday
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
      {canEdit ? (
        <div className="flex justify-end">
          <Button onClick={save} loading={loading}>
            Save working hours
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only the business owner can change working hours.</p>
      )}
    </div>
  );
}
