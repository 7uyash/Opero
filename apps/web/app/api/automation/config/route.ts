import { NextResponse } from "next/server";
import { getActivationStatus, getLeadAutomationSettings, updateMessagingSettings } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

export const GET = orgRoute("leads:view_all", async (_req, ctx) => {
  const [activation, settings] = await Promise.all([getActivationStatus(ctx.organizationId), getLeadAutomationSettings(ctx.organizationId)]);
  return NextResponse.json({ activation, messaging: settings.messaging });
});

/** Updates messaging settings (automatic sending, channels, sending hours, fallback, custom variables). */
export const PATCH = orgRoute("automation:configure", async (req, ctx) =>
  NextResponse.json({ messaging: await updateMessagingSettings(ctx, (await readJson(req)) as never, clientMeta(req).ip) }),
);
