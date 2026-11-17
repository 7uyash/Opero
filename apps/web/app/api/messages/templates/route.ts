import { NextResponse } from "next/server";
import { listTemplates, saveTemplate } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

export const GET = orgRoute("leads:view_all", async (_req, ctx) => NextResponse.json({ templates: await listTemplates(ctx) }));

export const PUT = orgRoute("templates:manage", async (req, ctx) =>
  NextResponse.json({ template: await saveTemplate(ctx, (await readJson(req)) as never, clientMeta(req).ip) }),
);
