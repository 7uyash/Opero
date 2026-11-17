"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { LEAD_PRIORITIES, LEAD_STATUSES, LEAD_STATUS_LABELS, PRIORITY_LABELS, SOURCE_LABELS, SOURCE_TYPES } from "@lfm/shared";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";

const FOLLOW_UP_LABELS = { overdue: "Overdue", today: "Due today", week: "Due in 7 days", none: "No follow-up scheduled" };

/** Filter bar that keeps all state in the URL so filtered views can be bookmarked and shared. */
export function LeadFilters({ members, showAssignee }: { members: { id: string; name: string }[]; showAssignee: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("page");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`);
  };

  // Debounced search.
  useEffect(() => {
    if ((sp.get("q") ?? "") === q) return;
    const t = setTimeout(() => update({ q: q.trim() || null }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const select = (key: string, label: string, options: [string, string][]) => (
    <Select aria-label={label} value={sp.get(key) ?? ""} onChange={(e) => update({ [key]: e.target.value || null })} className="h-9 w-auto min-w-36">
      <option value="">{label}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </Select>
  );

  const active = [...sp.keys()].some((k) => !["sort", "dir", "page"].includes(k));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-72">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          aria-label="Search leads"
          placeholder="Search name, email or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 pl-9"
        />
      </div>
      {select("status", "Any status", LEAD_STATUSES.map((s) => [s, LEAD_STATUS_LABELS[s]]))}
      {select("source", "Any source", SOURCE_TYPES.map((s) => [s, SOURCE_LABELS[s]]))}
      {showAssignee &&
        select("assignee", "Anyone", [["me", "Me"], ["unassigned", "Unassigned"], ...members.map((m) => [m.id, m.name] as [string, string])])}
      {select("priority", "Any priority", LEAD_PRIORITIES.map((p) => [p, PRIORITY_LABELS[p]]))}
      {select("followUp", "Any follow-up", Object.entries(FOLLOW_UP_LABELS))}
      <label className="flex items-center gap-1 text-sm text-muted-foreground">
        From
        <Input type="date" aria-label="Created from" value={sp.get("createdFrom") ?? ""} onChange={(e) => update({ createdFrom: e.target.value || null })} className="h-9 w-40" />
      </label>
      <label className="flex items-center gap-1 text-sm text-muted-foreground">
        to
        <Input type="date" aria-label="Created to" value={sp.get("createdTo") ?? ""} onChange={(e) => update({ createdTo: e.target.value || null })} className="h-9 w-40" />
      </label>
      {!sp.get("status") && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={sp.get("includeClosed") === "true"}
            onChange={(e) => update({ includeClosed: e.target.checked ? "true" : null })}
          />
          Show converted &amp; lost
        </label>
      )}
      {active && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQ("");
            router.replace(pathname);
          }}
        >
          <X className="size-4" aria-hidden /> Clear
        </Button>
      )}
    </div>
  );
}
