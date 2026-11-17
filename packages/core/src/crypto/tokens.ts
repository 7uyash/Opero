import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe random token (default 32 bytes ≈ 256 bits of entropy). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256Hex(secret: string | Buffer, value: string | Buffer): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/** Constant-time comparison of two strings (false when lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Hash used for storing lookup tokens (sessions, invitations). Keyed so a DB leak alone is not enough. */
export function hashToken(token: string, secret = process.env.SESSION_SECRET): string {
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return hmacSha256Hex(secret, token);
}
