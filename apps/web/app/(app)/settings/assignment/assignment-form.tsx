"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ASSIGNMENT_MODES,
  ASSIGNMENT_MODE_LABELS,
  DUPLICATE_POLICIES,
  DUPLICATE_POLICY_LABELS,
  ROLE_LABELS,
  type AssignmentMode,
  type DuplicatePolicy,
  type Role,
} from "@lfm/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { useSubmit } from "@/lib/use-submit";
import { cn } from "@/lib/utils";

type Values = { mode: AssignmentMode; useFallbackManager: boolean; redistributeOnDeactivate: boolean; duplicatePolicy: DuplicatePolicy };
type Rotation = {
  ring: { id: string; name: string; role: Role; available: boolean; isNext: boolean }[];
  fallbacks: { id: string; name: string; available: boolean }[];
};

function RadioCards<T extends string>({
  name,
  value,
  options,
  labels,
  onChange,
  disabled,
}: {
  name: string;
  value: T;
  options: readonly T[];
  labels: Record<T, { label: string; description: string }>;
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <div role="radiogroup" className="grid gap-3 sm:grid-cols-2">
      {options.map((o) => (
        <label
          key={o}
          className={cn(
            "cursor-pointer rounded-md border p-4 text-sm",
            value === o ? "border-primary ring-1 ring-primary" : "border-border hover:bg-muted/50",
            disabled && "cursor-default opacity-80",
          )}
        >
          <input type="radio" name={name} value={o} checked={value === o} onChange={() => onChange(o)} disabled={disabled} className="sr-only" />
          <span className="font-medium">{labels[o].label}</span>
          <span className="mt-1 block text-muted-foreground">{labels[o].description}</span>
        </label>
      ))}
    </div>
  );
}

export function AssignmentForm({ canEdit, initial, rotation }: { canEdit: boolean; initial: Values; rotation: Rotation }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const { submit, loading, error, success } = useSubmit();
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((x) => ({ ...x, [k]: val }));

  async function save() {
    if (await submit("/api/automation/assignment", { method: "PATCH", body: v }, "Assignment settings saved.")) router.refresh();
  }

  const available = rotation.ring.filter((r) => r.available);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>How new leads are assigned</CardTitle>
          <CardDescription>Applies to every lead that arrives without a chosen team member.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <RadioCards name="mode" value={v.mode} options={ASSIGNMENT_MODES} labels={ASSIGNMENT_MODE_LABELS} onChange={(m) => set("mode", m)} disabled={!canEdit} />
          <Toggle
            id="fallback"
            label="Use a fallback manager when nobody is available"
            description="Otherwise those leads wait in the unassigned queue and managers are notified."
            checked={v.useFallbackManager}
            onChange={(b) => set("useFallbackManager", b)}
            disabled={!canEdit}
          />
          <Toggle
            id="redistribute"
            label="Share a person's open leads with the team when they're deactivated"
            checked={v.redistributeOnDeactivate}
            onChange={(b) => set("redistributeOnDeactivate", b)}
            disabled={!canEdit}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>When a known customer gets in touch again</CardTitle>
          <CardDescription>For leads arriving automatically from your website, email or WhatsApp. When adding leads by hand you're always asked.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioCards
            name="duplicates"
            value={v.duplicatePolicy}
            options={DUPLICATE_POLICIES}
            labels={DUPLICATE_POLICY_LABELS}
            onChange={(p) => set("duplicatePolicy", p)}
            disabled={!canEdit}
          />
        </CardContent>
      </Card>

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}
      {canEdit ? (
        <div className="flex justify-end">
          <Button onClick={save} loading={loading}>
            Save assignment settings
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only owners and admins can change these settings.</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Current rotation</CardTitle>
          <CardDescription>
            {v.mode === "MANUAL"
              ? "Round-robin is off; new leads are not assigned automatically."
              : available.length
                ? `${available.length} of ${rotation.ring.length} people are taking leads right now.`
                : "Nobody in the rotation is available right now."}{" "}
            <Link href="/settings/team" className="text-primary hover:underline">
              Manage the team
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {rotation.ring.length === 0 ? (
            <Alert tone="info">Nobody is set to receive leads. Turn on “Receives leads” for at least one person on the Team page.</Alert>
          ) : (
            <ol className="space-y-2 text-sm">
              {rotation.ring.map((r, i) => (
                <li key={r.id} className="flex items-center gap-3">
                  <span className="w-5 text-right text-muted-foreground">{i + 1}.</span>
                  <span className={r.available ? "" : "text-muted-foreground line-through"}>{r.name}</span>
                  <span className="text-xs text-muted-foreground">{ROLE_LABELS[r.role]}</span>
                  {!r.available && <Badge>Away — skipped</Badge>}
                  {r.isNext && v.mode === "ROUND_ROBIN" && <Badge tone="info">Next</Badge>}
                </li>
              ))}
            </ol>
          )}
          <p className="text-sm text-muted-foreground">
            Fallback manager{rotation.fallbacks.length === 1 ? "" : "s"}:{" "}
            {rotation.fallbacks.length
              ? rotation.fallbacks.map((f) => `${f.name}${f.available ? "" : " (away)"}`).join(", ")
              : "none — set one on the Team page"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
