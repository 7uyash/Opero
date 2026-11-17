import { NextResponse } from "next/server";
import { rescheduleFollowUp } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

export const POST = orgRoute<{ id: string }>("followups:manage", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ followUp: await rescheduleFollowUp(ctx, id, (await readJson(req)) as never) });
});
