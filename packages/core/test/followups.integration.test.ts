import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@lfm/db";
import { resetDatabase } from "@lfm/db/testing";
import {
  acceptInvitation,
  changeLeadStatus,
  completeFollowUp,
  createLead,
  findDueTaskIds,
  getLeadTimeline,
  inviteMember,
  listFollowUpCenter,
  listNotifications,
  logInteraction,
  notifyOverdueFollowUps,
  processDueTask,
  recordCustomerReply,
  registerOwner,
  rescheduleFollowUp,
  resolveOrgContext,
  scheduleManualFollowUp,
  skipFollowUp,
  updateFollowUpRules,
  updateMember,
  type OrgContext,
} from "../src";

const H = 3_600_000;
const D = 24 * H;
const PASSWORD = "longpassword1";

async function setup() {
  const reg = await registerOwner({ name: "Owner", email: "owner@acme.test", password: PASSWORD, businessName: "Acme", businessEmail: "owner@acme.test", timezone: "Asia/Kolkata" });
  const owner = (await resolveOrgContext(reg.userId, reg.organizationId))!;
  // No working-hours shifting in these tests, so due times are exact.
  await prisma.organization.update({ where: { id: owner.organizationId }, data: { workingHours: {} } });
  await updateMember(owner, owner.memberId, { receivesLeads: false });
  const { token } = await inviteMember(owner, { email: "priya@acme.test", role: "SALESPERSON" });
  const res = await acceptInvitation({ token, name: "Priya", password: PASSWORD });
  const priya = (await resolveOrgContext(res.userId, res.organizationId))!;
  return { owner, priya };
}

let n = 0;
const addLead = async (ctx: OrgContext) => (await createLead(ctx, { name: `Lead ${++n}`, email: `l${n}-${Date.now()}@x.com` })).lead;
const tasksOf = (leadId: string) => prisma.followUpTask.findMany({ where: { leadId }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }] });
const pending = async (leadId: string) => (await tasksOf(leadId)).filter((t) => ["SCHEDULED", "DUE"].includes(t.status));
const lead = (id: string) => prisma.lead.findUniqueOrThrow({ where: { id } });
const approx = (a: Date, b: number) => expect(Math.abs(a.getTime() - b)).toBeLessThan(5_000);

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("sequence on a new lead", () => {
  it("schedules the default 24h / 3d / 7d / 14d reminders and sets nextFollowUpAt", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    const tasks = await tasksOf(l.id);
    expect(tasks.map((t) => t.stepIndex)).toEqual([1, 2, 3, 4]);
    expect(tasks.every((t) => t.status === "SCHEDULED" && t.kind === "EMPLOYEE_REMINDER")).toBe(true);
    const created = l.createdAt.getTime();
    [1 * D, 3 * D, 7 * D, 14 * D].forEach((d, i) => approx(tasks[i]!.dueAt, created + d));
    approx((await lead(l.id)).nextFollowUpAt!, created + D);
    expect(tasks[0]!.title).toBe("First reminder (1 of 4)");
  });

  it("respects working hours", async () => {
    const { owner } = await setup();
    const day = [{ start: "09:00", end: "18:00" }];
    await prisma.organization.update({
      where: { id: owner.organizationId },
      data: { workingHours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: [], sun: [] } },
    });
    const l = await addLead(owner);
    for (const t of await tasksOf(l.id)) {
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(t.dueAt);
      const hour = Number(local.find((p) => p.type === "hour")!.value);
      const wd = local.find((p) => p.type === "weekday")!.value;
      expect(["Sat", "Sun"]).not.toContain(wd);
      expect(hour >= 9 && hour < 18).toBe(true);
    }
  });
});

describe("processing due reminders", () => {
  it("fires only when due, exactly once, and alerts the assignee", async () => {
    const { owner, priya } = await setup();
    const l = await addLead(owner);
    const [first] = await tasksOf(l.id);

    expect(await processDueTask(first!.id)).toBe("not_due");
    expect(await findDueTaskIds(new Date(Date.now() + 25 * H))).toEqual([first!.id]);

    const later = new Date(Date.now() + 25 * H);
    const results = await Promise.all([processDueTask(first!.id, later), processDueTask(first!.id, later)]);
    expect(results.sort()).toEqual(["already_handled", "due"]);

    const after = await lead(l.id);
    expect(after.status).toBe("FOLLOW_UP_DUE");
    expect(after.followUpStep).toBe(1);
    expect((await listNotifications(priya)).items.some((x) => x.type === "followUpDue" && x.leadId === l.id)).toBe(true);
    expect(await prisma.automationExecution.count({ where: { eventType: "followup.reminder_due", leadId: l.id } })).toBe(1);
  });

  it("a later reminder supersedes an unanswered earlier one", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    const [t1, t2] = await tasksOf(l.id);
    await processDueTask(t1!.id, new Date(Date.now() + 2 * D));
    await processDueTask(t2!.id, new Date(Date.now() + 4 * D));
    const tasks = await tasksOf(l.id);
    expect(tasks.find((t) => t.id === t1!.id)!.status).toBe("SKIPPED");
    expect(tasks.find((t) => t.id === t2!.id)!.status).toBe("DUE");
    expect((await lead(l.id)).followUpStep).toBe(2);
  });

  it("sends a single overdue notice for reminders left a day", async () => {
    const { owner, priya } = await setup();
    const l = await addLead(owner);
    const [t1] = await tasksOf(l.id);
    await prisma.followUpTask.update({ where: { id: t1!.id }, data: { dueAt: new Date(Date.now() - 2 * D) } });
    await processDueTask(t1!.id);
    expect(await notifyOverdueFollowUps()).toBe(1);
    expect(await notifyOverdueFollowUps()).toBe(0);
    expect((await listNotifications(priya)).items.filter((x) => x.type === "followUpOverdue")).toHaveLength(1);
  });
});

describe("employee contact recalculates", () => {
  it("before any reminder: restarts the full sequence from the contact", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    const before = Date.now();
    await logInteraction(owner, l.id, { channel: "PHONE" });
    const p = await pending(l.id);
    expect(p.map((t) => t.stepIndex)).toEqual([1, 2, 3, 4]);
    approx(p[0]!.dueAt, before + D);
    const cancelled = (await tasksOf(l.id)).filter((t) => t.status === "CANCELLED");
    expect(cancelled).toHaveLength(4);
  });

  it("after reminder 1: continues with step 2, re-timed from the contact (3d − 1d = 2d later)", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    const [t1] = await tasksOf(l.id);
    await processDueTask(t1!.id, new Date(Date.now() + 25 * H));
    const before = Date.now();
    await completeFollowUp(owner, t1!.id, { contacted: true, channel: "EMAIL", note: "Sent quote" });
    const p = await pending(l.id);
    expect(p.map((t) => t.stepIndex)).toEqual([2, 3, 4]);
    approx(p[0]!.dueAt, before + 2 * D);
    approx(p[1]!.dueAt, before + 6 * D);
    const after = await lead(l.id);
    expect(after.status).toBe("WAITING_FOR_CUSTOMER");
    expect(after.lastContactAt).not.toBeNull();
  });

  it("completing without contacting leaves the sequence as planned", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    const [t1, t2] = await tasksOf(l.id);
    await processDueTask(t1!.id, new Date(Date.now() + 25 * H));
    await completeFollowUp(owner, t1!.id, { contacted: false, note: "No answer" });
    const p = await pending(l.id);
    expect(p[0]!.id).toBe(t2!.id);
    await expect(completeFollowUp(owner, t1!.id, {})).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("stops scheduling once every step has been used", async () => {
    const { owner } = await setup();
    await updateFollowUpRules(owner, { steps: [{ name: "Only reminder", delayMinutes: 60 }] });
    const l = await addLead(owner);
    const [t1] = await tasksOf(l.id);
    await processDueTask(t1!.id, new Date(Date.now() + 2 * H));
    await completeFollowUp(owner, t1!.id, { contacted: true });
    expect(await pending(l.id)).toHaveLength(0);
    expect((await lead(l.id)).nextFollowUpAt).toBeNull();
    expect((await getLeadTimeline(owner, l.id)).some((e) => e.type === "FOLLOW_UPS_STOPPED")).toBe(true);
  });
});

describe("customer reply", () => {
  it("pauses the sequence, creates an immediate reminder and notifies; next contact restarts at step 1", async () => {
    const { owner, priya } = await setup();
    const l = await addLead(owner);
    const [t1] = await tasksOf(l.id);
    await processDueTask(t1!.id, new Date(Date.now() + 25 * H));
    await recordCustomerReply(owner, l.id, { channel: "PHONE", note: "Wants a call tomorrow" });

    const after = await lead(l.id);
    expect(after.lastCustomerReplyAt).not.toBeNull();
    expect(after.followUpStep).toBe(0);
    expect(after.status).toBe("FOLLOW_UP_DUE");
    const p = await pending(l.id);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ status: "DUE", title: "Customer replied — get back to them" });
    expect((await listNotifications(priya)).items[0]).toMatchObject({ type: "customerReplied", leadId: l.id });
    const types = (await getLeadTimeline(owner, l.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["CUSTOMER_REPLIED", "FOLLOW_UPS_PAUSED"]));

    await logInteraction(owner, l.id, { channel: "PHONE" });
    const tasks = await tasksOf(l.id);
    expect(tasks.find((t) => t.sequenceRunId.startsWith("reply_"))!.status).toBe("COMPLETED");
    expect((await pending(l.id)).map((t) => t.stepIndex)).toEqual([1, 2, 3, 4]);
  });

  it("a repeat inquiry merged into the lead counts as the customer getting in touch", async () => {
    const { owner } = await setup();
    const { lead: l } = await createLead(owner, { name: "R", email: "repeat@x.com" });
    await createLead(owner, { name: "R", email: "repeat@x.com", subject: "Any update?", onDuplicate: "merge" });
    const after = await lead(l.id);
    expect(after.lastCustomerReplyAt).not.toBeNull();
    expect((await pending(l.id)).map((t) => t.title)).toEqual(["Customer replied — get back to them"]);
  });
});

describe("stop and pause rules", () => {
  it("converting or losing a lead cancels everything, including manual follow-ups", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    await scheduleManualFollowUp(owner, l.id, { dueAt: new Date(Date.now() + 2 * H).toISOString(), title: "Call back" });
    await changeLeadStatus(owner, l.id, { status: "CONVERTED" });
    expect(await pending(l.id)).toHaveLength(0);
    expect((await lead(l.id)).nextFollowUpAt).toBeNull();
    expect((await getLeadTimeline(owner, l.id)).some((e) => e.type === "FOLLOW_UPS_STOPPED")).toBe(true);
  });

  it("a reminder firing for a lead closed meanwhile is cancelled, not sent", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    const [t1] = await tasksOf(l.id);
    // Simulate a race: the lead was closed but this task wasn't updated.
    await prisma.lead.update({ where: { id: l.id }, data: { status: "LOST" } });
    expect(await processDueTask(t1!.id, new Date(Date.now() + 25 * H))).toBe("cancelled");
  });

  it("on hold pauses; taking it off hold resumes from the next step and restores manual follow-ups", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    const [t1] = await tasksOf(l.id);
    await processDueTask(t1!.id, new Date(Date.now() + 25 * H));
    const manual = await scheduleManualFollowUp(owner, l.id, { dueAt: new Date(Date.now() + 5 * D).toISOString() });

    await changeLeadStatus(owner, l.id, { status: "ON_HOLD" });
    expect(await pending(l.id)).toHaveLength(0);
    expect((await prisma.followUpTask.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe("PAUSED");

    await changeLeadStatus(owner, l.id, { status: "QUALIFIED" });
    const p = await pending(l.id);
    expect(p.filter((t) => t.sequenceRunId.startsWith("seq_")).map((t) => t.stepIndex)).toEqual([2, 3, 4]);
    expect(p.some((t) => t.id === manual.id)).toBe(true);
  });

  it("reopening a lost lead starts a fresh sequence", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    await changeLeadStatus(owner, l.id, { status: "LOST" });
    await changeLeadStatus(owner, l.id, { status: "CONTACTED" });
    expect((await pending(l.id)).map((t) => t.stepIndex)).toEqual([1, 2, 3, 4]);
  });
});

describe("manual follow-ups", () => {
  it("schedules, reschedules and skips; past times are rejected", async () => {
    const { owner } = await setup();
    const l = await addLead(owner);
    await expect(scheduleManualFollowUp(owner, l.id, { dueAt: new Date(Date.now() - D).toISOString() })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const t = await scheduleManualFollowUp(owner, l.id, { dueAt: new Date(Date.now() + 2 * H).toISOString(), title: "Send brochure" });
    approx((await lead(l.id)).nextFollowUpAt!, Date.now() + 2 * H);
    const newTime = Date.now() + 3 * D;
    await rescheduleFollowUp(owner, t.id, { dueAt: new Date(newTime).toISOString() });
    approx((await prisma.followUpTask.findUniqueOrThrow({ where: { id: t.id } })).dueAt, newTime);
    await skipFollowUp(owner, t.id, "Not needed");
    expect((await prisma.followUpTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("SKIPPED");
  });

  it("other businesses and other salespeople can't touch the task", async () => {
    const { owner, priya } = await setup();
    const { lead: mine } = await createLead(owner, { name: "Owner's", email: "o@x.com", assignedMemberId: owner.memberId });
    const [t] = await tasksOf(mine.id);
    await expect(completeFollowUp(priya, t!.id, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    const reg = await registerOwner({ name: "B", email: "b@b.test", password: PASSWORD, businessName: "B", businessEmail: "b@b.test", timezone: "UTC" });
    const other = (await resolveOrgContext(reg.userId, reg.organizationId))!;
    await expect(skipFollowUp(other, t!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("rules", () => {
  it("validates ascending delays and applies custom, partly inactive steps to new leads", async () => {
    const { owner, priya } = await setup();
    await expect(
      updateFollowUpRules(owner, { steps: [{ name: "A", delayMinutes: 2 * 24 * 60 }, { name: "B", delayMinutes: 24 * 60 }] }),
    ).rejects.toThrow();
    await expect(updateFollowUpRules(priya, { steps: [{ name: "A", delayMinutes: 120 }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await updateFollowUpRules(owner, {
      steps: [
        { name: "Quick check", delayMinutes: 4 * 60 },
        { name: "Paused step", delayMinutes: 2 * 24 * 60, active: false },
        { name: "Final", delayMinutes: 5 * 24 * 60 },
      ],
    });
    const l = await addLead(owner);
    const tasks = await tasksOf(l.id);
    expect(tasks.map((t) => t.title)).toEqual(["Quick check (1 of 2)", "Final (2 of 2)"]);
    approx(tasks[0]!.dueAt, l.createdAt.getTime() + 4 * H);
  });
});

describe("follow-up center", () => {
  it("groups by due today / overdue / upcoming and lead states, scoped per salesperson", async () => {
    const { owner, priya } = await setup();
    const a = await addLead(owner); // Priya
    const b = await addLead(owner); // Priya
    const [ta] = await tasksOf(a.id);
    await prisma.followUpTask.update({ where: { id: ta!.id }, data: { dueAt: new Date(Date.now() - 3 * D) } });
    await processDueTask(ta!.id);
    await logInteraction(priya, b.id, { channel: "PHONE" }); // waiting for customer

    const center = await listFollowUpCenter(owner, "overdue");
    expect(center.summary.overdue).toBe(1);
    expect(center.tasks[0]!.lead.id).toBe(a.id);
    expect(center.summary.waiting).toBe(1);
    expect(center.summary.awaiting_employee).toBe(1); // a is FOLLOW_UP_DUE
    expect((await listFollowUpCenter(owner, "upcoming")).tasks.length).toBeGreaterThan(0);

    const { lead: ownersLead } = await createLead(owner, { name: "Mine", email: "mine@x.com", assignedMemberId: owner.memberId });
    const priyaView = await listFollowUpCenter(priya, "upcoming");
    expect(priyaView.tasks.every((t) => t.lead.id !== ownersLead.id)).toBe(true);
  });
});
