import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../packages/db/src/index";
import { Actor, BASE, MAILPIT, assertServerUp, invite, newBusiness, unique } from "./client";

/**
 * The whole journey over HTTP, through the real web app, the real worker and a real SMTP server:
 * nothing here calls a core function directly. The worker must be running (`pnpm dev:worker`),
 * because it is what sends the emails.
 */
type Mail = { ID: string; Subject: string; To: { Address: string }[] };
const mailsTo = async (addr: string): Promise<Mail[]> =>
  ((await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:"${addr}"`)}`)).json()) as { messages: Mail[] }).messages;

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 45_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Is the worker running ("pnpm dev:worker")?`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let owner: Actor, seller: Actor;
const customer = `customer-${unique()}@example.com`;
let leadId: string;

beforeAll(async () => {
  await assertServerUp();
  const r = await fetch(`${MAILPIT}/messages`).catch(() => null);
  if (!r?.ok) throw new Error(`Mailpit isn't reachable at ${MAILPIT}. Start it with "docker compose up -d mailpit".`);
}, 30_000);
afterAll(() => prisma.$disconnect());

describe("journey over HTTP with the real worker", () => {
  it("owner sets up: team, email account, templates, website form, activation", async () => {
    ({ owner } = await newBusiness(`Journey ${unique()}`));
    seller = (await invite(owner, "SALESPERSON", "Sita Seller")).actor;
    const me = await owner.get("/api/members/me");
    expect((await owner.patch(`/api/members/${me.json.membership.id}`, { receivesLeads: false })).status).toBe(200);

    expect((await owner.post("/api/automation/install")).status).toBeLessThan(300);
    // Activation is refused until the checklist passes.
    expect((await owner.post("/api/automation/activate")).status).toBe(422);

    const smtp = await owner.post("/api/integrations/connect", { provider: "SMTP", host: process.env.E2E_SMTP_HOST ?? "localhost", port: 1025, secure: false, fromEmail: `hello-${unique()}@journey.test`, fromName: "Journey Co" });
    expect(smtp.json.integration.status, smtp.text).toBe("CONNECTED");
    expect((await owner.patch("/api/automation/config", { acknowledgementChannels: ["EMAIL"], fallbackChannel: null, sendingHoursMode: "ALWAYS" })).status).toBe(200);
    const templates = (await owner.get("/api/messages/templates")).json.templates as { id: string; channel: string }[];
    for (const t of templates.filter((t) => t.channel === "EMAIL")) expect((await owner.post(`/api/messages/templates/${t.id}/approve`, { approved: true })).status).toBe(200);

    const act = await owner.post("/api/automation/activate");
    expect(act.status, act.text).toBe(200);
    expect((await owner.get("/api/automation/config")).json.activation.status).toBe("ACTIVE");
  });

  it("a signed website submission creates a lead assigned to the salesperson", async () => {
    const form = (await owner.post("/api/integrations/website", { name: "Contact" })).json;
    const body = JSON.stringify({ fields: { "Full Name": "Kiran Patel", "E-mail": customer, Phone: "+91 99887 76655", Service: "Mobile app" } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = "sha256=" + createHmac("sha256", form.secret).update(`${ts}.${body}`).digest("hex");
    const send = () => fetch(`${BASE}/api/webhooks/website/${form.webhookKey}`, { method: "POST", headers: { "Content-Type": "application/json", "X-LFM-Timestamp": String(ts), "X-LFM-Signature": sig, "Idempotency-Key": "journey-1" }, body });
    const first = await send();
    expect(first.status).toBe(201);
    leadId = ((await first.json()) as { leadId: string }).leadId;
    // The website retrying the same delivery doesn't create a second lead.
    expect(((await (await send()).json()) as { outcome: string }).outcome).toBe("duplicate_event");

    const mine = (await seller.get("/api/leads")).json.items as { id: string; name: string; assignedTo: { name: string } | null; source: string }[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: leadId, name: "Kiran Patel", assignedTo: { name: "Sita Seller" } });
    const detail = (await seller.get(`/api/leads/${leadId}`)).json.lead;
    expect(detail.phoneE164).toBe("+919988776655");
    expect(detail.status).toBe("ASSIGNED");
  });

  it("the worker emails the customer an acknowledgement, exactly once", async () => {
    const mails = await waitFor("the acknowledgement email", async () => {
      const m = await mailsTo(customer);
      return m.length ? m : null;
    });
    expect(mails[0]!.Subject).toBe("We've received your inquiry!");
    const headers = (await (await fetch(`${MAILPIT}/message/${mails[0]!.ID}/headers`)).json()) as Record<string, string[]>;
    expect(headers["List-Unsubscribe"]?.[0]).toContain("/api/unsubscribe/");
    expect(headers["List-Unsubscribe-Post"]?.[0]).toBe("List-Unsubscribe=One-Click");

    const msgs = await waitFor("the message to be marked sent", async () => {
      const m = (await seller.get(`/api/leads/${leadId}/messages`)).json.messages as { status: string; purpose: string }[];
      return m.some((x) => x.status === "SENT") ? m : null;
    });
    expect(msgs.filter((m) => m.purpose === "acknowledgement")).toHaveLength(1);
    // Wait through one more worker sweep: still one email.
    await new Promise((r) => setTimeout(r, 16_000));
    expect(await mailsTo(customer)).toHaveLength(1);
  }, 120_000);

  it("the 24h / 3d / 7d / 14d follow-ups are scheduled and visible in the Follow-up Center", async () => {
    const fu = (await seller.get(`/api/leads/${leadId}/follow-ups`)).json.followUps as { status: string; dueAt: string }[];
    const scheduled = fu.filter((f) => f.status === "SCHEDULED");
    expect(scheduled).toHaveLength(4);
    const lead = (await seller.get(`/api/leads/${leadId}`)).json.lead;
    expect(new Date(lead.nextFollowUpAt).getTime()).toBe(Math.min(...scheduled.map((s) => new Date(s.dueAt).getTime())));
    const center = await seller.get("/api/follow-ups?view=upcoming");
    expect(center.status).toBe(200);
    expect(JSON.stringify(center.json)).toContain(leadId);
  });

  it("the customer replies: pending follow-ups stop and the salesperson gets a reminder", async () => {
    expect((await seller.post(`/api/leads/${leadId}/customer-reply`, { channel: "PHONE", note: "Called back, wants a quote" })).status).toBe(201);
    const fu = (await seller.get(`/api/leads/${leadId}/follow-ups`)).json.followUps as { status: string; title: string | null }[];
    expect(fu.filter((f) => f.status === "SCHEDULED")).toHaveLength(0);
    expect(fu.some((f) => f.status === "DUE" && /replied/i.test(f.title ?? ""))).toBe(true);
    const timeline = JSON.stringify((await seller.get(`/api/leads/${leadId}/activities`)).json);
    expect(timeline).toContain("CUSTOMER_REPLIED");
    expect(timeline).toContain("FOLLOW_UPS_PAUSED");
  });

  it("the salesperson follows up, then converts the lead; nothing is left scheduled", async () => {
    expect((await seller.post(`/api/leads/${leadId}/interactions`, { channel: "EMAIL", note: "Sent the quote", awaitingCustomer: true })).status).toBeLessThan(300);
    expect((await seller.get(`/api/leads/${leadId}`)).json.lead.status).toBe("WAITING_FOR_CUSTOMER");
    expect((await seller.get(`/api/leads/${leadId}/follow-ups`)).json.followUps.some((f: { status: string }) => f.status === "SCHEDULED")).toBe(true);

    for (const status of ["QUALIFIED", "CONVERTED"]) expect((await seller.post(`/api/leads/${leadId}/status`, { status })).status).toBe(200);
    const fu = (await seller.get(`/api/leads/${leadId}/follow-ups`)).json.followUps as { status: string }[];
    expect(fu.filter((f) => ["SCHEDULED", "DUE"].includes(f.status))).toHaveLength(0);
    const lead = (await seller.get(`/api/leads/${leadId}`)).json.lead;
    expect(lead.status).toBe("CONVERTED");
    expect(lead.nextFollowUpAt).toBeNull();
    // A converted lead can't jump back to "new".
    expect((await seller.post(`/api/leads/${leadId}/status`, { status: "NEW" })).status).toBe(422);
  });

  it("the dashboard and activity log reflect what happened", async () => {
    const o = (await owner.get("/api/dashboard/overview")).json;
    expect(o.stats).toMatchObject({ total: 1, converted: 1, conversionRate: 1 });
    expect(o.team.find((t: { name: string }) => t.name === "Sita Seller")).toBeTruthy();
    const execs = JSON.stringify((await owner.get("/api/automation/executions")).json);
    expect(execs).toContain("followup.paused_customer_replied");
  });

  it("the customer's one-click unsubscribe from the email works without signing in", async () => {
    const mail = (await mailsTo(customer))[0]!;
    const headers = (await (await fetch(`${MAILPIT}/message/${mail.ID}/headers`)).json()) as Record<string, string[]>;
    const url = /<(https?:\/\/[^>]+)>/.exec(headers["List-Unsubscribe"]![0]!)![1]!;
    const path = new URL(url).pathname;
    // A link scanner fetching the URL only gets redirected to the confirmation page.
    const peek = await fetch(BASE + path, { redirect: "manual" });
    expect(peek.status).toBe(303);
    expect(peek.headers.get("location")).toContain("/unsubscribe/");
    expect(await prisma.consent.count({ where: { leadId, status: "OPTED_OUT" } })).toBe(0);

    const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
    expect(r.status).toBe(200);
    const consents = await prisma.consent.findMany({ where: { leadId } });
    expect(consents.some((c) => c.channel === "EMAIL" && c.status === "OPTED_OUT")).toBe(true);
  });
});
