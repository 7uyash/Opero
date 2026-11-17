import { NextResponse, type NextRequest } from "next/server";
import { unsubscribeByToken } from "@lfm/core";
import { errorResponse } from "@/lib/api";
import { appBaseUrl } from "@/lib/urls";

/**
 * Opening the List-Unsubscribe URL in a browser shows the confirmation page. GET never changes
 * anything, because link scanners and mail previews fetch URLs on their own.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return NextResponse.redirect(`${appBaseUrl(req)}/unsubscribe/${encodeURIComponent(token)}`, 303);
}

/**
 * One-click unsubscribe (RFC 8058): mail clients POST here without a session or Origin header,
 * so this route skips the same-origin check. The signed token is the authorization.
 * A JSON body of {"optedOut": false} re-subscribes (used by the confirmation page's undo button).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const raw = await req.text().catch(() => "");
    let optedOut = true;
    try {
      optedOut = (JSON.parse(raw) as { optedOut?: boolean }).optedOut !== false;
    } catch {
      // Form-encoded one-click body ("List-Unsubscribe=One-Click") means unsubscribe.
    }
    return NextResponse.json(await unsubscribeByToken(decodeURIComponent(token), optedOut));
  } catch (err) {
    return errorResponse(err);
  }
}
