import { NextResponse } from "next/server";
import { getLeadDetail, updateLead } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

export const GET = orgRoute<{ id: string }>("leads:view_assigned", async (_req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ lead: await getLeadDetail(ctx, id) });
});

export const PATCH = orgRoute<{ id: string }>("leads:update", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ lead: await updateLead(ctx, id, (await readJson(req)) as never) });
});
