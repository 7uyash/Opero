import { NextResponse } from "next/server";
import { z } from "zod";
import { testIntegration } from "@lfm/core";
import { emailSchema } from "@lfm/shared";
import { orgRoute, readJson } from "@/lib/api";

const body = z.object({ sendTo: emailSchema.optional() });

export const POST = orgRoute<{ id: string }>("integrations:manage", async (req, ctx, { params }) => {
  const { id } = await params;
  return NextResponse.json(await testIntegration(ctx, id, body.parse(await readJson(req))));
});
