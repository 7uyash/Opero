import { NextResponse } from "next/server";
import { redistributeMemberLeads } from "@lfm/core";
import { clientMeta, orgRoute } from "@/lib/api";

/** Shares the member's open leads with the rest of the team. */
export const POST = orgRoute<{ id: string }>("leads:assign", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json(await redistributeMemberLeads(ctx, id, clientMeta(req).ip));
});
