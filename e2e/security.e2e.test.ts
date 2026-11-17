import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../packages/db/src/index";
import { Actor, BASE, PASSWORD, assertServerUp, invite, newBusiness, unique } from "./client";

/**
 * Security checks over real HTTP against the running app:
 *   - one business can never read or change another business's records, on every [id] route
 *   - roles are enforced (a salesperson can't use admin routes or see colleagues' leads)
 *   - CSRF origin check, session cookie flags, security headers, login enumeration, webhook signatures
 */

let a: { owner: Actor; organizationId: string };
let b: { owner: Actor; organizationId: string };
let aSales: Actor, aSales2: Actor;
const B: Record<string, string> = {};
let aSalesLead: string, aSales2Lead: string;

beforeAll(async () => {
  await assertServerUp();
  a = await newBusiness(`Alpha ${unique()}`);
  b = await newBusiness(`Bravo ${unique()}`);

  // Business A: two salespeople, each owning one lead.
  aSales = (await invite(a.owner, "SALESPERSON", "Sam Seller")).actor;
  aSales2 = (await invite(a.owner, "SALESPERSON", "Tara Seller")).actor;
  const mine = await aSales.post("/api/leads", { name: "Sam's Lead", email: `sam-${unique()}@example.com` });
  const theirs = await aSales2.post("/api/leads", { name: "Tara's Lead", email: `tara-${unique()}@example.com` });
  aSalesLead = mine.json.lead.id;
  aSales2Lead = theirs.json.lead.id;

  // Business B: one of everything that has an id in a URL.
  const bSales = await invite(b.owner, "SALESPERSON", "Bravo Seller");
  const pending = await b.owner.post("/api/members", { email: `pending-${unique()}@e2e.test`, role: "SALESPERSON" });
  B.invitation = pending.json.invitation.id;
  const lead = await b.owner.post("/api/leads", { name: "Bravo Customer", email: `bravo-${unique()}@example.com`, phone: "+919800000001", assignedMemberId: null });
  B.lead = lead.json.lead.id;
  const form = await b.owner.post("/api/integrations/website", { name: "Bravo form" });
  B.integration = form.json.integration.id;
  await b.owner.get("/api/messages/templates"); // seeds the default templates
  const ids = await prisma.$transaction([
    prisma.organizationMember.findFirstOrThrow({ where: { organizationId: b.organizationId, user: { email: bSales.email } } }),
    prisma.followUpTask.findFirstOrThrow({ where: { leadId: B.lead } }),
    prisma.messageTemplate.findFirstOrThrow({ where: { organizationId: b.organizationId } }),
  ]);
  B.member = ids[0].id;
  B.task = ids[1].id;
  B.template = ids[2].id;
  // A failed outbound message and its execution record (as if a send had failed).
  const msg = await prisma.message.create({
    data: { organizationId: b.organizationId, leadId: B.lead!, channel: "EMAIL", direction: "OUTBOUND", status: "FAILED", body: "hi", toAddress: "x@example.com", idempotencyKey: `e2e:${unique()}`, failureKind: "permanent" },
  });
  B.message = msg.id;
  const exec = await prisma.automationExecution.create({
    data: { organizationId: b.organizationId, automationKey: "lead-follow-up", eventType: "message.send", status: "FAILED", leadId: B.lead, messageId: msg.id, retryable: true },
  });
  B.execution = exec.id;
}, 180_000);

afterAll(() => prisma.$disconnect());

/** Every route with a record id in the path, called by business A's owner with business B's ids. */
const later = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
const CROSS_TENANT: [method: string, path: string, body?: unknown][] = [
  ["GET", "/api/leads/{lead}"],
  ["PATCH", "/api/leads/{lead}", { name: "Hijacked" }],
  ["POST", "/api/leads/{lead}/status", { status: "LOST", reason: "x" }],
  ["POST", "/api/leads/{lead}/assign", { memberId: null }],
  ["GET", "/api/leads/{lead}/activities"],
  ["POST", "/api/leads/{lead}/activities", { body: "sneaky note" }],
  ["POST", "/api/leads/{lead}/consent", { channel: "ALL", optedOut: true }],
  ["POST", "/api/leads/{lead}/customer-reply", { channel: "PHONE" }],
  ["GET", "/api/leads/{lead}/follow-ups"],
  ["POST", "/api/leads/{lead}/follow-ups", { dueAt: later() }],
  ["POST", "/api/leads/{lead}/interactions", { channel: "PHONE" }],
  ["GET", "/api/leads/{lead}/messages"],
  ["POST", "/api/follow-ups/{task}/complete", {}],
  ["POST", "/api/follow-ups/{task}/reschedule", { dueAt: later() }],
  ["POST", "/api/follow-ups/{task}/skip", {}],
  ["DELETE", "/api/integrations/{integration}"],
  ["POST", "/api/integrations/{integration}/test", {}],
  ["PATCH", "/api/integrations/gmail/{integration}", { createLeadsFromNewEmails: true }],
  ["POST", "/api/integrations/hubspot/{integration}/sync", {}],
  ["PATCH", "/api/integrations/website/{integration}", { name: "Hijacked" }],
  ["POST", "/api/integrations/website/{integration}/rotate", {}],
  ["POST", "/api/integrations/website/{integration}/test", {}],
  ["PATCH", "/api/members/{member}", { role: "MANAGER" }],
  ["POST", "/api/members/{member}/redistribute", {}],
  ["DELETE", "/api/members/invitations/{invitation}"],
  ["POST", "/api/messages/{message}/retry", { confirmPossibleDuplicate: true }],
  ["POST", "/api/messages/templates/{template}/approve", { approved: true }],
  ["POST", "/api/automation/executions/{execution}/retry", { confirmPossibleDuplicate: true }],
];

describe("cross-business isolation", () => {
  it("covers every API route that takes a record id", () => {
    const api = path.resolve(__dirname, "../apps/web/app/api");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : n === "route.ts" ? [d] : []));
    const withId = walk(api)
      .map((d) => "/api/" + path.relative(api, d).split(path.sep).join("/"))
      .filter((r) => r.includes("[id]"));
    const covered = new Set(CROSS_TENANT.map(([, p]) => p.replace(/\{[a-z]+\}/g, "[id]")));
    for (const r of withId) expect(covered, `${r} is missing from CROSS_TENANT`).toContain(r);
  });

  it.each(CROSS_TENANT)("%s %s with another business's id → 404", async (method, template, body) => {
    const p = template.replace(/\{([a-z]+)\}/g, (_, k: string) => B[k]!);
    const r = await a.owner.call(method, p, body);
    expect(r.status, r.text).toBe(404);
    // Nothing about the other business leaks into the error.
    expect(r.text).not.toContain("Bravo");
  });

  it("left business B's data untouched", async () => {
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: B.lead } });
    expect(lead.name).toBe("Bravo Customer");
    expect(lead.status).not.toBe("LOST");
    expect(await prisma.leadActivity.count({ where: { leadId: B.lead, type: { in: ["NOTE_ADDED", "EMPLOYEE_CONTACTED", "CUSTOMER_REPLIED", "OPTED_OUT"] } } })).toBe(0);
    expect(await prisma.consent.count({ where: { leadId: B.lead } })).toBe(0);
    expect((await prisma.followUpTask.findUniqueOrThrow({ where: { id: B.task } })).status).toBe("SCHEDULED");
    const integ = await prisma.integration.findUniqueOrThrow({ where: { id: B.integration } });
    expect(integ.name).toBe("Bravo form");
    expect((await prisma.messageTemplate.findUniqueOrThrow({ where: { id: B.template } })).approval).toBe("DRAFT");
    expect((await prisma.organizationMember.findUniqueOrThrow({ where: { id: B.member } })).role).toBe("SALESPERSON");
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: B.invitation } })).revokedAt).toBeNull();
    expect((await prisma.message.findUniqueOrThrow({ where: { id: B.message } })).status).toBe("FAILED");
  });

  it("lists never include another business's records", async () => {
    const leads = await a.owner.get("/api/leads?includeClosed=true");
    expect(leads.json.items.map((l: { id: string }) => l.id)).not.toContain(B.lead);
    const integrations = await a.owner.get("/api/integrations");
    expect(JSON.stringify(integrations.json)).not.toContain(B.integration);
    const members = await a.owner.get("/api/members");
    expect(JSON.stringify(members.json)).not.toContain(B.member);
    const execs = await a.owner.get("/api/automation/executions");
    expect(JSON.stringify(execs.json)).not.toContain(B.execution);
  });

  it("can't switch into a business you don't belong to", async () => {
    const r = await a.owner.post("/api/organizations/switch", { organizationId: b.organizationId });
    expect(r.status).toBe(404);
    expect((await a.owner.get(`/api/leads/${B.lead}`)).status).toBe(404);
  });

  it("can't assign a lead to another business's employee", async () => {
    const r = await a.owner.post(`/api/leads/${aSalesLead}/assign`, { memberId: B.member });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: aSalesLead } })).assignedMemberId).not.toBe(B.member);
  });
});

describe("roles", () => {
  const ADMIN_ONLY: [string, string, unknown?][] = [
    ["GET", "/api/audit-logs"],
    ["POST", "/api/automation/activate", {}],
    ["POST", "/api/automation/pause", {}],
    ["PATCH", "/api/automation/config", {}],
    ["PUT", "/api/automation/follow-up-rules", { rules: [] }],
    ["GET", "/api/automation/executions"],
    ["GET", "/api/integrations"],
    ["POST", "/api/integrations/connect", { provider: "SMTP" }],
    ["POST", "/api/integrations/website", { name: "x" }],
    ["PUT", "/api/messages/templates", { key: "FOLLOW_UP", channel: "EMAIL", subject: "x", body: "x" }],
    ["POST", "/api/members", { email: `x-${unique()}@e2e.test`, role: "SALESPERSON" }],
    ["PATCH", "/api/organizations", { name: "Renamed" }],
  ];

  it.each(ADMIN_ONLY)("a salesperson gets 403 from %s %s", async (method, p, body) => {
    const r = await aSales.call(method, p, body);
    expect(r.status, r.text).toBe(403);
  });

  it("a salesperson sees only their own leads", async () => {
    const list = await aSales.get("/api/leads?includeClosed=true");
    const ids = list.json.items.map((l: { id: string }) => l.id);
    expect(ids).toContain(aSalesLead);
    expect(ids).not.toContain(aSales2Lead);
    expect((await aSales.get(`/api/leads/${aSales2Lead}`)).status).toBe(404);
    expect((await aSales.post(`/api/leads/${aSales2Lead}/status`, { status: "LOST" })).status).toBe(404);
  });

  it("a salesperson can't promote themselves", async () => {
    const me = await aSales.get("/api/members/me");
    const r = await aSales.patch(`/api/members/${me.json.membership.id}`, { role: "ADMIN" });
    expect(r.status).toBe(403);
  });

  it("nobody can grant the owner role", async () => {
    const r = await a.owner.post("/api/members", { email: `o-${unique()}@e2e.test`, role: "OWNER" });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("signed-out requests are rejected", async () => {
    const anon = new Actor("anon");
    for (const p of ["/api/leads", "/api/dashboard/overview", "/api/members", `/api/leads/${aSalesLead}`]) expect((await anon.get(p)).status).toBe(401);
    const page = await anon.get("/dashboard");
    expect([302, 303, 307, 308]).toContain(page.status);
    expect(page.headers.get("location")).toContain("/login");
  });
});

describe("sessions and requests", () => {
  it("blocks cross-site and origin-less writes (CSRF)", async () => {
    const evil = await a.owner.call("POST", "/api/leads", { name: "CSRF" }, { Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const res = await fetch(`${BASE}/api/leads`, { method: "POST", headers: { Cookie: a.owner.cookie!, "Content-Type": "application/json" }, body: JSON.stringify({ name: "No origin" }) });
    expect(res.status).toBe(403);
  });

  it("sets a hardened session cookie", async () => {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { Origin: BASE, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Cookie Check", email: `c-${unique()}@e2e.test`, password: PASSWORD, businessName: "Cookie Co", businessEmail: `cc-${unique()}@e2e.test`, timezone: "UTC" }),
    });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("lfm_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    // The raw token is never stored: the DB has only its HMAC.
    const token = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
    expect(await prisma.session.count({ where: { tokenHash: token } })).toBe(0);
  });

  it("logging out kills the session server-side", async () => {
    const { owner } = await newBusiness(`Logout ${unique()}`);
    const stolen = owner.cookie;
    await owner.post("/api/auth/logout");
    const replay = new Actor("replay");
    replay.cookie = stolen;
    expect((await replay.get("/api/leads")).status).toBe(401);
  });

  it("login doesn't reveal which emails exist", async () => {
    const anon = new Actor("anon");
    const known = await anon.post("/api/auth/login", { email: (await prisma.user.findFirstOrThrow()).email, password: "wrong-password-1" });
    const unknown = await anon.post("/api/auth/login", { email: `nobody-${unique()}@e2e.test`, password: "wrong-password-1" });
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(known.json.error.message).toBe(unknown.json.error.message);
  });

  it("sends security headers; only the hosted form may be framed", async () => {
    const page = await fetch(`${BASE}/login`);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(page.headers.get("x-powered-by")).toBeNull();
  });

  it("API responses never include secrets", async () => {
    const r = await b.owner.get("/api/integrations");
    const text = JSON.stringify(r.json);
    expect(text).not.toMatch(/whsec_|encrypted|accessToken|refreshToken|password/i);
  });
});

describe("webhooks", () => {
  it("website webhook: needs a valid, fresh signature", async () => {
    const created = await a.owner.post("/api/integrations/website", { name: `Signed ${unique()}` });
    const { webhookKey, secret } = created.json;
    const body = JSON.stringify({ name: "Signed Lead", email: `signed-${unique()}@example.com` });
    const send = (sig: string, ts: number) =>
      fetch(`${BASE}/api/webhooks/website/${webhookKey}`, { method: "POST", headers: { "Content-Type": "application/json", "X-LFM-Timestamp": String(ts), "X-LFM-Signature": sig }, body });
    const now = Math.floor(Date.now() / 1000);
    const sign = (ts: number, s = secret) => "sha256=" + createHmac("sha256", s).update(`${ts}.${body}`).digest("hex");
    expect((await send(sign(now, "whsec_wrong"), now)).status).toBe(401);
    expect((await send(sign(now - 3600), now - 3600)).status).toBe(401);
    expect((await send("", now)).status).toBe(401);
    expect((await send(sign(now), now)).status).toBe(201);
    // B's secret doesn't work on A's form and vice versa.
    const bForm = await prisma.integration.findUniqueOrThrow({ where: { id: B.integration } });
    expect((await fetch(`${BASE}/api/webhooks/website/${bForm.webhookKey}`, { method: "POST", headers: { "Content-Type": "application/json", "X-LFM-Timestamp": String(now), "X-LFM-Signature": sign(now) }, body })).status).toBe(401);
  });

  it("WhatsApp and Meta webhooks reject unsigned or wrongly signed events", async () => {
    for (const p of ["/api/webhooks/whatsapp", "/api/webhooks/meta"]) {
      const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
      expect((await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status).toBe(401);
      const bad = "sha256=" + createHmac("sha256", "not-the-app-secret").update(body).digest("hex");
      expect((await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": bad }, body })).status).toBe(401);
      // The subscription handshake needs the configured verify token.
      expect((await fetch(`${BASE}${p}?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=123`)).status).toBe(403);
    }
  });

  it("unsubscribe links can't be forged", async () => {
    const forged = `${B.lead}.EMAIL.${"a".repeat(43)}`;
    expect((await fetch(`${BASE}/api/unsubscribe/${encodeURIComponent(forged)}`, { method: "POST" })).status).toBe(404);
    expect(await prisma.consent.count({ where: { leadId: B.lead } })).toBe(0);
  });
});
