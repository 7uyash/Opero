import { NextResponse } from "next/server";
import { getDashboardOverview } from "@lfm/core";
import { orgRoute } from "@/lib/api";

export const GET = orgRoute("leads:view_assigned", async (_req, ctx) => NextResponse.json(await getDashboardOverview(ctx)));
