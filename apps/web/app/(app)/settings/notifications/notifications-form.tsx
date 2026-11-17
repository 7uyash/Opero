"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { useSubmit } from "@/lib/use-submit";

type Prefs = Record<NotificationEvent, { inApp: boolean; email: boolean }>;

/** Converts an ISO string to the value format of <input type="date"> in local time. */
function toDateInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function NotificationsForm({
  initialPrefs,
  initialAvailable,
  initialUntil,
  receivesLeads,
}: {
  initialPrefs: Prefs;
  initialAvailable: boolean;
  initialUntil: string | null;
  receivesLeads: boolean;
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState(initialPrefs);
  const [available, setAvailable] = useState(initialAvailable);
  const [until, setUntil] = useState(toDateInput(initialUntil));
  const { submit, loading, error, success } = useSubmit();

  async function save() {
    // "Away until" means through the end of that local day.
    const unavailableUntil = !available && until ? new Date(`${until}T23:59:59`).toISOString() : null;
    const ok = await submit(
      "/api/members/me",
      { method: "PATCH", body: { notificationPrefs: prefs, isAvailable: available, unavailableUntil } },
      "Preferences saved.",
    );
    if (ok) router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>My availability</CardTitle>
          <CardDescription>
            {receivesLeads
              ? "While you're away, new leads go to your teammates instead of you."
              : "You're currently not set to receive new leads. A manager can change this on the Team page."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Toggle
            id="available"
            label="I'm available for new leads"
            checked={available}
            onChange={(v) => {
              setAvailable(v);
              if (v) setUntil("");
            }}
          />
          {!available && (
            <Field id="until" label="Away until" optional hint="Leave empty to stay away until you switch this back on.">
              <Input id="until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="w-48" />
            </Field>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notify me when…</CardTitle>
          <CardDescription>Email notifications start once your business connects an email account.</CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 font-medium">Event</th>
                <th className="w-20 py-2 text-center font-medium">In app</th>
                <th className="w-20 py-2 text-center font-medium">Email</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(NOTIFICATION_EVENTS) as NotificationEvent[]).map((k) => (
                <tr key={k} className="border-b border-border last:border-0">
                  <td className="py-3">{NOTIFICATION_EVENTS[k]}</td>
                  {(["inApp", "email"] as const).map((ch) => (
                    <td key={ch} className="py-3 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${NOTIFICATION_EVENTS[k]} — ${ch === "inApp" ? "in app" : "email"}`}
                        className="size-4 accent-primary"
                        checked={prefs[k][ch]}
                        onChange={(e) => setPrefs((p) => ({ ...p, [k]: { ...p[k], [ch]: e.target.checked } }))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
      <div className="flex justify-end">
        <Button onClick={save} loading={loading}>
          Save preferences
        </Button>
      </div>
    </div>
  );
}
