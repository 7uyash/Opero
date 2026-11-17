"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Select } from "@/components/ui/input";
import { api } from "@/lib/fetcher";

/** Shown only when the user belongs to more than one business. */
export function OrgSwitcher({ current, organizations }: { current: string; organizations: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (organizations.length < 2) return null;
  return (
    <Select
      aria-label="Switch business"
      value={current}
      disabled={busy}
      className="mt-2 h-8 text-xs"
      onChange={async (e) => {
        setBusy(true);
        try {
          await api("/api/organizations/switch", { body: { organizationId: e.target.value } });
          router.replace("/dashboard");
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      {organizations.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </Select>
  );
}
