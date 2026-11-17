import { NextResponse } from "next/server";
import { z } from "zod";
import { Errors, connectHubSpot, connectSmtp, connectWhatsApp } from "@lfm/core";
import { clientMeta, orgRoute, readJson } from "@/lib/api";

const body = z.object({ provider: z.enum(["SMTP", "WHATSAPP_CLOUD", "HUBSPOT"]) }).loose();

/**
 * Connects a provider configured with a form (credentials are verified against the real service).
 * OAuth providers (Gmail, Facebook) start at /api/integrations/oauth/<provider>; website forms are
 * created at /api/integrations/website.
 */
export const POST = orgRoute("integrations:manage", async (req, ctx) => {
  const parsed = body.safeParse(await readJson(req));
  if (!parsed.success) throw Errors.validation("This connection type is not available.");
  const { provider, ...input } = parsed.data;
  const ip = clientMeta(req).ip;
  const result =
    provider === "SMTP"
      ? await connectSmtp(ctx, input as never, ip)
      : provider === "WHATSAPP_CLOUD"
        ? await connectWhatsApp(ctx, input as never, ip)
        : await connectHubSpot(ctx, input as never, ip);
  // Always 200: a failed test is a normal outcome shown to the user, not a request error.
  return NextResponse.json(result);
});
