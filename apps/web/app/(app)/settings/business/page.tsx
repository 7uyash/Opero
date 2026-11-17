import type { Metadata } from "next";
import { can, getOrganization } from "@lfm/core";
import { requireAuth } from "@/lib/session";
import { BusinessForm } from "./business-form";

export const metadata: Metadata = { title: "Business settings" };

export default async function BusinessSettingsPage() {
  const { ctx } = await requireAuth();
  const org = await getOrganization(ctx);
  return (
    <BusinessForm
      canEdit={can(ctx, "org:update")}
      timezones={Intl.supportedValuesOf("timeZone")}
      initial={{
        name: org.name,
        email: org.email,
        businessType: org.businessType ?? "",
        website: org.website ?? "",
        timezone: org.timezone,
        defaultCountry: org.defaultCountry,
      }}
    />
  );
}
