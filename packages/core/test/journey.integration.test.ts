import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@lfm/db";
import { resetDatabase } from "@lfm/db/testing";
import {
  acceptInvitation,
  activateAutomation,
  changeLeadStatus,
  connectSmtp,
  createWebsiteForm,
  findDueMessages,
  findDueTaskIds,
  findWebsiteForm,
  getActivationStatus,
  getDashboardOverview,
  getLeadDetail,
  ingestWebsiteSubmission,
  inviteMember,
  listLeads,
  listNotifications,
  listTemplates,
  logInteraction,
  processDueTask,
  recordInboundMessage,
  registerOwner,
  resolveOrgContext,
  sendQueuedMessage,
  setTemplateApproval,
  unsubscribeByToken,
  unsubscribeToken,
  updateMember,
  updateMessagingSettings,
  type OrgContext,
} from "../src";

/**
 * The whole product journey from the spec, in one story, against real Postgres and a real SMTP
 * server (Mailpit). The clock is simulated by passing `now` to the same functions the worker runs.
 *
 *   setup → website lead arrives → round-robin → acknowledgement email → 24h follow-up email →
 *   customer replies (sequence pauses, employee is told) → employee calls (sequence re-timed) →
 *   converted (everything stops) — while a second lead keeps going and then unsubscribes.
 */
const MAILPIT = process.env.MAILPIT_API ?? "http://localhost:8025/api/v1";
const PASSWORD = "longpassword1";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Mail = { ID: string; Subject: string; To: { Address: string }[] };
const mailbox = async (): Promise<Mail[]> => ((await (await fetch(`${MAILPIT}/messages?limit=200`)).json()) as { messages: Mail[] }).messages;
const mailTo = async (addr: string) => (await mailbox()).filter((m) => m.To.some((t) => t.Address === addr));

/** One pass of what the worker does on each sweep: fire due follow-ups, then send due messages. */
async function workerTick(now: Date) {
  for (const id of await findDueTaskIds(now)) await processDueTask(id, now);
  const outcomes: string[] = [];
  for (const m of await findDueMessages(now)) outcomes.push(await sendQueuedMessage(m.id, now));
  return outcomes;
}

const messagesOf = (leadId: string) => prisma.message.findMany({ where: { leadId }, orderBy: { createdAt: "asc" } });
const pendingSteps = (leadId: string) =>
  prisma.followUpTask.findMany({ where: { leadId, status: "SCHEDULED" }, orderBy: { dueAt: "asc" } });

let owner: OrgContext, priya: OrgContext, arjun: OrgContext, rival: OrgContext;
let formKey: string;
const T0 = new Date();

beforeAll(async () => {
  await resetDatabase();
  await fetch(`${MAILPIT}/messages`, { method: "DELETE" });
});
afterAll(() => prisma.$disconnect());

describe("complete workflow", () => {
  it("1. a business owner sets up the automation; sending stays off until the checklist passes", async () => {
    const reg = await registerOwner({ name: "Meera Shah", email: "meera@acme.test", password: PASSWORD, businessName: "Acme Digital", businessEmail: "hello@acme.test", timezone: "Asia/Kolkata" });
    owner = (await resolveOrgContext(reg.userId, reg.organizationId))!;
    // Always-open hours keep the simulated clock simple; working-hours maths has its own tests.
    await prisma.organization.update({ where: { id: owner.organizationId }, data: { workingHours: {} } });
    await updateMember(owner, owner.memberId, { receivesLeads: false });

    for (const [name, email] of [["Priya Nair", "priya@acme.test"], ["Arjun Rao", "arjun@acme.test"]] as const) {
      const { token } = await inviteMember(owner, { email, role: "SALESPERSON" });
      await acceptInvitation({ token, name, password: PASSWORD });
    }
    const members = await prisma.organizationMember.findMany({ where: { organizationId: owner.organizationId }, include: { user: true } });
    const ctxFor = async (email: string) => (await resolveOrgContext(members.find((m) => m.user.email === email)!.userId, owner.organizationId))!;
    priya = await ctxFor("priya@acme.test");
    arjun = await ctxFor("arjun@acme.test");

    const before = await getActivationStatus(owner.organizationId);
    expect(before.canActivate).toBe(false);
    await expect(activateAutomation(owner)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await updateMessagingSettings(owner, { acknowledgementChannels: ["EMAIL"], fallbackChannel: null });
    const smtp = await connectSmtp(owner, { host: "localhost", port: 1025, secure: false, fromEmail: "hello@acme.test", fromName: "Acme Digital" });
    expect(smtp.integration.status).toBe("CONNECTED");
    for (const t of await listTemplates(owner)) if (t.channel === "EMAIL") await setTemplateApproval(owner, t.id, true);
    const form = await createWebsiteForm(owner, { name: "Contact page" });
    formKey = form.webhookKey;

    await activateAutomation(owner);
    expect((await getActivationStatus(owner.organizationId)).status).toBe("ACTIVE");

    // A second business on the same platform, for isolation checks.
    const r2 = await registerOwner({ name: "Ravi", email: "ravi@rival.test", password: PASSWORD, businessName: "Rival Co", businessEmail: "hi@rival.test", timezone: "Asia/Kolkata" });
    rival = (await resolveOrgContext(r2.userId, r2.organizationId))!;
  });

  let leadA: string, leadB: string;

  it("2. website enquiries become leads, shared out by round-robin; retries don't duplicate", async () => {
    const form = (await findWebsiteForm(formKey))!;
    const a = await ingestWebsiteSubmission(form, { fields: { name: "Rahul Sharma", email: "Rahul.Sharma@Example.com", phone: "+91 98765 43210", service: "Website Development" }, verified: true, idempotencyKey: "sub-1" });
    const b = await ingestWebsiteSubmission(form, { fields: { name: "Anita Desai", email: "anita@example.com", service: "SEO" }, verified: true, idempotencyKey: "sub-2" });
    const again = await ingestWebsiteSubmission(form, { fields: { name: "Rahul Sharma", email: "Rahul.Sharma@Example.com" }, verified: true, idempotencyKey: "sub-1" });
    expect([a.outcome, b.outcome, again.outcome]).toEqual(["created", "created", "duplicate_event"]);
    leadA = a.leadId!;
    leadB = b.leadId!;

    const [la, lb] = await Promise.all([getLeadDetail(owner, leadA), getLeadDetail(owner, leadB)]);
    expect(new Set([la.assignedMemberId, lb.assignedMemberId])).toEqual(new Set([priya.memberId, arjun.memberId]));
    expect(la.status).toBe("ASSIGNED");
    expect(la.emailNormalized).toBe("rahul.sharma@example.com");
    expect(la.phoneE164).toBe("+919876543210");
    expect(await prisma.lead.count({ where: { organizationId: owner.organizationId } })).toBe(2);

    // Make Priya own lead A for the rest of the story, whichever way the rotation went.
    if (la.assignedMemberId !== priya.memberId) [leadA, leadB] = [leadB, leadA];
  });

  it("3. each customer gets one acknowledgement email; each employee is notified", async () => {
    await workerTick(new Date(T0.getTime() + 60_000));
    const a = await getLeadDetail(owner, leadA);
    const b = await getLeadDetail(owner, leadB);
    for (const lead of [a, b]) {
      const mails = await mailTo(lead.email!);
      expect(mails).toHaveLength(1);
      expect(mails[0]!.Subject).toBe("We've received your inquiry!");
    }
    // Running the sweep again sends nothing new.
    await workerTick(new Date(T0.getTime() + 120_000));
    expect(await mailTo(a.email!)).toHaveLength(1);
    expect((await listNotifications(priya, {})).items.some((n) => n.title.includes(a.name))).toBe(true);
  });

  it("4. the 24h / 3d / 7d / 14d follow-up sequence is scheduled for every new lead", async () => {
    const steps = await pendingSteps(leadA);
    const created = (await prisma.lead.findUniqueOrThrow({ where: { id: leadA } })).createdAt.getTime();
    expect(steps.map((s) => Math.round((s.dueAt.getTime() - created) / HOUR))).toEqual([24, 72, 168, 336]);
  });

  it("5. after 24h without contact the reminder fires and the follow-up email goes out", async () => {
    await workerTick(new Date(T0.getTime() + 25 * HOUR));
    for (const id of [leadA, leadB]) {
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
      expect(lead.status).toBe("FOLLOW_UP_DUE");
      expect(lead.followUpStep).toBe(1);
      const sent = (await messagesOf(id)).filter((m) => m.status === "SENT").map((m) => m.purpose);
      expect(sent).toEqual(["acknowledgement", "follow_up"]);
      expect(await mailTo(lead.email!)).toHaveLength(2);
    }
  });

  it("6. the customer replies to the follow-up email: automated messages pause and the employee is told", async () => {
    const followUp = (await messagesOf(leadA)).find((m) => m.purpose === "follow_up")!;
    const r = await recordInboundMessage({
      organizationId: owner.organizationId,
      channel: "EMAIL",
      from: "rahul.sharma@example.com",
      body: "Yes please, can we talk tomorrow?",
      providerMessageId: "<reply-1@mail.example.com>",
      inReplyToMessageId: followUp.id,
      receivedAt: new Date(T0.getTime() + 26 * HOUR),
    });
    expect(r?.lead.id).toBe(leadA);
    // The same inbound message delivered twice is stored once.
    const dup = await recordInboundMessage({ organizationId: owner.organizationId, channel: "EMAIL", from: "rahul.sharma@example.com", body: "Yes please, can we talk tomorrow?", providerMessageId: "<reply-1@mail.example.com>" });
    expect(dup?.duplicate).toBe(true);

    expect(await pendingSteps(leadA)).toHaveLength(0);
    const reminder = await prisma.followUpTask.findFirstOrThrow({ where: { leadId: leadA, status: "DUE", sequenceRunId: { startsWith: "reply_" } } });
    expect(reminder.title).toMatch(/replied/);
    expect((await listNotifications(priya, {})).items.some((n) => n.title === "Rahul Sharma replied")).toBe(true);

    // Day 4: lead B gets its 3-day follow-up; lead A (who replied) gets nothing automated.
    await workerTick(new Date(T0.getTime() + 73 * HOUR));
    expect(await mailTo("rahul.sharma@example.com")).toHaveLength(2);
    expect(await mailTo("anita@example.com")).toHaveLength(3);
  });

  it("7. the employee calls back; the sequence restarts from that contact", async () => {
    const at = new Date(); // contact times can't be in the future, so this one uses the real clock
    await logInteraction(priya, leadA, { channel: "PHONE", note: "Discussed scope, sending proposal", awaitingCustomer: true });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadA } });
    expect(lead.status).toBe("WAITING_FOR_CUSTOMER");
    const steps = await pendingSteps(leadA);
    expect(steps.length).toBeGreaterThan(0);
    expect(Math.round((steps[0]!.dueAt.getTime() - at.getTime()) / HOUR)).toBe(24);
    // Arjun can't act on Priya's lead.
    await expect(logInteraction(arjun, leadA, { channel: "PHONE" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("8. converting the lead stops every follow-up; nothing more is sent", async () => {
    await changeLeadStatus(priya, leadA, { status: "QUALIFIED" });
    await changeLeadStatus(priya, leadA, { status: "CONVERTED" });
    expect(await pendingSteps(leadA)).toHaveLength(0);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadA } })).nextFollowUpAt).toBeNull();
    await workerTick(new Date(T0.getTime() + 20 * DAY));
    expect(await mailTo("rahul.sharma@example.com")).toHaveLength(2);
  });

  it("9. the other customer unsubscribes from the email link; later follow-ups aren't emailed", async () => {
    const before = (await mailTo("anita@example.com")).length;
    await unsubscribeByToken(unsubscribeToken(leadB, "EMAIL"));
    await workerTick(new Date(T0.getTime() + 30 * DAY));
    expect(await mailTo("anita@example.com")).toHaveLength(before);
    expect(await prisma.message.count({ where: { leadId: leadB, status: "SENT", createdAt: { gt: new Date(T0.getTime() + 74 * HOUR) } } })).toBe(0);
    // Employee reminders still happen — only messages to the customer stop.
    expect(await prisma.followUpTask.count({ where: { leadId: leadB, status: "DUE" } })).toBeGreaterThan(0);
  });

  it("10. the dashboard adds up, and another business sees none of it", async () => {
    const o = await getDashboardOverview(owner);
    expect(o.stats.total).toBe(2);
    expect(o.stats.converted).toBe(1);
    expect((await getDashboardOverview(rival)).stats.total).toBe(0);
    await expect(getLeadDetail(rival, leadB)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listLeads(rival, { includeClosed: "true" })).items).toHaveLength(0);
    // Each salesperson sees only their own lead.
    expect((await listLeads(priya, { includeClosed: "true" })).items.map((l) => l.id)).toEqual([leadA]);
  });
});
