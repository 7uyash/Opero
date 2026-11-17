import { NextResponse } from "next/server";
import { updateWebsiteForm } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

export const PATCH = orgRoute<{ id: string }>("integrations:manage", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json({ integration: await updateWebsiteForm(ctx, id, (await readJson(req)) as never) });
});
