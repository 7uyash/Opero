import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every API route must go through a guard. Signed-in routes use orgRoute (session → membership →
 * permission → org scope). The few routes that can't have a session are listed below with the
 * thing that authorizes them instead; adding a new unguarded route fails this test.
 */
const API_DIR = path.resolve(__dirname, "../app/api");

const PUBLIC_ROUTES: Record<string, string> = {
  "health": "read-only: reports only whether the database and Redis answer",
  "auth/login": "credentials + rate limit",
  "auth/register": "creates a new account",
  "auth/logout": "only clears the caller's own session",
  "auth/me": "returns only the caller's own session",
  "invitations/[token]": "single-use invitation token",
  "invitations/accept": "single-use invitation token + rate limit",
  "organizations/switch": "checks session and active membership itself",
  "integrations/callback/[provider]": "checks session + signed OAuth state",
  "unsubscribe/[token]": "signed unsubscribe token (RFC 8058 one-click, no Origin header)",
  "webhooks/email": "returns 410, does nothing",
  "webhooks/meta": "X-Hub-Signature-256 (POST) / verify token (GET)",
  "webhooks/whatsapp": "X-Hub-Signature-256 (POST) / verify token (GET)",
  "webhooks/website/[key]": "HMAC signature with timestamp",
  "webhooks/website/[key]/form": "form key + origin allow-list + honeypot + rate limits; leads marked unverified",
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

const routes = routeFiles(API_DIR).map((file) => ({
  file,
  route: path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/"),
  source: readFileSync(file, "utf8"),
}));

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

describe("API route guards", () => {
  it("finds the routes", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it.each(routes.map((r) => [r.route, r] as const))("%s is guarded", (_name, r) => {
    const handlers = METHODS.filter((m) => new RegExp(`export (const ${m}\\b|(async )?function ${m}\\b)`).test(r.source));
    expect(handlers.length, "route exports no handlers").toBeGreaterThan(0);

    for (const m of handlers) {
      const wrapped = new RegExp(`export const ${m} = (orgRoute|publicRoute|webhookRoute)\\b`).exec(r.source)?.[1];
      if (wrapped === "orgRoute") continue;
      // Anything that isn't orgRoute must be a known, reviewed public route.
      expect(PUBLIC_ROUTES[r.route], `${m} /api/${r.route} has no session guard and isn't in PUBLIC_ROUTES`).toBeDefined();
    }
  });

  it("org-scoped routes declare a permission or explicitly need only membership", () => {
    // orgRoute(null, …) is allowed only where any member may act on their own data.
    const membershipOnly = new Set(["members/me", "notifications", "notifications/read", "organizations"]);
    for (const r of routes) {
      if (/orgRoute\(\s*null/.test(r.source)) expect(membershipOnly, `/api/${r.route} uses orgRoute(null)`).toContain(r.route);
    }
  });

  it("the public list has no stale entries", () => {
    const names = new Set(routes.map((r) => r.route));
    for (const name of Object.keys(PUBLIC_ROUTES)) expect(names, name).toContain(name);
  });

  it("webhooks verify something before doing work", () => {
    const checks: Record<string, RegExp> = {
      "webhooks/meta": /verifyMetaSignature\(/,
      "webhooks/whatsapp": /verifyMetaSignature\(/,
      "webhooks/website/[key]": /verifyWebsiteSignature\(/,
      "unsubscribe/[token]": /unsubscribeByToken/,
    };
    for (const [name, re] of Object.entries(checks)) expect(routes.find((r) => r.route === name)!.source).toMatch(re);
  });
});
