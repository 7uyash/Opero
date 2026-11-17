import { NextResponse } from "next/server";
import { previewTemplate } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

export const POST = orgRoute("leads:view_assigned", async (req, ctx) => NextResponse.json(await previewTemplate(ctx, (await readJson(req)) as never)));
