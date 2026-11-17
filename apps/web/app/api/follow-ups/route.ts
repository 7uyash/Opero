import { NextResponse } from "next/server";
import { z } from "zod";
import { listFollowUpCenter } from "@lfm/core";
import { FOLLOW_UP_VIEWS } from "@lfm/shared";
import { orgRoute } from "@/lib/api";

const query = z.object({ view: z.enum(FOLLOW_UP_VIEWS).default("due_today"), assignee: z.string().max(64).optional() });

export const GET = orgRoute("leads:view_assigned", async (req, ctx) => {
  const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  return NextResponse.json(await listFollowUpCenter(ctx, q.view, { assignee: q.assignee }));
});
