"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/fetcher";

type Option = { key: string; label: string; state: "connected" | "not_connected" | "ready" };

/** Lead-source selection. Choosing a source never marks it as connected — the badge shows the truth. */
export function SourcePicker({ selected: initial, options }: { selected: string[]; options: Option[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function toggle(key: string) {
    const next = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
    setSelected(next);
    setSaving(true);
    try {
      await api("/api/automation/sources", { method: "PUT", body: { selected: next } });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((o) => {
          const on = selected.includes(o.key);
          return (
            <label key={o.key} className={`flex cursor-pointer items-start justify-between gap-3 rounded-md border p-3 text-sm ${on ? "border-primary" : "border-border"}`}>
              <span className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={on} disabled={saving} onChange={() => toggle(o.key)} />
                <span className="font-medium">{o.label}</span>
              </span>
              {on &&
                (o.state === "connected" ? (
                  <Badge tone="success">Connected</Badge>
                ) : o.state === "ready" ? (
                  <Badge tone="success">Ready</Badge>
                ) : (
                  <Badge tone="warning">Not connected yet</Badge>
                ))}
            </label>
          );
        })}
      </CardContent>
    </Card>
  );
}
