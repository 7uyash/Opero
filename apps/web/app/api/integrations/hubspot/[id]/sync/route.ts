import { NextResponse } from "next/server";
import { syncHubSpotNow } from "@lfm/core";
import { orgRoute } from "@/lib/api";

export const POST = orgRoute<{ id: string }>("integrations:manage", async (_req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json(await syncHubSpotNow(ctx, id));
});
