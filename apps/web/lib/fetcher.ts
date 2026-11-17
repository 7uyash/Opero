import type { ApiError } from "@lfm/shared";

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError["error"],
  ) {
    super(body.message);
  }
}

/** Client-side JSON request helper that surfaces the API's error message and field errors. */
export async function api<T = unknown>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      (data as ApiError | null)?.error ?? { code: "NETWORK", message: "Could not reach the server. Check your connection." },
    );
  }
  return data as T;
}
