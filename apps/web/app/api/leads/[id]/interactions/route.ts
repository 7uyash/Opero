import { NextResponse } from "next/server";
import { logInteraction } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

/** Records that an employee contacted the customer. */
export const POST = orgRoute<{ id: string }>("leads:update", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ lead: await logInteraction(ctx, id, (await readJson(req)) as never) }, { status: 201 });
});
