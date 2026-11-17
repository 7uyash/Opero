import { NextResponse } from "next/server";
import { listIntegrations } from "@lfm/core";
import { orgRoute } from "@/lib/api";

export const GET = orgRoute("integrations:manage", async (_req, ctx) => NextResponse.json({ integrations: await listIntegrations(ctx) }));
