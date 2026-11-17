import { NextResponse } from "next/server";
import { z } from "zod";
import { markNotificationsRead } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

const schema = z.object({ ids: z.array(z.string().min(1)).max(200).optional() });

/** Marks the given notifications as read, or all of them when no ids are sent. */
export const POST = orgRoute(null, async (req, ctx) => {
  const { ids } = schema.parse(await readJson(req));
  return NextResponse.json({ updated: await markNotificationsRead(ctx, ids) });
});
