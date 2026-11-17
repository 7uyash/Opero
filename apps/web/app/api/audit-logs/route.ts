import { NextResponse } from "next/server";
import { listAuditLogs } from "@lfm/core";
import { orgRoute } from "@/lib/api";

export const GET = orgRoute("audit:view", async (req, ctx) => {
  const sp = req.nextUrl.searchParams;
  const result = await listAuditLogs(ctx, {
    cursor: sp.get("cursor") ?? undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
  });
  return NextResponse.json(result);
});
