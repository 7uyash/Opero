import { NextResponse } from "next/server";
import { getOrganization, updateOrganization } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

export const GET = orgRoute(null, async (_req, ctx) => NextResponse.json({ organization: await getOrganization(ctx) }));

export const PATCH = orgRoute("org:update", async (req, ctx) => {
  const organization = await updateOrganization(ctx, (await readJson(req)) as never, clientMeta(req).ip);
  return NextResponse.json({ organization });
});
