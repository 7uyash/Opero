import { NextResponse } from "next/server";
import { getLeadAutomationSettings, previewRotation, updateAssignmentSettings } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

export const GET = orgRoute("leads:view_all", async (_req, ctx) => {
  const [settings, rotation] = await Promise.all([getLeadAutomationSettings(ctx.organizationId), previewRotation(ctx.organizationId)]);
  return NextResponse.json({ assignment: settings.assignment, duplicates: settings.duplicates, rotation });
});

export const PATCH = orgRoute("automation:configure", async (req, ctx) => {
  const settings = await updateAssignmentSettings(ctx, (await readJson(req)) as never, clientMeta(req).ip);
  return NextResponse.json({ assignment: settings.assignment, duplicates: settings.duplicates });
});
