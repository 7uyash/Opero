import { NextResponse } from "next/server";
import { sendWebsiteTestSubmission } from "@lfm/core";
import { orgRoute } from "@/lib/api";
import { kickLeadMessages } from "@/lib/kick";

/** Sends a sample submission through the real intake path (creates a test lead). */
export const POST = orgRoute<{ id: string }>("integrations:manage", async (_req, ctx, { params }) => {
  const { id } = await params;
  const res = await sendWebsiteTestSubmission(ctx, id);
  if (res.leadId) await kickLeadMessages(res.leadId);
  return NextResponse.json(res);
});
