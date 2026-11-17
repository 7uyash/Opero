import { NextResponse } from "next/server";
import { updateFollowUpStepChannels } from "@lfm/core";
import { updateStepChannelsSchema } from "@lfm/shared";
import { orgRoute, readJson } from "@/lib/api";

export const PUT = orgRoute("automation:configure", async (req, ctx) => {
  const { steps } = updateStepChannelsSchema.parse(await readJson(req));
  const rules = await updateFollowUpStepChannels(ctx, steps);
  return NextResponse.json({ steps: rules.map((r) => ({ stepIndex: r.stepIndex, channels: r.channels })) });
});
