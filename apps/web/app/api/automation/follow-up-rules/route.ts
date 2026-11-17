import { NextResponse } from "next/server";
import { getFollowUpRules, updateFollowUpRules } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

const view = (r: { stepIndex: number; name: string; delayMinutes: number; active: boolean }) => ({
  stepIndex: r.stepIndex,
  name: r.name,
  delayMinutes: r.delayMinutes,
  active: r.active,
});

export const GET = orgRoute("leads:view_all", async (_req, ctx) =>
  NextResponse.json({ steps: (await getFollowUpRules(ctx.organizationId)).map(view) }),
);

export const PUT = orgRoute("automation:configure", async (req, ctx) => {
  const rules = await updateFollowUpRules(ctx, (await readJson(req)) as never, clientMeta(req).ip);
  return NextResponse.json({ steps: rules.map(view) });
});
