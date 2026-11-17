import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { AppError, Errors, assertPermission, logger, type OrgContext, type Permission } from "@lfm/core";
import type { ApiError } from "@lfm/shared";
import { getAuth } from "./session";

export function clientMeta(req: NextRequest) {
  const fwd = req.headers.get("x-forwarded-for");
  return {
    ip: fwd ? fwd.split(",")[0]!.trim() : (req.headers.get("x-real-ip") ?? null),
    userAgent: req.headers.get("user-agent"),
  };
}

export function errorResponse(err: unknown): NextResponse<ApiError> {
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".") || "_";
      fields[key] ??= issue.message;
    }
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Please check the highlighted fields.", fields } },
      { status: 422 },
    );
  }
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, fields: err.fields, details: err.details } },
      { status: err.status },
    );
  }
  logger.error({ err }, "unhandled API error");
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "Something went wrong on our side. Please try again." } },
    { status: 500 },
  );
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated routes: mutating requests must come from our own origin.
 * (SameSite=Lax cookies already block most cross-site POSTs; this closes the remaining gaps.)
 */
function assertSameOrigin(req: NextRequest) {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) throw Errors.forbidden("Missing request origin.");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw Errors.forbidden("Invalid request origin.");
  }
  if (originHost !== host) throw Errors.forbidden("Cross-site request blocked.");
}

export async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw Errors.validation("Request body must be valid JSON.");
  }
}

type RouteCtx<P> = { params: Promise<P> };

/** Public route (no session required) with uniform error handling and CSRF origin check. */
export function publicRoute<P = Record<string, string>>(
  handler: (req: NextRequest, route: RouteCtx<P>) => Promise<Response>,
) {
  return async (req: NextRequest, route: RouteCtx<P>) => {
    try {
      assertSameOrigin(req);
      return await handler(req, route);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/**
 * Authenticated, organization-scoped route. Resolves session → active membership → permission,
 * then hands an OrgContext to the handler (ADR-004).
 */
export function orgRoute<P = Record<string, string>>(
  permission: Permission | null,
  handler: (req: NextRequest, ctx: OrgContext, route: RouteCtx<P>) => Promise<Response>,
) {
  return async (req: NextRequest, route: RouteCtx<P>) => {
    try {
      assertSameOrigin(req);
      const auth = await getAuth();
      if (!auth) throw Errors.unauthenticated();
      if (!auth.ctx) throw Errors.forbidden("You are not an active member of any business account.");
      if (permission) assertPermission(auth.ctx, permission);
      return await handler(req, auth.ctx, route);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
