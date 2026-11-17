import { NextResponse } from "next/server";
import { z } from "zod";
import { setSetupStep } from "@lfm/core";
import { orgRoute, readJson } from "@/lib/api";

const body = z.object({ step: z.number().int().min(1).max(10) });

export const PATCH = orgRoute("automation:configure", async (req, ctx) =>
  NextResponse.json(await setSetupStep(ctx, body.parse(await readJson(req)).step)),
);
