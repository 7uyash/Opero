import { NextResponse } from "next/server";
import { z } from "zod";
import { retryExecution } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";
import { kickLeadMessages } from "@/lib/kick";

const body = z.object({ confirmPossibleDuplicate: z.boolean().optional() });

export const POST = orgRoute<{ id: string }>("executions:retry", async (req, ctx, { params }) => {
  const { id } = await params;
  const m = await retryExecution(ctx, id, body.parse(await readJson(req)));
  await kickLeadMessages(m.leadId);
  return NextResponse.json({ message: { id: m.id, status: m.status } });
});
