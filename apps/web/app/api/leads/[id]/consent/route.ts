import { NextResponse } from "next/server";
import { setLeadOptOut } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

/** Records that the customer opted out of (or back into) a channel. */
export const POST = orgRoute<{ id: string }>("leads:update", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ consents: await setLeadOptOut(ctx, id, (await readJson(req)) as never) });
});
