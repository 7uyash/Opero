import { NextResponse, type NextRequest } from "next/server";
import { AppError, completeGmailOAuth, completeMetaOAuth, logger } from "@lfm/core";
import { clientMeta } from "@/lib/api";
import { getAuth } from "@/lib/session";
import { appBaseUrl } from "@/lib/urls";

/**
 * OAuth redirect target. The signed `state` must match the signed-in user and business, so a
 * forged callback can't attach someone's account to another business.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const back = (q: Record<string, string>) => NextResponse.redirect(`${appBaseUrl(req)}/integrations?${new URLSearchParams(q)}`);
  const auth = await getAuth();
  if (!auth?.ctx) return NextResponse.redirect(`${appBaseUrl(req)}/login`);
  const sp = req.nextUrl.searchParams;
  const input = { code: sp.get("code"), state: sp.get("state"), error: sp.get("error") };
  try {
    if (provider === "gmail") await completeGmailOAuth(auth.ctx, input, clientMeta(req).ip);
    else if (provider === "meta") await completeMetaOAuth(auth.ctx, input);
    else return back({ error: "Unknown provider" });
    return back({ connected: provider });
  } catch (err) {
    logger.warn({ provider, err: (err as Error).message }, "oauth callback failed");
    return back({ error: err instanceof AppError ? err.message : `Couldn't finish connecting: ${(err as Error).message}` });
  }
}
