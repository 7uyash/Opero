import { NextResponse } from "next/server";
import { updateGmailSettings } from "@lfm/core";
import { gmailSettingsSchema } from "@lfm/shared";
import { orgRoute, readJson } from "@/lib/api";

export const PATCH = orgRoute<{ id: string }>("integrations:manage", async (req, ctx, { params }) => {
  const { id } = await params;
  const { createLeadsFromNewEmails } = gmailSettingsSchema.parse(await readJson(req));
  return NextResponse.json({ integration: await updateGmailSettings(ctx, id, createLeadsFromNewEmails) });
});
