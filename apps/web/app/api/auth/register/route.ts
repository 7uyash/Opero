import { NextResponse } from "next/server";
import { Errors, MemoryRateLimitStore, RateLimiter, registerOwner } from "@lfm/core";
import { registerSchema } from "@lfm/shared";
import { clientMeta, publicRoute, readJson } from "@/lib/api";
import { setSessionCookie } from "@/lib/session";

const limiter = new RateLimiter(new MemoryRateLimitStore(), 10, 60 * 60 * 1000);

export const POST = publicRoute(async (req) => {
  const meta = clientMeta(req);
  if (!(await limiter.check(`register:${meta.ip}`)).allowed) throw Errors.rateLimited();
  const input = registerSchema.parse(await readJson(req));
  const result = await registerOwner(input, meta);
  await setSessionCookie(result.session.token, result.session.expiresAt);
  return NextResponse.json({ organizationId: result.organizationId }, { status: 201 });
});
