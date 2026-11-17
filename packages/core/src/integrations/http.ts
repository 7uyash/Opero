import { ProviderError } from "./types";

/**
 * JSON-over-HTTP for provider APIs with a timeout and retry classification (ADR-008):
 * network errors, timeouts, 408/429 and 5xx are temporary; other 4xx are permanent.
 * 401/403 carry code "EAUTH" so callers can mark the connection as needing attention.
 */
export async function providerFetch<T = unknown>(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const label = init.label ?? "The provider";
  const headers: Record<string, string> = { Accept: "application/json", ...init.headers };
  let body: string | undefined;
  if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    // A timeout on a request that sends something might have succeeded on their side.
    const kind = timedOut && (init.method ?? (body ? "POST" : "GET")) !== "GET" ? "delivery_unknown" : "temporary";
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const why = timedOut ? " in time" : cause?.code ? ` (${cause.code})` : cause?.message ? ` (${cause.message})` : "";
    throw new ProviderError(`${label} couldn't be reached${why}.`, kind, timedOut ? "TIMEOUT" : "NETWORK");
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.ok) return json as T;

  const detail = extractErrorMessage(json) ?? (text.slice(0, 200) || res.statusText);
  if (res.status === 401 || res.status === 403) throw new ProviderError(`${label} refused the credentials: ${detail}`, "permanent", "EAUTH");
  if (res.status === 408 || res.status === 429 || res.status >= 500) throw new ProviderError(`${label} is busy (${res.status}): ${detail}`, "temporary", String(res.status));
  throw new ProviderError(`${label} rejected the request: ${detail}`, "permanent", String(res.status));
}

/** Pulls a readable message out of the common error shapes (Meta, Google, HubSpot). */
function extractErrorMessage(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const e = j.error as Record<string, unknown> | string | undefined;
  if (typeof e === "string") return (j.error_description as string) ?? e;
  if (e && typeof e === "object") {
    const ud = (e.error_user_msg ?? e.message) as string | undefined;
    const code = e.code !== undefined ? ` (code ${e.code})` : "";
    if (ud) return `${ud}${code}`;
  }
  if (typeof j.message === "string") return j.message;
  return null;
}
