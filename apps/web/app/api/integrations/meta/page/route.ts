import { NextResponse } from "next/server";
import { selectMetaPage } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

/** Chooses the Facebook Page whose lead forms should create leads. */
export const POST = orgRoute("integrations:manage", async (req, ctx) =>
  NextResponse.json({ integration: await selectMetaPage(ctx, (await readJson(req)) as never, clientMeta(req).ip) }),
);
