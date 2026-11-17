"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { SlidersHorizontal, Search, X } from "lucide-react";
import { LEAD_PRIORITIES, LEAD_STATUSES, LEAD_STATUS_LABELS, PRIORITY_LABELS, SOURCE_LABELS, SOURCE_TYPES } from "@lfm/shared";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const SORTS: [string, string][] = [
  ["", "Newest first"],
  ["nextFollowUpAt:asc", "Next follow-up"],
  ["lastContactAt:asc", "Longest without contact"],
  ["name:asc", "Name A–Z"],
  ["status:asc", "Status"],
];

const FOLLOW_UP_LABELS = { overdue: "Overdue", today: "Due today", week: "Due in 7 days", none: "No follow-up scheduled" };

/** Filter bar that keeps all state in the URL so filtered views can be bookmarked and shared. */
export function LeadFilters({ members, showAssignee }: { members: { id: string; name: string }[]; showAssignee: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [open, setOpen] = useState(false);

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
    <Select aria-label={label} value={sp.get(key) ?? ""} onChange={(e) => update({ [key]: e.target.value || null })} className="h-10 w-full md:h-9 md:w-auto md:min-w-36">
      <option value="">{label}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </Select>
  );

  const filterKeys = [...sp.keys()].filter((k) => !["sort", "dir", "page", "q"].includes(k));
  const active = filterKeys.length > 0 || !!sp.get("q");
  const sortValue = sp.get("sort") ? `${sp.get("sort")}:${sp.get("dir") ?? "asc"}` : "";

  return (
    <div className="space-y-2 md:flex md:flex-wrap md:items-center md:gap-2 md:space-y-0">
      <div className="flex gap-2 md:contents">
      <div className="relative flex-1 md:w-72 md:flex-none">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          aria-label="Search leads"
          placeholder="Search name, email or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-10 pl-9 md:h-9"
        />
      </div>
      <Button type="button" variant="secondary" className="shrink-0 md:hidden" aria-expanded={open} aria-controls="lead-filters" onClick={() => setOpen((o) => !o)}>
        <SlidersHorizontal className="size-4" aria-hidden />
        Filters{filterKeys.length ? ` (${filterKeys.length})` : ""}
      </Button>
      </div>
      <div id="lead-filters" className={cn("grid grid-cols-2 gap-2 md:contents", !open && "hidden")}>
      <Select aria-label="Sort" className="col-span-2 h-10 md:hidden" value={sortValue} onChange={(e) => {
        const [sort, dir] = e.target.value.split(":");
        update({ sort: sort || null, dir: dir || null });
      }}>
        {SORTS.map(([v, l]) => (
          <option key={v} value={v}>Sort: {l}</option>
        ))}
      </Select>
      {select("status", "Any status", LEAD_STATUSES.map((s) => [s, LEAD_STATUS_LABELS[s]]))}
      {select("source", "Any source", SOURCE_TYPES.map((s) => [s, SOURCE_LABELS[s]]))}
      {showAssignee &&
        select("assignee", "Anyone", [["me", "Me"], ["unassigned", "Unassigned"], ...members.map((m) => [m.id, m.name] as [string, string])])}
      {select("priority", "Any priority", LEAD_PRIORITIES.map((p) => [p, PRIORITY_LABELS[p]]))}
      {select("followUp", "Any follow-up", Object.entries(FOLLOW_UP_LABELS))}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground md:flex-row md:items-center md:text-sm">
        Created from
        <Input type="date" aria-label="Created from" value={sp.get("createdFrom") ?? ""} onChange={(e) => update({ createdFrom: e.target.value || null })} className="h-10 md:h-9 md:w-40" />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground md:flex-row md:items-center md:text-sm">
        to
        <Input type="date" aria-label="Created to" value={sp.get("createdTo") ?? ""} onChange={(e) => update({ createdTo: e.target.value || null })} className="h-10 md:h-9 md:w-40" />
      </label>
      {!sp.get("status") && (
        <label className="col-span-2 flex min-h-10 items-center gap-2 text-sm text-muted-foreground">
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
    </div>
  );
}
