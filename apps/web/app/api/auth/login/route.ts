import { NextResponse } from "next/server";
import { Errors, MemoryRateLimitStore, RateLimiter, login } from "@lfm/core";
import { loginSchema } from "@lfm/shared";
import { clientMeta, publicRoute, readJson } from "@/lib/api";
import { setSessionCookie } from "@/lib/session";

// 10 attempts per 15 minutes per IP+email, and 50 per IP overall.
const perAccount = new RateLimiter(new MemoryRateLimitStore(), 10, 15 * 60 * 1000);
const perIp = new RateLimiter(new MemoryRateLimitStore(), 50, 15 * 60 * 1000);

export const POST = publicRoute(async (req) => {
  const meta = clientMeta(req);
  const input = loginSchema.parse(await readJson(req));
  const [a, b] = await Promise.all([perAccount.check(`${meta.ip}:${input.email}`), perIp.check(`${meta.ip}`)]);
  if (!a.allowed || !b.allowed) throw Errors.rateLimited();
  const result = await login(input, meta);
  await setSessionCookie(result.session.token, result.session.expiresAt);
  return NextResponse.json({ organizationId: result.organizationId });
});
