import { NextResponse } from "next/server";
import { recordCustomerReply } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

/** Records that the customer got back in touch outside the app. Pauses automatic follow-ups. */
export const POST = orgRoute<{ id: string }>("leads:update", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ lead: await recordCustomerReply(ctx, id, (await readJson(req)) as never) }, { status: 201 });
});
