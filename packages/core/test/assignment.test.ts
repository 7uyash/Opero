import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@lfm/db";
import { resetDatabase } from "@lfm/db/testing";
import {
  acceptInvitation,
  assignLeadManually,
  createLead,
  getLeadAutomationSettings,
  inviteMember,
  isAvailableNow,
  listNotifications,
  markNotificationsRead,
  pickNext,
  previewRotation,
  redistributeMemberLeads,
  registerOwner,
  resolveOrgContext,
  updateAssignmentSettings,
  updateMember,
  updateMyMembership,
  type OrgContext,
} from "../src";

const PASSWORD = "longpassword1";

// ───────────────────────── Pure selection ─────────────────────────

describe("pickNext", () => {
  const t = (n: number) => new Date(2026, 0, n);
  const ring = [
    { id: "a", createdAt: t(1) },
    { id: "b", createdAt: t(2) },
    { id: "c", createdAt: t(3) },
  ];
  const all = () => true;

  it("starts at the beginning and rotates in order, wrapping around", () => {
    expect(pickNext(ring, null, all)?.id).toBe("a");
    expect(pickNext(ring, ring[0]!, all)?.id).toBe("b");
    expect(pickNext(ring, ring[2]!, all)?.id).toBe("a");
  });

  it("skips ineligible members but keeps their place", () => {
    expect(pickNext(ring, ring[0]!, (m) => m.id !== "b")?.id).toBe("c");
  });

  it("continues after a member who left the ring", () => {
    const departed = { id: "x", createdAt: new Date(2026, 0, 2, 12) }; // sat between b and c
    expect(pickNext(ring, departed, all)?.id).toBe("c");
    const lastInRing = { id: "z", createdAt: t(9) };
    expect(pickNext(ring, lastInRing, all)?.id).toBe("a");
  });

  it("returns null when nobody is eligible", () => {
    expect(pickNext(ring, null, () => false)).toBeNull();
    expect(pickNext([], null, all)).toBeNull();
  });
});

describe("isAvailableNow", () => {
  const past = new Date(Date.now() - 1000);
  const future = new Date(Date.now() + 86_400_000);
  it("treats an expired 'away until' as back", () => {
    expect(isAvailableNow({ isAvailable: false, unavailableUntil: past })).toBe(true);
    expect(isAvailableNow({ isAvailable: false, unavailableUntil: future })).toBe(false);
    expect(isAvailableNow({ isAvailable: false, unavailableUntil: null })).toBe(false);
    expect(isAvailableNow({ isAvailable: true, unavailableUntil: null })).toBe(true);
  });
});

// ───────────────────────── Integration ─────────────────────────

async function setup() {
  const reg = await registerOwner({
    name: "Owner",
    email: "owner@acme.test",
    password: PASSWORD,
    businessName: "Acme",
    businessEmail: "owner@acme.test",
    timezone: "Asia/Kolkata",
  });
  const owner = (await resolveOrgContext(reg.userId, reg.organizationId))!;
  // Owner sits out of the rotation so the three salespeople share leads (like the spec's example).
  await updateMember(owner, owner.memberId, { receivesLeads: false });
  const add = async (name: string, role: "SALESPERSON" | "MANAGER" = "SALESPERSON") => {
    const { token } = await inviteMember(owner, { email: `${name.toLowerCase()}@acme.test`, role });
    const res = await acceptInvitation({ token, name, password: PASSWORD });
    return (await resolveOrgContext(res.userId, res.organizationId))!;
  };
  const priya = await add("Priya");
  const aman = await add("Aman");
  const rahul = await add("Rahul");
  return { owner, priya, aman, rahul, add };
}

let n = 0;
const newLead = (ctx: OrgContext) => createLead(ctx, { name: `Lead ${++n}`, email: `lead${n}-${Date.now()}@x.com` });

async function assigneeNames(leadIds: string[]) {
  const leads = await prisma.lead.findMany({
    where: { id: { in: leadIds } },
    include: { assignedMember: { include: { user: true } } },
  });
  const byId = new Map(leads.map((l) => [l.id, l.assignedMember?.user.name ?? null]));
  return leadIds.map((id) => byId.get(id));
}

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("round-robin assignment", () => {
  it("distributes Priya → Aman → Rahul → Priya → Aman", async () => {
    const { owner } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await newLead(owner)).lead.id);
    expect(await assigneeNames(ids)).toEqual(["Priya", "Aman", "Rahul", "Priya", "Aman"]);
    const history = await prisma.assignment.findMany({ where: { leadId: { in: ids } } });
    expect(history.every((h) => h.method === "ROUND_ROBIN")).toBe(true);
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(lead.status).toBe("ASSIGNED");
  });

  it("is atomic: 30 simultaneous leads get distinct consecutive slots", async () => {
    const { owner, priya, aman, rahul } = await setup();
    const results = await Promise.all(Array.from({ length: 30 }, () => newLead(owner)));
    const counts = new Map<string, number>();
    for (const r of results) counts.set(r.lead.assignedMemberId!, (counts.get(r.lead.assignedMemberId!) ?? 0) + 1);
    expect(counts.get(priya.memberId)).toBe(10);
    expect(counts.get(aman.memberId)).toBe(10);
    expect(counts.get(rahul.memberId)).toBe(10);

    // Ordered by when each assignment committed, the sequence must strictly rotate.
    const history = await prisma.assignment.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const order = [priya.memberId, aman.memberId, rahul.memberId];
    history.forEach((h, i) => expect(h.memberId).toBe(order[i % 3]));
  });

  it("skips members who are away, deactivated or not receiving leads", async () => {
    const { owner, priya, aman, rahul } = await setup();
    await updateMyMembership(aman, { isAvailable: false });
    const ids = [(await newLead(owner)).lead.id, (await newLead(owner)).lead.id, (await newLead(owner)).lead.id];
    expect(await assigneeNames(ids)).toEqual(["Priya", "Rahul", "Priya"]);

    await updateMember(owner, rahul.memberId, { receivesLeads: false });
    expect(await assigneeNames([(await newLead(owner)).lead.id])).toEqual(["Priya"]);
    // Aman comes back automatically once "away until" passes.
    await updateMyMembership(aman, { isAvailable: false, unavailableUntil: new Date(Date.now() - 1000).toISOString() });
    expect(await assigneeNames([(await newLead(owner)).lead.id])).toEqual(["Aman"]);
    void priya;
  });

  it("falls back to the fallback manager, then to the unassigned queue with notifications", async () => {
    const { owner, priya, aman, rahul, add } = await setup();
    for (const m of [priya, aman, rahul]) await updateMyMembership(m, { isAvailable: false });
    const manager = await add("Meera", "MANAGER");
    await updateMember(owner, manager.memberId, { receivesLeads: false, isFallbackManager: true });
    // The owner is a fallback manager from registration; make them unavailable so Meera is chosen.
    await updateMember(owner, owner.memberId, { isAvailable: false });

    const a = await newLead(owner);
    expect(a.lead.assignedMemberId).toBe(manager.memberId);
    expect((await prisma.assignment.findFirstOrThrow({ where: { leadId: a.lead.id } })).method).toBe("FALLBACK");
    expect((await listNotifications(manager)).items[0]).toMatchObject({ type: "leadAssigned", leadId: a.lead.id });

    await updateMyMembership(manager, { isAvailable: false });
    const b = await newLead(owner);
    expect(b.lead.assignedMemberId).toBeNull();
    expect(b.lead.status).toBe("NEW");
    const ownerNotes = await listNotifications(owner);
    expect(ownerNotes.items.some((x) => x.type === "unassignedLead" && x.leadId === b.lead.id)).toBe(true);
  });

  it("fallback can be switched off, and manual mode leaves every lead unassigned", async () => {
    const { owner, priya, aman, rahul } = await setup();
    await updateAssignmentSettings(owner, { useFallbackManager: false });
    for (const m of [priya, aman, rahul]) await updateMyMembership(m, { isAvailable: false });
    expect((await newLead(owner)).lead.assignedMemberId).toBeNull();

    for (const m of [priya, aman, rahul]) await updateMyMembership(m, { isAvailable: true });
    await updateAssignmentSettings(owner, { mode: "MANUAL" });
    expect((await newLead(owner)).lead.assignedMemberId).toBeNull();
    expect((await getLeadAutomationSettings(owner.organizationId)).assignment.mode).toBe("MANUAL");
  });

  it("an explicit choice or 'unassigned' overrides the rotation and doesn't move the cursor", async () => {
    const { owner } = await setup();
    const first = await newLead(owner); // Priya
    const { lead: manual } = await createLead(owner, { name: "M", email: "m@x.com", assignedMemberId: null });
    expect(manual.assignedMemberId).toBeNull();
    const next = await newLead(owner);
    expect(await assigneeNames([first.lead.id, next.lead.id])).toEqual(["Priya", "Aman"]);
  });

  it("duplicates merged into an existing lead don't take a rotation slot", async () => {
    const { owner } = await setup();
    const { lead } = await createLead(owner, { name: "R", email: "same@x.com" });
    await createLead(owner, { name: "R", email: "same@x.com", onDuplicate: "merge" });
    const next = await newLead(owner);
    expect(await assigneeNames([lead.id, next.lead.id])).toEqual(["Priya", "Aman"]);
  });

  it("previews the rotation and who is next", async () => {
    const { owner, aman } = await setup();
    await newLead(owner); // Priya
    await updateMyMembership(aman, { isAvailable: false });
    const p = await previewRotation(owner.organizationId);
    expect(p.ring.map((r) => r.name)).toEqual(["Priya", "Aman", "Rahul"]);
    expect(p.ring.find((r) => r.isNext)?.name).toBe("Rahul");
    expect(p.ring.find((r) => r.name === "Aman")?.available).toBe(false);
  });
});

describe("redistribution", () => {
  it("deactivating a member shares their open leads with the rest of the rotation", async () => {
    const { owner, priya } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await newLead(owner)).lead.id); // Priya gets #1 and #4
    const priyaLeads = ids.filter((_, i) => i % 3 === 0);

    const res = await updateMember(owner, priya.memberId, { status: "DISABLED" });
    expect(res.redistributed).toEqual({ reassigned: 2, unassigned: 0 });
    const names = await assigneeNames(priyaLeads);
    expect(names.every((n) => n === "Aman" || n === "Rahul")).toBe(true);
    const reassignments = await prisma.assignment.findMany({ where: { leadId: { in: priyaLeads }, previousMemberId: priya.memberId } });
    expect(reassignments).toHaveLength(2);
  });

  it("closed leads stay with their owner; with nobody available leads go to the queue", async () => {
    const { owner, priya, aman, rahul } = await setup();
    const a = await newLead(owner); // Priya
    await prisma.lead.update({ where: { id: a.lead.id }, data: { status: "CONVERTED" } });
    const b = await createLead(owner, { name: "B", email: "b@x.com", assignedMemberId: priya.memberId });
    await updateAssignmentSettings(owner, { useFallbackManager: false });
    for (const m of [aman, rahul]) await updateMyMembership(m, { isAvailable: false });

    const res = await redistributeMemberLeads(owner, priya.memberId);
    expect(res).toEqual({ reassigned: 0, unassigned: 1 });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: a.lead.id } })).assignedMemberId).toBe(priya.memberId);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: b.lead.id } })).assignedMemberId).toBeNull();
  });

  it("only managers and above can redistribute", async () => {
    const { priya, aman } = await setup();
    await expect(redistributeMemberLeads(priya, aman.memberId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("notifications", () => {
  it("respects in-app preferences and can be marked read", async () => {
    const { owner, priya, aman } = await setup();
    await updateMyMembership(aman, { notificationPrefs: { leadAssigned: { inApp: false, email: false } } });
    await newLead(owner); // Priya
    await newLead(owner); // Aman (muted)
    expect((await listNotifications(priya)).unread).toBe(1);
    expect((await listNotifications(aman)).unread).toBe(0);
    expect(await markNotificationsRead(priya)).toBe(1);
    expect((await listNotifications(priya)).unread).toBe(0);
  });

  it("manual reassignment still records history", async () => {
    const { owner, aman } = await setup();
    const { lead } = await newLead(owner);
    await assignLeadManually(owner, lead.id, { memberId: aman.memberId, reason: "Speaks Hindi" });
    const h = await prisma.assignment.findMany({ where: { leadId: lead.id }, orderBy: { createdAt: "asc" } });
    expect(h.map((x) => x.method)).toEqual(["ROUND_ROBIN", "MANUAL"]);
  });
});
