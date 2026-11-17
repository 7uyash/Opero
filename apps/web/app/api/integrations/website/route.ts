import { NextResponse } from "next/server";
import { createWebsiteForm } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

/** Creates a website form. The signing secret is in this response only. */
export const POST = orgRoute("integrations:manage", async (req, ctx) =>
  NextResponse.json(await createWebsiteForm(ctx, (await readJson(req)) as never, clientMeta(req).ip), { status: 201 }),
);
