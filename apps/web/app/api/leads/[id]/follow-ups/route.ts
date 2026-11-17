import { NextResponse } from "next/server";
import { listLeadFollowUps, scheduleManualFollowUp } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

export const GET = orgRoute<{ id: string }>("leads:view_assigned", async (_req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ followUps: await listLeadFollowUps(ctx, id) });
});

/** Schedules a one-off follow-up for this lead. */
export const POST = orgRoute<{ id: string }>("followups:manage", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ followUp: await scheduleManualFollowUp(ctx, id, (await readJson(req)) as never) }, { status: 201 });
});
