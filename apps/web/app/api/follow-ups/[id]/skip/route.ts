import { NextResponse } from "next/server";
import { z } from "zod";
import { skipFollowUp } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

const body = z.object({ reason: z.string().trim().max(300).optional() });

export const POST = orgRoute<{ id: string }>("followups:manage", async (req, ctx, { params }) => {
  const { id } = await params;
  await skipFollowUp(ctx, id, body.parse(await readJson(req)).reason);
  return NextResponse.json({ ok: true });
});
