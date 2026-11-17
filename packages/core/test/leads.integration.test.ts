import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@lfm/db";
import { resetDatabase } from "@lfm/db/testing";
import {
  acceptInvitation,
  addLeadNote,
  assignLeadManually,
  changeLeadStatus,
  createLead,
  getDashboardOverview,
  getLeadDetail,
  getLeadTimeline,
  inviteMember,
  listLeads,
  logInteraction,
  registerOwner,
  resolveOrgContext,
  updateLead,
  type OrgContext,
} from "../src";

const PASSWORD = "longpassword1";

async function setupOrg(email = "owner@acme.test", name = "Acme") {
  const reg = await registerOwner({ name: "Owner", email, password: PASSWORD, businessName: name, businessEmail: email, timezone: "Asia/Kolkata" });
  return (await resolveOrgContext(reg.userId, reg.organizationId))!;
}

async function addMember(owner: OrgContext, email: string, role: "MANAGER" | "SALESPERSON") {
  const { token } = await inviteMember(owner, { email, role });
  const res = await acceptInvitation({ token, name: email.split("@")[0], password: PASSWORD });
  return (await resolveOrgContext(res.userId, res.organizationId))!;
}

const rahul = { name: "Rahul Sharma", email: "rahul@example.com", phone: "+91 98765 43210", subject: "Website Development" };

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("manual lead creation", () => {
  it("normalizes contact data, records the source and a LEAD_CREATED activity", async () => {
    const owner = await setupOrg();
    const { lead, outcome } = await createLead(owner, { ...rahul, email: "  Rahul@Example.com " });
    expect(outcome).toBe("created");
    // No assignee chosen → round-robin; the owner is the only member so they get it.
    expect(lead).toMatchObject({ email: "rahul@example.com", phoneE164: "+919876543210", sourceType: "MANUAL", status: "ASSIGNED" });
    const timeline = await getLeadTimeline(owner, lead.id);
    expect(timeline.map((t) => t.type).reverse()).toEqual(["LEAD_CREATED", "ASSIGNED", "FOLLOW_UP_SCHEDULED"]);
  });

  it("assigns to the chosen member and records history", async () => {
    const owner = await setupOrg();
    const sales = await addMember(owner, "priya@acme.test", "SALESPERSON");
    const { lead } = await createLead(owner, { ...rahul, assignedMemberId: sales.memberId });
    expect(lead).toMatchObject({ assignedMemberId: sales.memberId, status: "ASSIGNED" });
    const history = await prisma.assignment.findMany({ where: { leadId: lead.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ memberId: sales.memberId, method: "MANUAL" });
  });

  it("a salesperson's own lead is assigned to them and they cannot assign to others", async () => {
    const owner = await setupOrg();
    const sales = await addMember(owner, "priya@acme.test", "SALESPERSON");
    const { lead } = await createLead(sales, rahul);
    expect(lead.assignedMemberId).toBe(sales.memberId);
    await expect(createLead(sales, { ...rahul, email: "x@y.com", phone: undefined, assignedMemberId: owner.memberId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses to assign to a deactivated or foreign member", async () => {
    const owner = await setupOrg();
    const other = await setupOrg("o@other.test", "Other");
    await expect(createLead(owner, { ...rahul, assignedMemberId: other.memberId })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("duplicate detection", () => {
  it("asks first, matching on normalized email or phone across formats", async () => {
    const owner = await setupOrg();
    await createLead(owner, rahul);
    // Same phone in a local format, different email.
    const err = await createLead(owner, { name: "R. Sharma", email: "other@example.com", phone: "09876543210" }).catch((e) => e);
    expect(err.code).toBe("DUPLICATE_FOUND");
    expect(err.details.duplicate.matchedOn).toEqual(["phone"]);
  });

  it("merge adds the inquiry to the existing lead and fills missing fields", async () => {
    const owner = await setupOrg();
    const { lead: first } = await createLead(owner, { name: "Rahul", email: "rahul@example.com" });
    const { lead, outcome } = await createLead(owner, {
      name: "Rahul S",
      email: "RAHUL@example.com",
      phone: "9876543210",
      subject: "SEO",
      onDuplicate: "merge",
    });
    expect(outcome).toBe("merged");
    expect(lead.id).toBe(first.id);
    expect(lead.phoneE164).toBe("+919876543210");
    expect(await prisma.lead.count()).toBe(1);
    const types = (await getLeadTimeline(owner, first.id)).map((t) => t.type);
    expect(types).toContain("DUPLICATE_MERGED");
  });

  it("create keeps a separate lead flagged as a possible duplicate", async () => {
    const owner = await setupOrg();
    const { lead: first } = await createLead(owner, rahul);
    const { lead, outcome } = await createLead(owner, { ...rahul, onDuplicate: "create" });
    expect(outcome).toBe("flagged_duplicate");
    expect(lead.duplicateOfId).toBe(first.id);
  });

  it("ignores closed leads and other businesses", async () => {
    const owner = await setupOrg();
    const other = await setupOrg("o@other.test", "Other");
    await createLead(other, rahul);
    const { lead } = await createLead(owner, rahul);
    await changeLeadStatus(owner, lead.id, { status: "LOST" });
    const again = await createLead(owner, rahul);
    expect(again.outcome).toBe("created");
  });
});

describe("status, notes, interactions", () => {
  it("converts and reopens with timeline entries; rejects invalid transitions", async () => {
    const owner = await setupOrg();
    const { lead } = await createLead(owner, rahul);
    const converted = await changeLeadStatus(owner, lead.id, { status: "CONVERTED" });
    expect(converted.convertedAt).not.toBeNull();
    await expect(changeLeadStatus(owner, lead.id, { status: "LOST" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const reopened = await changeLeadStatus(owner, lead.id, { status: "QUALIFIED" });
    expect(reopened.convertedAt).toBeNull();
    const lost = await changeLeadStatus(owner, lead.id, { status: "LOST", reason: "Budget" });
    expect(lost.lostReason).toBe("Budget");
    const types = (await getLeadTimeline(owner, lead.id)).map((t) => t.type);
    expect(types).toEqual(expect.arrayContaining(["CONVERTED", "STATUS_CHANGED", "LOST"]));
  });

  it("logging contact moves the lead forward and stamps lastContactAt", async () => {
    const owner = await setupOrg();
    const { lead } = await createLead(owner, rahul);
    const after = await logInteraction(owner, lead.id, { channel: "PHONE", note: "Sent quotation" });
    expect(after.status).toBe("WAITING_FOR_CUSTOMER");
    expect(after.lastContactAt).not.toBeNull();
    expect(after.lastCustomerReplyAt).toBeNull(); // contacting ≠ customer replying
    const after2 = await logInteraction(owner, lead.id, { channel: "EMAIL", awaitingCustomer: false });
    expect(after2.status).toBe("CONTACTED");
    await expect(
      logInteraction(owner, lead.id, { channel: "PHONE", occurredAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("updates contact details and refuses removing both email and phone", async () => {
    const owner = await setupOrg();
    const { lead } = await createLead(owner, rahul);
    const updated = await updateLead(owner, lead.id, { phone: "", company: "Sharma & Co" });
    expect(updated.phone).toBeNull();
    expect(updated.company).toBe("Sharma & Co");
    await expect(updateLead(owner, lead.id, { email: "" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("notes appear on the timeline with the author's name", async () => {
    const owner = await setupOrg();
    const { lead } = await createLead(owner, rahul);
    await addLeadNote(owner, lead.id, { body: "Prefers WhatsApp" });
    const [latest] = await getLeadTimeline(owner, lead.id);
    expect(latest).toMatchObject({ type: "NOTE_ADDED", actorName: "Owner", payload: { body: "Prefers WhatsApp" } });
  });
});

describe("access control", () => {
  it("salespeople see and act only on their assigned leads", async () => {
    const owner = await setupOrg();
    const priya = await addMember(owner, "priya@acme.test", "SALESPERSON");
    const aman = await addMember(owner, "aman@acme.test", "SALESPERSON");
    const { lead: mine } = await createLead(owner, { ...rahul, assignedMemberId: priya.memberId });
    const { lead: theirs } = await createLead(owner, { name: "Other", email: "o@x.com", assignedMemberId: aman.memberId });

    expect((await listLeads(priya, {})).items.map((l) => l.id)).toEqual([mine.id]);
    await expect(getLeadDetail(priya, theirs.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(changeLeadStatus(priya, theirs.id, { status: "LOST" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assignLeadManually(priya, mine.id, { memberId: aman.memberId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The assignee filter can't be used to peek at others.
    expect((await listLeads(priya, { assignee: aman.memberId })).items.map((l) => l.id)).toEqual([mine.id]);
  });

  it("another business's leads are invisible", async () => {
    const a = await setupOrg();
    const b = await setupOrg("b@b.test", "B");
    const { lead } = await createLead(b, rahul);
    expect((await listLeads(a, { includeClosed: true })).total).toBe(0);
    await expect(getLeadDetail(a, lead.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addLeadNote(a, lead.id, { body: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("manual reassignment and unassignment are recorded", async () => {
    const owner = await setupOrg();
    const priya = await addMember(owner, "priya@acme.test", "SALESPERSON");
    const { lead } = await createLead(owner, { ...rahul, assignedMemberId: null });
    const a = await assignLeadManually(owner, lead.id, { memberId: priya.memberId });
    expect(a.status).toBe("ASSIGNED");
    const u = await assignLeadManually(owner, lead.id, { memberId: null, reason: "Priya on leave" });
    expect(u).toMatchObject({ assignedMemberId: null, status: "NEW" });
    expect(await prisma.assignment.count({ where: { leadId: lead.id } })).toBe(2);
  });
});

describe("listing", () => {
  it("searches, filters, sorts and paginates", async () => {
    const owner = await setupOrg();
    const priya = await addMember(owner, "priya@acme.test", "SALESPERSON");
    await createLead(owner, { ...rahul, assignedMemberId: null });
    await createLead(owner, { name: "Anita Desai", email: "anita@desai.in", priority: "HIGH", assignedMemberId: priya.memberId });
    const { lead: lost } = await createLead(owner, { name: "Zed", email: "zed@z.com", assignedMemberId: null });
    await changeLeadStatus(owner, lost.id, { status: "LOST" });

    expect((await listLeads(owner, {})).total).toBe(2); // closed hidden by default
    expect((await listLeads(owner, { includeClosed: true })).total).toBe(3);
    expect((await listLeads(owner, { q: "anita" })).items[0]!.name).toBe("Anita Desai");
    expect((await listLeads(owner, { q: "43210" })).items[0]!.name).toBe("Rahul Sharma"); // phone digits
    expect((await listLeads(owner, { assignee: "unassigned" })).items.map((l) => l.name)).toEqual(["Rahul Sharma"]);
    expect((await listLeads(owner, { priority: ["HIGH"] })).total).toBe(1);
    expect((await listLeads(owner, { status: ["LOST"] })).total).toBe(1);
    const sorted = await listLeads(owner, { sort: "name", dir: "asc", includeClosed: true });
    expect(sorted.items.map((l) => l.name)).toEqual(["Anita Desai", "Rahul Sharma", "Zed"]);
    const page2 = await listLeads(owner, { sort: "name", dir: "asc", includeClosed: true, pageSize: 5, page: 1 });
    expect(page2.pageCount).toBe(1);
  });
});

describe("dashboard", () => {
  it("counts totals, conversions and team performance", async () => {
    const owner = await setupOrg();
    const priya = await addMember(owner, "priya@acme.test", "SALESPERSON");
    const { lead: a } = await createLead(owner, { name: "A", email: "a@a.com", assignedMemberId: priya.memberId });
    const { lead: b } = await createLead(owner, { name: "B", email: "b@b.com", assignedMemberId: priya.memberId });
    await createLead(owner, { name: "C", email: "c@c.com", assignedMemberId: null });
    await changeLeadStatus(owner, a.id, { status: "CONVERTED" });
    await changeLeadStatus(owner, b.id, { status: "LOST" });
    await prisma.lead.updateMany({ where: { name: "C" }, data: { nextFollowUpAt: new Date(Date.now() - 2 * 86_400_000) } }); // before today = overdue

    const { stats, team } = await getDashboardOverview(owner);
    expect(stats).toMatchObject({ total: 3, newToday: 3, converted: 1, lost: 1, unassigned: 1, overdueFollowUps: 1, conversionRate: 0.5 });
    const p = team!.find((m) => m.memberId === priya.memberId)!;
    expect(p).toMatchObject({ assigned: 2, converted: 1, lost: 1, open: 0, conversionRate: 0.5 });

    const mine = await getDashboardOverview(priya);
    expect(mine.stats.total).toBe(2);
    expect(mine.team).toBeNull();
  });
});
