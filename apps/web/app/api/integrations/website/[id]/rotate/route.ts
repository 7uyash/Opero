import { NextResponse } from "next/server";
import { rotateWebsiteSecret } from "@lfm/core";
import { clientMeta, orgRoute } from "@/lib/api";

/** Issues a new signing secret; the old one stops working immediately. */
export const POST = orgRoute<{ id: string }>("integrations:manage", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json(await rotateWebsiteSecret(ctx, id, clientMeta(req).ip));
});
