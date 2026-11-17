import { NextResponse } from "next/server";
import { activateAutomation } from "@lfm/core";
import { clientMeta, orgRoute } from "@/lib/api";

export const POST = orgRoute("automation:activate", async (req, ctx) => NextResponse.json({ activation: await activateAutomation(ctx, clientMeta(req).ip) }));
