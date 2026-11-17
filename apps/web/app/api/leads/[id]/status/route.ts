import { NextResponse } from "next/server";
import { changeLeadStatus } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

export const POST = orgRoute<{ id: string }>("leads:update", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ lead: await changeLeadStatus(ctx, id, (await readJson(req)) as never) });
});
