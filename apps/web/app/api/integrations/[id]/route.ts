import { NextResponse } from "next/server";
import { disconnectIntegration } from "@lfm/core";
import { clientMeta, orgRoute } from "@/lib/api";

export const DELETE = orgRoute<{ id: string }>("integrations:manage", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ integration: await disconnectIntegration(ctx, id, clientMeta(req).ip) });
});
