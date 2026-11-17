import { NextResponse } from "next/server";
import { listNotifications } from "@lfm/core";
import { orgRoute } from "@/lib/api";

export const GET = orgRoute(null, async (req, ctx) =>
  NextResponse.json(await listNotifications(ctx, { unreadOnly: req.nextUrl.searchParams.get("unread") === "true" })),
);
