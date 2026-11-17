import { NextResponse } from "next/server";
import { revokeSession } from "@lfm/core";
import { publicRoute } from "@/lib/api";
import { clearSessionCookie, readSessionToken } from "@/lib/session";

export const POST = publicRoute(async () => {
  const token = await readSessionToken();
  if (token) await revokeSession(token);
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
});
