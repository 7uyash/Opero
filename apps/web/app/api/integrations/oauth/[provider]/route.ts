import { NextResponse } from "next/server";
import { Errors, gmailAuthUrl, metaAuthUrl } from "@lfm/core";
import { orgRoute } from "@/lib/api";

/** Starts an OAuth connection: redirects the browser to Google or Facebook. */
export const GET = orgRoute<{ provider: string }>("integrations:manage", async (_req, ctx, { params }) => {
  const { provider } = await params;
  const url = provider === "gmail" ? gmailAuthUrl(ctx) : provider === "meta" ? metaAuthUrl(ctx) : null;
  if (!url) throw Errors.notFound("Provider");
  return NextResponse.redirect(url);
});
