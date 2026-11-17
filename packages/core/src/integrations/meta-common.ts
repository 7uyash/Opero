import { hmacSha256Hex, safeEqual } from "../crypto/tokens";

/** Graph API base. META_GRAPH_URL lets tests and proxies point elsewhere. */
export function graphBase() {
  const host = (process.env.META_GRAPH_URL ?? "https://graph.facebook.com").replace(/\/$/, "");
  return `${host}/${process.env.META_GRAPH_VERSION ?? "v23.0"}`;
}

/** Verifies Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret). */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret = process.env.META_APP_SECRET): boolean {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  return safeEqual(header, `sha256=${hmacSha256Hex(appSecret, rawBody)}`);
}

/** Webhook subscription handshake (GET with hub.mode / hub.verify_token / hub.challenge). */
export function verifyMetaChallenge(params: URLSearchParams): string | null {
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!expected) return null;
  if (params.get("hub.mode") === "subscribe" && params.get("hub.verify_token") === expected) return params.get("hub.challenge");
  return null;
}
