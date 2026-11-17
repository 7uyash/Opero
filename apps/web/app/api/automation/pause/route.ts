import { NextResponse } from "next/server";
import { pauseAutomation } from "@lfm/core";
import { clientMeta, orgRoute } from "@/lib/api";

export const POST = orgRoute("automation:activate", async (req, ctx) => NextResponse.json({ activation: await pauseAutomation(ctx, clientMeta(req).ip) }));
