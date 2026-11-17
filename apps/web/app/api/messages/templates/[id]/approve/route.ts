import { NextResponse } from "next/server";
import { z } from "zod";
import { setTemplateApproval } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

const body = z.object({ approved: z.boolean() });

export const POST = orgRoute<{ id: string }>("templates:approve", async (req, ctx, { params }) => {
  const { id } = await params;
  const { approved } = body.parse(await readJson(req));
  return NextResponse.json({ template: await setTemplateApproval(ctx, id, approved, clientMeta(req).ip) });
});
