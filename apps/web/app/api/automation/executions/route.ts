import { NextResponse } from "next/server";
import { z } from "zod";
import { listExecutions } from "@lfm/core";
import { orgRoute } from "@/lib/api";

const query = z.object({
  status: z.enum(["SUCCESS", "FAILED", "RETRYING", "SKIPPED"]).optional(),
  event: z.string().max(60).optional(),
  cursor: z.string().max(64).optional(),
});

export const GET = orgRoute("executions:view", async (req, ctx) => {
  const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  return NextResponse.json(await listExecutions(ctx, { status: q.status, eventPrefix: q.event, cursor: q.cursor }));
});
