import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@lfm/db";
import { resetDatabase } from "@lfm/db/testing";
import {
  acceptInvitation,
  activateAutomation,
  applyDeliveryStatus,
  connectSmtp,
  createLead,
  describeUnsubscribe,
  disconnectIntegration,
  getActivationStatus,
  inviteMember,
  listNotifications,
  listTemplates,
  pauseAutomation,
  processDueTask,
  queueAcknowledgement,
  recordCustomerReply,
  recordInboundMessage,
  recoverStuckMessages,
  registerOwner,
  resolveOrgContext,
  retryMessage,
  saveTemplate,
  sendManualMessage,
  sendPendingNotificationEmails,
  sendQueuedMessage,
  setTemplateApproval,
  unsubscribeByToken,
  unsubscribeToken,
  updateFollowUpStepChannels,
  updateMember,
  updateMessagingSettings,
  updateMyMembership,
  type OrgContext,
} from "../src";

/**
 * Real SMTP: messages are sent to the Mailpit container from docker-compose and read back via its API.
 */
const MAILPIT = process.env.MAILPIT_API ?? "http://localhost:8025/api/v1";
const PASSWORD = "longpassword1";

type MailSummary = { ID: string; Subject: string; To: { Address: string }[]; Snippet: string };
async function mailbox(): Promise<MailSummary[]> {
  const r = await fetch(`${MAILPIT}/messages?limit=100`);
  return ((await r.json()) as { messages: MailSummary[] }).messages;
}
async function mailText(id: string) {
  return ((await (await fetch(`${MAILPIT}/message/${id}`)).json()) as { Text: string; HTML: string }).Text;
}
async function mailHeaders(id: string) {
  return (await (await fetch(`${MAILPIT}/message/${id}/headers`)).json()) as Record<string, string[]>;
}

async function setup(opts: { connect?: boolean; activate?: boolean } = {}) {
  const reg = await registerOwner({ name: "Owner", email: "owner@acme.test", password: PASSWORD, businessName: "Acme Digital", businessEmail: "hello@acme.test", timezone: "Asia/Kolkata" });
  const owner = (await resolveOrgContext(reg.userId, reg.organizationId))!;
  await prisma.organization.update({ where: { id: owner.organizationId }, data: { workingHours: {} } }); // no sending-hours delay
  await updateMember(owner, owner.memberId, { receivesLeads: false });
  const { token } = await inviteMember(owner, { email: "priya@acme.test", role: "SALESPERSON" });
  const res = await acceptInvitation({ token, name: "Priya Nair", password: PASSWORD });
  const priya = (await resolveOrgContext(res.userId, res.organizationId))!;
  // WhatsApp isn't available in these tests; acknowledge by email only.
  await updateMessagingSettings(owner, { acknowledgementChannels: ["EMAIL"], fallbackChannel: null });
  if (opts.connect !== false) {
    const c = await connectSmtp(owner, { host: "localhost", port: 1025, secure: false, fromEmail: "hello@acme.test", fromName: "Acme Digital" });
    expect(c.test.ok).toBe(true);
  }
  if (opts.activate) {
    for (const t of await listTemplates(owner)) if (t.channel === "EMAIL") await setTemplateApproval(owner, t.id, true);
    await activateAutomation(owner);
  }
  return { owner, priya };
}

const newLead = async (ctx: OrgContext, extra: Record<string, unknown> = {}) =>
  (await createLead(ctx, { name: "Rahul Sharma", email: `rahul${Math.random().toString(36).slice(2, 7)}@example.com`, subject: "Website Development", ...extra })).lead;
const messagesOf = (leadId: string) => prisma.message.findMany({ where: { leadId }, orderBy: { createdAt: "asc" } });

beforeEach(async () => {
  await resetDatabase();
  await fetch(`${MAILPIT}/messages`, { method: "DELETE" });
});
afterAll(() => prisma.$disconnect());

describe("templates", () => {
  it("seeds the spec's templates as drafts; edits send an approved template back to draft", async () => {
    const { owner, priya } = await setup({ connect: false });
    const templates = await listTemplates(owner);
    expect(templates.map((t) => `${t.key}/${t.channel}`).sort()).toEqual([
      "ACKNOWLEDGEMENT/EMAIL",
      "ACKNOWLEDGEMENT/WHATSAPP",
      "FOLLOW_UP/EMAIL",
      "FOLLOW_UP/WHATSAPP",
    ]);
    expect(templates.every((t) => t.approval === "DRAFT")).toBe(true);
    const ack = templates.find((t) => t.key === "ACKNOWLEDGEMENT" && t.channel === "EMAIL")!;
    await expect(setTemplateApproval(priya, ack.id, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await setTemplateApproval(owner, ack.id, true);
    const edited = await saveTemplate(owner, { key: "ACKNOWLEDGEMENT", channel: "EMAIL", subject: ack.subject!, body: `${ack.body}\nP.S. hi` });
    expect(edited.approval).toBe("DRAFT");
    // Saving identical content keeps the approval.
    await setTemplateApproval(owner, ack.id, true);
    expect((await saveTemplate(owner, { key: "ACKNOWLEDGEMENT", channel: "EMAIL", subject: edited.subject!, body: edited.body })).approval).toBe("APPROVED");
  });

  it("rejects unknown variables and email templates without a subject", async () => {
    const { owner } = await setup({ connect: false });
    await expect(saveTemplate(owner, { key: "FOLLOW_UP", channel: "EMAIL", subject: "Hi", body: "Hi {{customr_name}}" })).rejects.toThrow(/customr_name/);
    await expect(saveTemplate(owner, { key: "FOLLOW_UP", channel: "EMAIL", body: "Hi" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await updateMessagingSettings(owner, { customVariables: { office_address: "MG Road" } });
    await saveTemplate(owner, { key: "FOLLOW_UP", channel: "EMAIL", subject: "Hi", body: "Visit {{office_address}}" });
  });
});

describe("SMTP connection", () => {
  it("is CONNECTED only after the real server accepts it; credentials are encrypted and wiped on disconnect", async () => {
    const { owner } = await setup({ connect: false });
    const bad = await connectSmtp(owner, { host: "localhost", port: 1, secure: false, fromEmail: "a@acme.test", fromName: "A", username: "u", password: "secret-pass" });
    expect(bad.test.ok).toBe(false);
    expect(bad.integration.status).toBe("ERROR");
    expect(bad.integration.lastError).toBeTruthy();

    const good = await connectSmtp(owner, { host: "localhost", port: 1025, secure: false, fromEmail: "a@acme.test", fromName: "A", username: "u", password: "secret-pass" });
    expect(good.integration.status).toBe("CONNECTED");
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: good.integration.id } });
    expect(row.encryptedCredentials).toMatch(/^v1:/);
    expect(row.encryptedCredentials).not.toContain("secret-pass");
    expect(JSON.stringify(good.integration)).not.toContain("secret-pass");

    await disconnectIntegration(owner, good.integration.id);
    const after = await prisma.integration.findUniqueOrThrow({ where: { id: good.integration.id } });
    expect(after).toMatchObject({ status: "DISCONNECTED", encryptedCredentials: null });
  });
});

describe("activation", () => {
  it("can't be activated until the needed templates are approved", async () => {
    const { owner } = await setup();
    const status = await getActivationStatus(owner.organizationId);
    expect(status.canActivate).toBe(false);
    expect(status.checks.filter((c) => c.required && !c.ok).map((c) => c.id)).toEqual(
      expect.arrayContaining(["template-ACKNOWLEDGEMENT-EMAIL", "template-FOLLOW_UP-EMAIL"]),
    );
    await expect(activateAutomation(owner)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    for (const t of await listTemplates(owner)) if (t.channel === "EMAIL") await setTemplateApproval(owner, t.id, true);
    expect((await activateAutomation(owner)).status).toBe("ACTIVE");
  });

  it("sends nothing automatically before activation", async () => {
    const { owner } = await setup();
    const l = await newLead(owner);
    expect(await messagesOf(l.id)).toHaveLength(0);
  });
});

describe("acknowledgement", () => {
  it("is queued once, sent once over SMTP, rendered, with an unsubscribe link", async () => {
    const { owner } = await setup({ activate: true });
    const l = await newLead(owner);
    const [m] = await messagesOf(l.id);
    expect(m).toMatchObject({ purpose: "acknowledgement", channel: "EMAIL", status: "QUEUED", idempotencyKey: `ack:${l.id}:EMAIL` });

    // Duplicate request (e.g. a replayed webhook) → same row.
    await prisma.$transaction((tx) => queueAcknowledgement(tx, l));
    expect(await messagesOf(l.id)).toHaveLength(1);

    // Two workers racing → only one sends.
    const results = await Promise.all([sendQueuedMessage(m!.id), sendQueuedMessage(m!.id)]);
    expect(results.sort()).toEqual(["not_ready", "sent"]);
    const sent = await prisma.message.findUniqueOrThrow({ where: { id: m!.id } });
    expect(sent.status).toBe("SENT");
    expect(sent.providerMessageId).toContain(m!.id);

    const box = await mailbox();
    expect(box).toHaveLength(1);
    expect(box[0]!.Subject).toBe("We've received your inquiry!");
    expect(box[0]!.To[0]!.Address).toBe(l.email);
    const text = await mailText(box[0]!.ID);
    expect(text).toContain("Hi Rahul Sharma,");
    expect(text).toContain("Thank you for contacting Acme Digital.");
    expect(text).toContain(`/unsubscribe/${unsubscribeToken(l.id, "EMAIL")}`);
    expect((await mailHeaders(box[0]!.ID))["List-Unsubscribe"]?.[0]).toContain("/api/unsubscribe/");

    const types = (await prisma.leadActivity.findMany({ where: { leadId: l.id } })).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["MESSAGE_QUEUED", "MESSAGE_SENT"]));
    expect(await prisma.automationExecution.count({ where: { eventType: "message.acknowledgement", status: "SUCCESS" } })).toBe(1);
  });

  it("logs why a channel was skipped", async () => {
    const { owner } = await setup({ activate: true });
    await updateMessagingSettings(owner, { acknowledgementChannels: ["EMAIL", "WHATSAPP"] });
    const l = await newLead(owner, { phone: "+91 98765 43210" });
    const skipped = await prisma.automationExecution.findFirstOrThrow({ where: { leadId: l.id, eventType: "message.acknowledgement_skipped" } });
    expect(JSON.stringify(skipped.output)).toContain("WhatsApp isn't connected");
    expect((await messagesOf(l.id)).map((m) => m.channel)).toEqual(["EMAIL"]);
  });

  it("waits for sending hours", async () => {
    const { owner } = await setup({ activate: true });
    // Open only on a weekday that isn't today, so "now" is outside sending hours.
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const tomorrow = days[(new Date().getDay() + 1) % 7]!;
    const wh = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, d === tomorrow ? [{ start: "09:00", end: "10:00" }] : []]));
    await prisma.organization.update({ where: { id: owner.organizationId }, data: { workingHours: wh, timezone: "UTC" } });
    const l = await newLead(owner);
    const [m] = await messagesOf(l.id);
    expect(m!.scheduledFor!.getTime()).toBeGreaterThan(Date.now());
    expect(await sendQueuedMessage(m!.id)).toBe("not_ready");
    expect(await mailbox()).toHaveLength(0);
  });
});

describe("follow-up messages", () => {
  it("are sent when a step becomes due, and cancelled if the customer replied first", async () => {
    const { owner } = await setup({ activate: true });
    await updateFollowUpStepChannels(owner, [{ stepIndex: 1, channels: ["EMAIL"] }]);
    const l = await newLead(owner);
    await sendQueuedMessage((await messagesOf(l.id))[0]!.id); // acknowledgement

    const [step1] = await prisma.followUpTask.findMany({ where: { leadId: l.id }, orderBy: { dueAt: "asc" } });
    await processDueTask(step1!.id, new Date(Date.now() + 25 * 3600_000));
    const fu = (await messagesOf(l.id)).find((m) => m.purpose === "follow_up")!;
    expect(fu.idempotencyKey).toBe(`fu:${step1!.id}:EMAIL`);
    expect(fu.body).toContain("Just following up on your inquiry regarding Website Development.");
    expect(fu.body).toContain("Priya Nair");
    expect(await sendQueuedMessage(fu.id)).toBe("sent");
    expect((await mailbox()).map((x) => x.Subject)).toContain("Following up on your inquiry");

    // Another lead: the customer replies after the message was queued but before it went out.
    const l2 = await newLead(owner);
    const [s1] = await prisma.followUpTask.findMany({ where: { leadId: l2.id }, orderBy: { dueAt: "asc" } });
    await processDueTask(s1!.id, new Date(Date.now() + 25 * 3600_000));
    const fu2 = (await messagesOf(l2.id)).find((m) => m.purpose === "follow_up")!;
    await new Promise((r) => setTimeout(r, 5));
    await recordCustomerReply(owner, l2.id, { channel: "PHONE" });
    expect(await sendQueuedMessage(fu2.id)).toBe("cancelled");
    expect((await prisma.message.findUniqueOrThrow({ where: { id: fu2.id } })).lastError).toBe("Customer replied before this was sent");
  });

  it("pausing the automation stops queued automatic messages", async () => {
    const { owner } = await setup({ activate: true });
    const l = await newLead(owner);
    await pauseAutomation(owner);
    expect(await sendQueuedMessage((await messagesOf(l.id))[0]!.id)).toBe("cancelled");
    expect(await mailbox()).toHaveLength(0);
  });
});

describe("failures and retries", () => {
  async function breakSmtp(organizationId: string, port: number) {
    const i = await prisma.integration.findFirstOrThrow({ where: { organizationId, provider: "SMTP" } });
    await prisma.integration.update({ where: { id: i.id }, data: { config: { ...(i.config as object), port } } });
  }

  it("retries temporary errors with backoff, then fails, notifies, and can be safely retried", async () => {
    const { owner, priya } = await setup({ activate: true });
    await breakSmtp(owner.organizationId, 1); // nothing listens on port 1
    const l = await newLead(owner);
    const [m] = await messagesOf(l.id);

    expect(await sendQueuedMessage(m!.id)).toBe("retry_scheduled");
    let row = await prisma.message.findUniqueOrThrow({ where: { id: m!.id } });
    expect(row).toMatchObject({ status: "QUEUED", attempts: 1, errorRetryable: true });
    expect(row.scheduledFor!.getTime()).toBeGreaterThan(Date.now() + 50_000);

    // Fast-forward to the last attempt.
    await prisma.message.update({ where: { id: m!.id }, data: { attempts: 4, scheduledFor: null } });
    expect(await sendQueuedMessage(m!.id)).toBe("failed");
    row = await prisma.message.findUniqueOrThrow({ where: { id: m!.id } });
    expect(row).toMatchObject({ status: "FAILED", failureKind: "temporary_exhausted" });
    expect((await listNotifications(priya)).items.some((x) => x.type === "messageFailed")).toBe(true);
    expect(await prisma.leadActivity.count({ where: { leadId: l.id, type: "MESSAGE_FAILED" } })).toBe(1);

    await breakSmtp(owner.organizationId, 1025);
    const retried = await retryMessage(owner, m!.id);
    expect(retried).toMatchObject({ status: "QUEUED", attempts: 0, idempotencyKey: `ack:${l.id}:EMAIL` });
    expect(await sendQueuedMessage(m!.id)).toBe("sent");
    expect(await mailbox()).toHaveLength(1);
    await expect(retryMessage(owner, m!.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("an interrupted send becomes 'delivery unknown' and needs confirmation to retry", async () => {
    const { owner } = await setup({ activate: true });
    const l = await newLead(owner);
    const [m] = await messagesOf(l.id);
    await prisma.$executeRaw`UPDATE messages SET status = 'SENDING', "updatedAt" = now() - interval '11 minutes' WHERE id = ${m!.id}`;
    expect(await recoverStuckMessages()).toBe(1);
    expect(await prisma.message.findUniqueOrThrow({ where: { id: m!.id } })).toMatchObject({ status: "FAILED", failureKind: "delivery_unknown" });
    await expect(retryMessage(owner, m!.id)).rejects.toMatchObject({ code: "CONFIRM_POSSIBLE_DUPLICATE" });
    expect((await retryMessage(owner, m!.id, { confirmPossibleDuplicate: true })).status).toBe("QUEUED");
  });
});

describe("opt-out", () => {
  it("the unsubscribe link opts the customer out, cancels queued mail and blocks further sends; forged tokens fail", async () => {
    const { owner } = await setup({ activate: true });
    const l = await newLead(owner);
    const token = unsubscribeToken(l.id, "EMAIL");
    expect((await describeUnsubscribe(token)).businessName).toBe("Acme Digital");
    await unsubscribeByToken(token);
    expect((await messagesOf(l.id))[0]!.status).toBe("CANCELLED");
    await expect(
      sendManualMessage(owner, l.id, { channel: "EMAIL", subject: "Hi", body: "Hello", clientRequestId: randomUUID() }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await prisma.leadActivity.count({ where: { leadId: l.id, type: "OPTED_OUT" } })).toBe(1);
    await expect(describeUnsubscribe(`${l.id}.EMAIL.${"0".repeat(32)}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("manual messages", () => {
  it("are idempotent per request id and count as the employee contacting the customer", async () => {
    const { owner, priya } = await setup();
    const l = await newLead(owner);
    const req = { channel: "EMAIL" as const, subject: "Your quote", body: "Hi Rahul, quote attached.", clientRequestId: randomUUID() };
    const [a, b] = await Promise.all([sendManualMessage(priya, l.id, req), sendManualMessage(priya, l.id, req)]);
    expect(a.id).toBe(b.id);
    expect(await sendQueuedMessage(a.id)).toBe("sent");
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.status).toBe("WAITING_FOR_CUSTOMER");
    expect(after.lastContactAt).not.toBeNull();
    expect((await mailbox()).map((x) => x.Subject)).toEqual(["Your quote"]);
  });

  it("explain what's missing when the channel can't be used", async () => {
    const { owner } = await setup({ connect: false });
    const l = await newLead(owner);
    await expect(sendManualMessage(owner, l.id, { channel: "EMAIL", subject: "x", body: "y", clientRequestId: randomUUID() })).rejects.toThrow(
      /isn't connected/,
    );
    await expect(sendManualMessage(owner, l.id, { channel: "WHATSAPP", body: "y", clientRequestId: randomUUID() })).rejects.toThrow(
      /no valid phone/,
    );
  });
});

describe("inbound replies and delivery status", () => {
  it("matches the sender to the lead, records the reply once and pauses follow-ups", async () => {
    const { owner } = await setup();
    const l = await newLead(owner);
    const reply = { organizationId: owner.organizationId, channel: "EMAIL" as const, from: l.email!.toUpperCase(), body: "Sounds good, call me", providerMessageId: "gmail-123" };
    const first = await recordInboundMessage(reply);
    expect(first?.duplicate).toBe(false);
    expect((await recordInboundMessage(reply))?.duplicate).toBe(true);
    const inbound = (await messagesOf(l.id)).filter((m) => m.direction === "INBOUND");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ status: "RECEIVED", body: "Sounds good, call me" });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.lastCustomerReplyAt).not.toBeNull();
    expect(await recordInboundMessage({ ...reply, from: "stranger@nowhere.test", providerMessageId: "x2" })).toBeNull();
  });

  it("delivery receipts move forward only", async () => {
    const { owner } = await setup({ activate: true });
    const l = await newLead(owner);
    const [m] = await messagesOf(l.id);
    await sendQueuedMessage(m!.id);
    const pid = (await prisma.message.findUniqueOrThrow({ where: { id: m!.id } })).providerMessageId!;
    await applyDeliveryStatus(pid, "READ");
    await applyDeliveryStatus(pid, "DELIVERED");
    const row = await prisma.message.findUniqueOrThrow({ where: { id: m!.id } });
    expect(row.status).toBe("READ");
    expect(row.deliveredAt).not.toBeNull();
  });
});

describe("team notification emails", () => {
  it("are emailed to members who asked for them", async () => {
    const { owner, priya } = await setup();
    await updateMyMembership(priya, { notificationPrefs: { leadAssigned: { inApp: true, email: true } } });
    await newLead(owner); // assigned to Priya
    expect(await sendPendingNotificationEmails()).toBe(1);
    expect(await sendPendingNotificationEmails()).toBe(0);
    const box = await mailbox();
    expect(box[0]!.To[0]!.Address).toBe("priya@acme.test");
    expect(box[0]!.Subject).toContain("[Acme Digital] New lead: Rahul Sharma");
  });
});
