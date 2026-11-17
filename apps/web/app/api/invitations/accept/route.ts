import { NextResponse } from "next/server";
import { Errors, MemoryRateLimitStore, RateLimiter, acceptInvitation } from "@lfm/core";
import { clientMeta, publicRoute, readJson } from "@/lib/api";
import { setSessionCookie } from "@/lib/session";

const limiter = new RateLimiter(new MemoryRateLimitStore(), 20, 15 * 60 * 1000);

export const POST = publicRoute(async (req) => {
  const meta = clientMeta(req);
  if (!(await limiter.check(`accept:${meta.ip}`)).allowed) throw Errors.rateLimited();
  const result = await acceptInvitation((await readJson(req)) as never, meta);
  await setSessionCookie(result.session.token, result.session.expiresAt);
  return NextResponse.json({ organizationId: result.organizationId });
});
