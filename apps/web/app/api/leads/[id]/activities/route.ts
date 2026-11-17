import { NextResponse } from "next/server";
import { addLeadNote, getLeadTimeline } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

export const GET = orgRoute<{ id: string }>("leads:view_assigned", async (_req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ activities: await getLeadTimeline(ctx, id) });
});

/** Adds a note to the timeline. */
export const POST = orgRoute<{ id: string }>("leads:update", async (req, ctx, { params }) => {
  const { id } = await params;
  const activity = await addLeadNote(ctx, id, (await readJson(req)) as never);
  return NextResponse.json({ activity }, { status: 201 });
});
