import type { Metadata } from "next";
import { can, getOrganization } from "@lfm/core";
import { WEEKDAYS, workingHoursSchema, type Holiday, type WorkingHours } from "@lfm/shared";
import { requireAuth } from "@/lib/session";
import { HoursForm } from "./hours-form";

export const metadata: Metadata = { title: "Working hours" };

export default async function HoursPage() {
  const { ctx } = await requireAuth();
  const org = await getOrganization(ctx);
  const parsed = workingHoursSchema.safeParse(org.workingHours);
  const hours: WorkingHours = parsed.success
    ? parsed.data
    : (Object.fromEntries(WEEKDAYS.map((d) => [d, []])) as unknown as WorkingHours);
  return (
    <HoursForm
      canEdit={can(ctx, "org:update")}
      timezone={org.timezone}
      initialHours={hours}
      initialHolidays={(Array.isArray(org.holidays) ? org.holidays : []) as Holiday[]}
    />
  );
}
