import { hmacSha256Hex, randomToken, safeEqual } from "../crypto/tokens";
import { Errors } from "../errors";

/**
 * Signed, expiring OAuth `state` that binds the callback to the organization and user who started
 * the connection (prevents CSRF / connecting an account into someone else's business).
 */
const TTL_MS = 15 * 60_000;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

export function createOAuthState(organizationId: string, userId: string, provider: string): string {
  const payload = Buffer.from(JSON.stringify({ o: organizationId, u: userId, p: provider, n: randomToken(12), e: Date.now() + TTL_MS })).toString("base64url");
  return `${payload}.${hmacSha256Hex(secret(), `oauth:${payload}`)}`;
}

export function verifyOAuthState(state: string | null, expect: { userId: string; provider: string }): { organizationId: string } {
  const [payload, sig] = (state ?? "").split(".");
  if (!payload || !sig || !safeEqual(sig, hmacSha256Hex(secret(), `oauth:${payload}`))) {
    throw Errors.validation("The connection request is invalid. Please start again.");
  }
  const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { o: string; u: string; p: string; e: number };
  if (data.e < Date.now()) throw Errors.validation("The connection request expired. Please start again.");
  if (data.u !== expect.userId || data.p !== expect.provider) throw Errors.forbidden("This connection was started by a different account.");
  return { organizationId: data.o };
}

export function oauthRedirectUri(provider: "gmail" | "meta"): string {
  return `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/integrations/callback/${provider}`;
}

/** Names of required server settings that are missing for a provider. */
export function missingEnv(names: readonly string[]): string[] {
  return names.filter((n) => !process.env[n]);
}
