import { NextResponse } from "next/server";
import { listLeadMessages } from "@lfm/core";
import { orgRoute } from "@/lib/api";

export const GET = orgRoute<{ id: string }>("leads:view_assigned", async (_req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ messages: await listLeadMessages(ctx, id) });
});
