import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { logger } from "@lfm/core";
import { errorResponse } from "./api";

type Ctx<P> = { params: Promise<P> };

/**
 * Wrapper for provider webhooks: no session and no same-origin check (signatures/keys are the
 * authorization), uniform error handling, and logging without payload contents.
 */
export function webhookRoute<P = Record<string, string>>(name: string, handler: (req: NextRequest, ctx: Ctx<P>) => Promise<Response>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      logger.warn({ webhook: name, err: (err as Error).message }, "webhook failed");
      return errorResponse(err);
    }
  };
}

export function clientIp(req: NextRequest) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? null;
}

/** Parses JSON, urlencoded or multipart bodies into a flat field map (for website forms). */
export async function readFormFields(req: NextRequest, raw?: string): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = JSON.parse(raw ?? (await req.text()));
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("Expected a JSON object");
    // Accept both {field: value} and {fields: {...}} shapes.
    return (j.fields && typeof j.fields === "object" ? { ...j, ...j.fields } : j) as Record<string, unknown>;
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw ?? (await req.text())));
  }
  if (type.includes("multipart/form-data")) {
    const fd = await req.formData();
    const out: Record<string, unknown> = {};
    for (const [k, v] of fd) if (typeof v === "string") out[k] = v;
    return out;
  }
  throw new Error("Send JSON or a form submission");
}

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export const ok = (body: unknown = { ok: true }, init?: ResponseInit) => NextResponse.json(body, init);
