import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@lfm/db";
import { resetDatabase } from "@lfm/db/testing";
import {
  activateAutomation,
  buildRawEmail,
  checkBrowserSubmission,
  connectHubSpot,
  connectSmtp,
  connectWhatsApp,
  createOAuthState,
  createWebsiteForm,
  encryptJson,
  extractPlainText,
  findWebsiteForm,
  hmacSha256Hex,
  ingestWebsiteSubmission,
  listTemplates,
  mapFormFields,
  ourMessageIdFrom,
  parseFromHeader,
  pollGmail,
  processMetaLeadgenWebhook,
  processWhatsAppWebhook,
  registerOwner,
  resolveOrgContext,
  saveTemplate,
  selectMetaPage,
  sendQueuedMessage,
  setTemplateApproval,
  signWebsitePayload,
  stripQuotedReply,
  syncHubSpot,
  updateMessagingSettings,
  verifyMetaChallenge,
  verifyMetaSignature,
  verifyOAuthState,
  verifyWebsiteSignature,
  websiteSecret,
  type OrgContext,
} from "../src";
import { FakeProvider } from "./helpers/fake-provider";

const fake = new FakeProvider();
const V = "/v23.0";

beforeAll(async () => {
  await fake.start();
  process.env.META_GRAPH_URL = fake.url;
  process.env.META_GRAPH_VERSION = "v23.0";
  process.env.META_APP_ID = "1111";
  process.env.META_APP_SECRET = "app-secret-for-tests";
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verify-me";
  process.env.HUBSPOT_API_URL = fake.url;
  process.env.GMAIL_API_URL = `${fake.url}/gmail/v1`;
  process.env.GOOGLE_TOKEN_URL = `${fake.url}/token`;
  process.env.GOOGLE_CLIENT_ID = "gid";
  process.env.GOOGLE_CLIENT_SECRET = "gsecret";
});
afterAll(async () => {
  await fake.stop();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase();
  fake.reset();
});

async function setup() {
  const reg = await registerOwner({ name: "Owner", email: "owner@acme.test", password: "longpassword1", businessName: "Acme", businessEmail: "hello@acme.test", timezone: "Asia/Kolkata" });
  const ctx = (await resolveOrgContext(reg.userId, reg.organizationId))!;
  await prisma.organization.update({ where: { id: ctx.organizationId }, data: { workingHours: {} } });
  return ctx;
}

const leads = (organizationId: string) => prisma.lead.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });

// ───────────────────────────── Unit-ish helpers ─────────────────────────────

describe("form field mapping", () => {
  it("understands common field names and keeps the rest", () => {
    const { contact, extra } = mapFormFields({ "First Name": "Rahul", last_name: "Sharma", "E-mail": "R@x.com", Mobile: "98765 43210", Service: "SEO", "Your Message": "Hi", budget: "50k" });
    expect(contact).toMatchObject({ name: "Rahul Sharma", email: "R@x.com", phone: "98765 43210", subject: "SEO", inquiry: "Hi" });
    expect(extra).toEqual({ budget: "50k" });
  });
});

describe("signatures and OAuth state", () => {
  it("verifies website signatures with replay protection", () => {
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const sig = signWebsitePayload("s3cret", ts, '{"a":1}');
    expect(verifyWebsiteSignature("s3cret", '{"a":1}', String(ts), sig, now).ok).toBe(true);
    expect(verifyWebsiteSignature("s3cret", '{"a":2}', String(ts), sig, now).ok).toBe(false);
    expect(verifyWebsiteSignature("other", '{"a":1}', String(ts), sig, now).ok).toBe(false);
    expect(verifyWebsiteSignature("s3cret", '{"a":1}', String(ts - 600), signWebsitePayload("s3cret", ts - 600, '{"a":1}'), now).ok).toBe(false);
  });

  it("verifies Meta signatures and the webhook handshake", () => {
    const body = '{"x":1}';
    expect(verifyMetaSignature(body, `sha256=${hmacSha256Hex("app-secret-for-tests", body)}`)).toBe(true);
    expect(verifyMetaSignature(body, `sha256=${hmacSha256Hex("wrong", body)}`)).toBe(false);
    expect(verifyMetaSignature(body, null)).toBe(false);
    expect(verifyMetaChallenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "42" }))).toBe("42");
    expect(verifyMetaChallenge(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42" }))).toBeNull();
  });

  it("binds OAuth state to the user and provider", () => {
    const s = createOAuthState("org1", "user1", "gmail");
    expect(verifyOAuthState(s, { userId: "user1", provider: "gmail" }).organizationId).toBe("org1");
    expect(() => verifyOAuthState(s, { userId: "user2", provider: "gmail" })).toThrow();
    expect(() => verifyOAuthState(s, { userId: "user1", provider: "meta" })).toThrow();
    expect(() => verifyOAuthState(`${s.split(".")[0]}.forged`, { userId: "user1", provider: "gmail" })).toThrow();
  });
});

// ───────────────────────────── Website ─────────────────────────────

describe("website forms", () => {
  it("creates a lead once per submission, assigns it and opts in to WhatsApp when ticked", async () => {
    const ctx = await setup();
    const { integration, secret, webhookKey } = await createWebsiteForm(ctx, { name: "Contact page" });
    expect(secret).toMatch(/^whsec_/);
    expect(integration.status).toBe("PENDING");
    const form = (await findWebsiteForm(webhookKey))!;
    expect(websiteSecret(form)).toBe(secret);

    const fields = { name: "Rahul Sharma", email: "rahul@example.com", phone: "+91 98765 43210", message: "Need a website", whatsapp_opt_in: "on", budget: "50k" };
    const a = await ingestWebsiteSubmission(form, { fields, verified: true, idempotencyKey: "sub-1" });
    const b = await ingestWebsiteSubmission(form, { fields, verified: true, idempotencyKey: "sub-1" });
    expect(a.outcome).toBe("created");
    expect(b).toEqual({ outcome: "duplicate_event", leadId: a.leadId });

    const [lead] = await leads(ctx.organizationId);
    expect(lead).toMatchObject({ sourceType: "WEBSITE", status: "ASSIGNED", phoneE164: "+919876543210" });
    expect((lead!.sourceMetadata as any).fields).toEqual({ budget: "50k" });
    expect((lead!.sourceMetadata as any).verified).toBe(true);
    expect(await prisma.consent.findFirst({ where: { leadId: lead!.id, channel: "WHATSAPP" } })).toMatchObject({ status: "OPTED_IN" });
    expect(await prisma.followUpTask.count({ where: { leadId: lead!.id } })).toBe(4);
    expect((await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } })).status).toBe("CONNECTED");
  });

  it("merges a returning customer according to the duplicate policy", async () => {
    const ctx = await setup();
    const { webhookKey } = await createWebsiteForm(ctx, {});
    const form = (await findWebsiteForm(webhookKey))!;
    await ingestWebsiteSubmission(form, { fields: { name: "R", email: "r@x.com", message: "first" }, verified: true, idempotencyKey: "1" });
    const second = await ingestWebsiteSubmission(form, { fields: { name: "R", email: "R@X.com", message: "second" }, verified: true, idempotencyKey: "2" });
    expect(second.outcome).toBe("merged");
    expect(await prisma.lead.count({ where: { organizationId: ctx.organizationId } })).toBe(1);
  });

  it("dedupes identical browser submissions without an id, and rejects empty contact details", async () => {
    const ctx = await setup();
    const { webhookKey } = await createWebsiteForm(ctx, {});
    const form = (await findWebsiteForm(webhookKey))!;
    const s = { fields: { name: "Anita", email: "anita@x.com" }, verified: false, ip: "1.2.3.4" };
    await ingestWebsiteSubmission(form, s);
    expect((await ingestWebsiteSubmission(form, s)).outcome).toBe("duplicate_event");
    await expect(ingestWebsiteSubmission(form, { fields: { name: "No contact" }, verified: false })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("protects the public form: origin allow-list, honeypot and fill time", async () => {
    const ctx = await setup();
    const { webhookKey } = await createWebsiteForm(ctx, { allowedOrigins: ["https://acme.example"] });
    const form = (await findWebsiteForm(webhookKey))!;
    const self = "http://localhost:3000";
    expect(() => checkBrowserSubmission(form, { origin: "https://evil.example", fields: {} }, self)).toThrow(/isn't allowed/);
    expect(checkBrowserSubmission(form, { origin: "https://acme.example", fields: {} }, self).spam).toBe(false);
    expect(checkBrowserSubmission(form, { origin: self, fields: {} }, self).spam).toBe(false); // hosted form
    expect(checkBrowserSubmission(form, { origin: self, fields: { lfm_hp: "http://spam" } }, self).spam).toBe(true);
    expect(checkBrowserSubmission(form, { origin: self, fields: { lfm_started: String(Date.now() - 500) } }, self).spam).toBe(true);
  });

  it("disconnected forms stop accepting submissions", async () => {
    const ctx = await setup();
    const { integration, webhookKey } = await createWebsiteForm(ctx, {});
    await prisma.integration.update({ where: { id: integration.id }, data: { status: "DISCONNECTED" } });
    expect(await findWebsiteForm(webhookKey)).toBeNull();
  });
});

// ───────────────────────────── WhatsApp ─────────────────────────────

async function connectWa(ctx: OrgContext) {
  fake.on(`GET ${V}/555000`, () => ({ json: { display_phone_number: "+91 90000 00000", verified_name: "Acme" } }));
  fake.on(`POST ${V}/777000/subscribed_apps`, () => ({ json: { success: true } }));
  return connectWhatsApp(ctx, { phoneNumberId: "555000", businessAccountId: "777000", accessToken: "EAAG-test-token-123456789" });
}

const waWebhook = (value: object) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "555000" }, ...value } }] }] });

describe("WhatsApp Business", () => {
  it("connects only after Graph confirms the number and subscribes the account to webhooks", async () => {
    const ctx = await setup();
    const res = await connectWa(ctx);
    expect(res.integration.status).toBe("CONNECTED");
    expect(res.integration.name).toBe("WhatsApp +91 90000 00000");
    expect(fake.callsTo("POST", "/777000/subscribed_apps")).toHaveLength(1);
    expect(fake.callsTo("GET", "/555000")[0]!.headers.authorization).toBe("Bearer EAAG-test-token-123456789");

    fake.reset();
    fake.on(`GET ${V}/555000`, () => ({ status: 401, json: { error: { message: "Invalid OAuth access token", code: 190 } } }));
    const bad = await connectWhatsApp(ctx, { phoneNumberId: "555000", accessToken: "EAAG-expired-token-12345" });
    expect(bad.integration.status).toBe("ERROR");
    expect(bad.integration.lastError).toMatch(/invalid or has expired/);
  });

  it("a message from a new number creates a lead, opens the 24h window and is acknowledged on WhatsApp", async () => {
    const ctx = await setup();
    await connectWa(ctx);
    await connectSmtp(ctx, { host: "localhost", port: 1025, secure: false, fromEmail: "hello@acme.test", fromName: "Acme" });
    for (const t of await listTemplates(ctx)) if (t.key === "ACKNOWLEDGEMENT") await setTemplateApproval(ctx, t.id, true);
    for (const t of await listTemplates(ctx)) if (t.key === "FOLLOW_UP") await setTemplateApproval(ctx, t.id, true);
    await activateAutomation(ctx);

    const payload = waWebhook({ contacts: [{ wa_id: "919811122233", profile: { name: "Meera" } }], messages: [{ from: "919811122233", id: "wamid.IN1", type: "text", text: { body: "Hi, price for logo design?" }, timestamp: String(Math.floor(Date.now() / 1000)) }] });
    expect(await processWhatsAppWebhook(payload)).toMatchObject({ newLeads: 1 });
    expect(await processWhatsAppWebhook(payload)).toMatchObject({ newLeads: 0, messages: 0 }); // Meta retry

    const [lead] = await leads(ctx.organizationId);
    expect(lead).toMatchObject({ name: "Meera", phoneE164: "+919811122233", sourceType: "WHATSAPP" });
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { leadId_channel: { leadId: lead!.id, channel: "WHATSAPP" } } });
    expect(conv.windowExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const out = await prisma.message.findMany({ where: { leadId: lead!.id, direction: "OUTBOUND" } });
    expect(out.map((m) => m.channel)).toEqual(["WHATSAPP"]);

    // Sending inside the window: free text to the customer's WhatsApp id.
    fake.on(`POST ${V}/555000/messages`, () => ({ json: { messages: [{ id: "wamid.OUT1" }] } }));
    expect(await sendQueuedMessage(out[0]!.id)).toBe("sent");
    const sent = fake.callsTo("POST", "/555000/messages")[0]!.json;
    expect(sent).toMatchObject({ messaging_product: "whatsapp", to: "919811122233", type: "text" });
    expect(sent.text.body).toContain("Hi Meera, thanks for contacting Acme!");

    // Delivery receipts move forward only.
    await processWhatsAppWebhook(waWebhook({ statuses: [{ id: "wamid.OUT1", status: "read", timestamp: "1" }] }));
    await processWhatsAppWebhook(waWebhook({ statuses: [{ id: "wamid.OUT1", status: "delivered", timestamp: "1" }] }));
    expect((await prisma.message.findUniqueOrThrow({ where: { id: out[0]!.id } })).status).toBe("READ");
  });

  it("outside the 24h window uses the approved Meta template with parameters in order", async () => {
    const ctx = await setup();
    await connectWa(ctx);
    await saveTemplate(ctx, { key: "ACKNOWLEDGEMENT", channel: "WHATSAPP", body: "Hi {{customer_first_name}}, thanks for contacting {{business_name}}!", providerTemplateName: "inquiry_received", providerLanguage: "en" });
    for (const t of await listTemplates(ctx)) await setTemplateApproval(ctx, t.id, true);
    await updateMessagingSettings(ctx, { acknowledgementChannels: ["WHATSAPP"] });
    await activateAutomation(ctx);
    const { webhookKey } = await createWebsiteForm(ctx, {});
    const form = (await findWebsiteForm(webhookKey))!;
    const { leadId } = await ingestWebsiteSubmission(form, { fields: { name: "Kavya Reddy", phone: "+91 98111 00000", whatsapp_opt_in: "yes" }, verified: true, idempotencyKey: "k1" });
    const m = await prisma.message.findFirstOrThrow({ where: { leadId: leadId!, channel: "WHATSAPP" } });
    fake.on(`POST ${V}/555000/messages`, () => ({ json: { messages: [{ id: "wamid.T1" }] } }));
    expect(await sendQueuedMessage(m.id)).toBe("sent");
    const body = fake.callsTo("POST", "/555000/messages")[0]!.json;
    expect(body.type).toBe("template");
    expect(body.template).toMatchObject({ name: "inquiry_received", language: { code: "en" } });
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(["Kavya", "Acme"]);
  });

  it("replies pause follow-ups; STOP opts the customer out", async () => {
    const ctx = await setup();
    await connectWa(ctx);
    const first = waWebhook({ messages: [{ from: "919800000001", id: "wamid.A", type: "text", text: { body: "hello" } }] });
    await processWhatsAppWebhook(first);
    const [lead] = await leads(ctx.organizationId);
    await processWhatsAppWebhook(waWebhook({ messages: [{ from: "919800000001", id: "wamid.B", type: "text", text: { body: "any update?" } }] }));
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead!.id } })).lastCustomerReplyAt).not.toBeNull();
    await processWhatsAppWebhook(waWebhook({ messages: [{ from: "919800000001", id: "wamid.C", type: "text", text: { body: "STOP" } }] }));
    expect(await prisma.consent.findFirst({ where: { leadId: lead!.id, channel: "WHATSAPP" } })).toMatchObject({ status: "OPTED_OUT" });
    expect(await prisma.message.count({ where: { leadId: lead!.id, direction: "INBOUND" } })).toBe(3);
  });

  it("ignores events for numbers that aren't connected", async () => {
    await setup();
    expect(await processWhatsAppWebhook(waWebhook({ messages: [{ from: "1", id: "x", type: "text", text: { body: "hi" } }] }))).toMatchObject({ ignored: 1 });
  });
});

// ───────────────────────────── Meta Lead Ads ─────────────────────────────

describe("Facebook & Instagram lead ads", () => {
  async function connectPage(ctx: OrgContext) {
    const i = await prisma.integration.create({
      data: {
        organizationId: ctx.organizationId,
        provider: "META_LEAD_ADS",
        name: "Facebook",
        status: "PENDING",
        encryptedCredentials: encryptJson({ userToken: "user-tok", pages: [{ id: "4242", name: "Acme Page", access_token: "page-tok" }] }),
        config: { pages: [{ id: "4242", name: "Acme Page" }] },
      },
    });
    fake.on(`POST ${V}/4242/subscribed_apps`, () => ({ json: { success: true } }));
    fake.on(`GET ${V}/4242/subscribed_apps`, () => ({ json: { data: [{ id: "1111", subscribed_fields: ["leadgen"] }] } }));
    await selectMetaPage(ctx, { pageId: "4242" });
    return i;
  }

  it("selecting a Page subscribes it to lead webhooks and only then connects", async () => {
    const ctx = await setup();
    const i = await connectPage(ctx);
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: i.id } });
    expect(row).toMatchObject({ status: "CONNECTED", name: "Facebook & Instagram — Acme Page" });
    expect(fake.callsTo("POST", "/4242/subscribed_apps")[0]!.query.get("subscribed_fields")).toBe("leadgen");
    await expect(selectMetaPage(ctx, { pageId: "999" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("fetches each new lead's answers and creates the lead once", async () => {
    const ctx = await setup();
    await connectPage(ctx);
    fake.on(`GET ${V}/lead-777`, (r) => {
      expect(r.query.get("access_token")).toBe("page-tok");
      return { json: { id: "lead-777", form_id: "f1", campaign_name: "Diwali offer", field_data: [{ name: "full_name", values: ["Arjun Mehta"] }, { name: "email", values: ["arjun@x.com"] }, { name: "phone_number", values: ["+919812345678"] }, { name: "city", values: ["Pune"] }] } };
    });
    const payload = { object: "page", entry: [{ id: "4242", changes: [{ field: "leadgen", value: { leadgen_id: "lead-777", page_id: "4242", form_id: "f1" } }] }] };
    expect(await processMetaLeadgenWebhook(payload)).toMatchObject({ leads: 1 });
    expect(await processMetaLeadgenWebhook(payload)).toMatchObject({ duplicates: 1, leads: 0 });
    const [lead] = await leads(ctx.organizationId);
    expect(lead).toMatchObject({ name: "Arjun Mehta", email: "arjun@x.com", sourceType: "META", subject: "Diwali offer" });
    expect((lead!.sourceMetadata as any).fields).toEqual({ city: "Pune" });
    expect(fake.callsTo("GET", "/lead-777")).toHaveLength(1);
  });

  it("a failed lead fetch throws (so Meta retries) and creates nothing", async () => {
    const ctx = await setup();
    await connectPage(ctx);
    fake.on(`GET ${V}/lead-err`, () => ({ status: 500, json: { error: { message: "temporary" } } }));
    await expect(processMetaLeadgenWebhook({ entry: [{ id: "4242", changes: [{ field: "leadgen", value: { leadgen_id: "lead-err", page_id: "4242" } }] }] })).rejects.toThrow();
    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.inboundEvent.count()).toBe(0);
  });
});

// ───────────────────────────── HubSpot ─────────────────────────────

describe("HubSpot", () => {
  it("imports contacts created after connecting, once each, skipping ones without contact details", async () => {
    const ctx = await setup();
    fake.on("GET /crm/v3/objects/contacts", () => ({ json: { results: [] } }));
    fake.on("GET /account-info/v3/details", () => ({ json: { portalId: 99 } }));
    const res = await connectHubSpot(ctx, { accessToken: "pat-na1-0000000000000000000000" });
    expect(res.integration.status).toBe("CONNECTED");
    const created = new Date(Date.now() + 1000).toISOString();
    fake.on("POST /crm/v3/objects/contacts/search", (r) => {
      expect(r.json.filterGroups[0].filters[0].propertyName).toBe("createdate");
      return {
        json: {
          results: [
            { id: "101", createdAt: created, properties: { firstname: "Neha", lastname: "Gupta", email: "neha@x.com", phone: "+919800011111", createdate: created } },
            { id: "102", createdAt: created, properties: { firstname: "No", lastname: "Details", createdate: created } },
          ],
        },
      };
    });
    const i = await prisma.integration.findFirstOrThrow({ where: { provider: "HUBSPOT" } });
    expect(await syncHubSpot(i)).toEqual({ imported: 1 });
    expect(await syncHubSpot(await prisma.integration.findFirstOrThrow({ where: { provider: "HUBSPOT" } }))).toEqual({ imported: 0 });
    const all = await leads(ctx.organizationId);
    expect(all.map((l) => l.name)).toEqual(["Neha Gupta"]);
    expect(all[0]!.sourceType).toBe("CRM");
  });

  it("a rejected token is shown as needing attention", async () => {
    const ctx = await setup();
    fake.on("GET /crm/v3/objects/contacts", () => ({ status: 401, json: { message: "Authentication credentials not found" } }));
    const res = await connectHubSpot(ctx, { accessToken: "pat-na1-bad-000000000000000000" });
    expect(res.integration.status).toBe("ERROR");
  });
});

// ───────────────────────────── Gmail ─────────────────────────────

describe("Gmail", () => {
  it("parses headers, bodies and quoted replies", () => {
    expect(parseFromHeader('"Rahul Sharma" <Rahul@Example.com>')).toEqual({ name: "Rahul Sharma", email: "rahul@example.com" });
    expect(parseFromHeader("a@b.com")).toEqual({ name: null, email: "a@b.com" });
    expect(ourMessageIdFrom("<cmwkg12l9001pva7wxei5u5rc@acme.test>")).toBe("cmwkg12l9001pva7wxei5u5rc");
    expect(stripQuotedReply("Yes please!\n\nOn Tue, Acme wrote:\n> old text")).toBe("Yes please!");
    const part = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Hello there").toString("base64url") } }] };
    expect(extractPlainText(part)).toBe("Hello there");
  });

  it("builds a proper MIME message", async () => {
    const raw = await buildRawEmail({ from: "hello@acme.test", fromName: "Acme", to: "c@x.com", subject: "Hi", text: "Body", messageId: "abc123def456ghi789jkl0" });
    const mime = Buffer.from(raw, "base64url").toString();
    expect(mime).toContain("Subject: Hi");
    expect(mime).toContain("Message-ID: <abc123def456ghi789jkl0@acme.test>");
    expect(mime).toContain("To: c@x.com");
  });

  it("refreshes an expired token, records replies to our emails and (optionally) creates leads from new emails", async () => {
    const ctx = await setup();
    const i = await prisma.integration.create({
      data: {
        organizationId: ctx.organizationId,
        provider: "GMAIL",
        name: "Gmail (hello@acme.test)",
        status: "CONNECTED",
        connectedAt: new Date(),
        encryptedCredentials: encryptJson({ accessToken: "old", refreshToken: "refresh-1", expiresAt: Date.now() - 1000 }),
        config: { email: "hello@acme.test", historyId: "100", createLeadsFromNewEmails: true },
      },
    });
    // An existing lead we emailed.
    const lead = await prisma.lead.create({ data: { organizationId: ctx.organizationId, name: "Rahul", email: "rahul@example.com", emailNormalized: "rahul@example.com", sourceType: "MANUAL" } });
    const ours = await prisma.message.create({ data: { organizationId: ctx.organizationId, leadId: lead.id, direction: "OUTBOUND", channel: "EMAIL", body: "quote", status: "SENT" } });

    fake.on("POST /token", (r) => {
      expect(r.json.refresh_token).toBe("refresh-1");
      return { json: { access_token: "fresh", expires_in: 3600 } };
    });
    fake.on("GET /gmail/v1/users/me/history", (r) => {
      expect(r.headers.authorization).toBe("Bearer fresh");
      expect(r.query.get("startHistoryId")).toBe("100");
      return { json: { historyId: "105", history: [{ messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }, { message: { id: "m2", labelIds: ["INBOX"] } }, { message: { id: "m3", labelIds: ["INBOX"] } }] }] } };
    });
    const msg = (id: string, from: string, extra: { name: string; value: string }[] = []) => ({
      id,
      threadId: `t-${id}`,
      internalDate: String(Date.now()),
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "Subject", value: "Re: quote" }, ...extra], body: { data: Buffer.from(`Message ${id}\n\nOn Mon, Acme wrote:\n> old`).toString("base64url") } },
    });
    fake.on("GET /gmail/v1/users/me/messages/m1", () => ({ json: msg("m1", '"Rahul" <rahul@example.com>', [{ name: "In-Reply-To", value: `<${ours.id}@acme.test>` }]) }));
    fake.on("GET /gmail/v1/users/me/messages/m2", () => ({ json: msg("m2", "Priya New <priya.new@x.com>") }));
    fake.on("GET /gmail/v1/users/me/messages/m3", () => ({ json: msg("m3", "hello@acme.test") })); // our own sent copy

    expect(await pollGmail(i)).toEqual({ replies: 1, newLeads: 1 });
    const reply = await prisma.message.findFirstOrThrow({ where: { leadId: lead.id, direction: "INBOUND" } });
    expect(reply.body).toBe("Message m1");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).lastCustomerReplyAt).not.toBeNull();
    const created = await prisma.lead.findFirstOrThrow({ where: { email: "priya.new@x.com" } });
    expect(created).toMatchObject({ name: "Priya New", sourceType: "EMAIL" });
    const after = await prisma.integration.findUniqueOrThrow({ where: { id: i.id } });
    expect((after.config as { historyId: string }).historyId).toBe("105");
    expect(fake.callsTo("POST", "/token")).toHaveLength(1);
  });
});
