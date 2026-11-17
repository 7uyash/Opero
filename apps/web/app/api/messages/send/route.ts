import { NextResponse } from "next/server";
import { z } from "zod";
import { sendManualMessage } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";
import { kickLeadMessages } from "@/lib/kick";

const body = z.object({ leadId: z.string().min(1) }).loose();

export const POST = orgRoute("messages:send", async (req, ctx) => {
  const { leadId, ...rest } = body.parse(await readJson(req));
  const message = await sendManualMessage(ctx, leadId, rest as never);
  await kickLeadMessages(leadId);
  return NextResponse.json({ message: { id: message.id, status: message.status } }, { status: 201 });
});
