import { NextResponse } from "next/server";
import { assignLeadManually } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

export const POST = orgRoute<{ id: string }>("leads:assign", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ lead: await assignLeadManually(ctx, id, (await readJson(req)) as never) });
});
