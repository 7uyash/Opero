import { NextResponse } from "next/server";
import { updateSourceSelection } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

export const PUT = orgRoute("automation:configure", async (req, ctx) =>
  NextResponse.json({ sources: await updateSourceSelection(ctx, (await readJson(req)) as never) }),
);
