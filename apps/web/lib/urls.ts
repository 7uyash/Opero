import type { NextRequest } from "next/server";

/** Public base URL: APP_URL in production, otherwise the request's own origin. */
export function appBaseUrl(req: NextRequest): string {
  if (process.env.NODE_ENV === "production" && process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  return req.nextUrl.origin;
}

export function invitationUrl(req: NextRequest, token: string): string {
  return `${appBaseUrl(req)}/invite/${encodeURIComponent(token)}`;
}
