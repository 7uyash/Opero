/**
 * Tiny HTTP client for end-to-end tests against a running app (web + worker).
 * One cookie jar per actor, and the same-origin header a browser would send.
 */
export const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const MAILPIT = process.env.MAILPIT_API ?? "http://localhost:8025/api/v1";
export const PASSWORD = "longpassword1";

export type Res = { status: number; json: any; text: string; headers: Headers };

export class Actor {
  cookie: string | null = null;
  constructor(public name: string) {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { Origin: BASE, ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (this.cookie) h.Cookie = this.cookie;
    const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) if (c.startsWith("lfm_session=")) this.cookie = c.split(";")[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // HTML page or empty body
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  get = (p: string) => this.call("GET", p);
  post = (p: string, b: unknown = {}) => this.call("POST", p, b);
  patch = (p: string, b: unknown = {}) => this.call("PATCH", p, b);
  put = (p: string, b: unknown = {}) => this.call("PUT", p, b);
  del = (p: string) => this.call("DELETE", p);
}

export const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Registers a new business and returns its signed-in owner. */
export async function newBusiness(name: string) {
  const owner = new Actor(`${name} owner`);
  const email = `owner-${unique()}@e2e.test`;
  const r = await owner.post("/api/auth/register", { name: `${name} Owner`, email, password: PASSWORD, businessName: name, businessEmail: `hello-${unique()}@e2e.test`, timezone: "Asia/Kolkata" });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register failed: ${r.status} ${r.text}`);
  return { owner, email, organizationId: r.json.organizationId as string };
}

/** Invites someone into the owner's business and signs them in. */
export async function invite(owner: Actor, role: "ADMIN" | "MANAGER" | "SALESPERSON", name: string) {
  const email = `${role.toLowerCase()}-${unique()}@e2e.test`;
  const r = await owner.post("/api/members", { email, role, name });
  if (r.status >= 300) throw new Error(`invite failed: ${r.status} ${r.text}`);
  const token = new URL(r.json.inviteUrl).pathname.split("/").pop()!;
  const person = new Actor(name);
  const a = await person.post("/api/invitations/accept", { token, name, password: PASSWORD });
  if (a.status >= 300) throw new Error(`accept failed: ${a.status} ${a.text}`);
  return { actor: person, email, invitationId: r.json.invitation.id as string };
}

export async function assertServerUp() {
  try {
    const r = await fetch(`${BASE}/login`, { redirect: "manual" });
    if (r.status >= 500) throw new Error(`status ${r.status}`);
  } catch (err) {
    throw new Error(
      `The app isn't reachable at ${BASE} (${(err as Error).message}). Start it with "pnpm dev" and "pnpm dev:worker" (or set E2E_BASE_URL) before running "pnpm test:e2e".`,
    );
  }
}
