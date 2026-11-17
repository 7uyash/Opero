"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/input";

export function AssigneeFilter({ members }: { members: { id: string; name: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  return (
    <Select
      aria-label="Filter by team member"
      value={sp.get("assignee") ?? ""}
      className="h-9 w-48"
      onChange={(e) => {
        const next = new URLSearchParams(sp.toString());
        if (e.target.value) next.set("assignee", e.target.value);
        else next.delete("assignee");
        router.replace(`${pathname}?${next}`);
      }}
    >
      <option value="">Everyone</option>
      <option value="unassigned">Unassigned</option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </Select>
  );
}
