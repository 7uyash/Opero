import { NextResponse } from "next/server";
import { installAutomation } from "@lfm/core";
import { clientMeta, orgRoute } from "@/lib/api";

export const POST = orgRoute("automation:configure", async (req, ctx) => NextResponse.json(await installAutomation(ctx, clientMeta(req).ip)));
