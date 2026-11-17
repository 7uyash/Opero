import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@lfm/db";
import { resetDatabase } from "@lfm/db/testing";
import {
  acceptInvitation,
  inviteMember,
  listAuditLogs,
  listMembers,
  listMyOrganizations,
  previewInvitation,
  registerOwner,
  resolveOrgContext,
  revokeInvitation,
  updateMember,
  updateMyMembership,
  updateOrganization,
  validateSession,
  type OrgContext,
} from "../src";

const PASSWORD = "longpassword1";

async function setupOrg(email = "owner@acme.test", businessName = "Acme") {
  const reg = await registerOwner({
    name: "Owner",
    email,
    password: PASSWORD,
    businessName,
    businessEmail: "hello@acme.test",
    timezone: "Asia/Kolkata",
  });
  const ctx = (await resolveOrgContext(reg.userId, reg.organizationId))!;
  return { reg, ctx };
}

/** Invite + accept, returning the new member's context. */
async function addMember(owner: OrgContext, email: string, role: "ADMIN" | "MANAGER" | "SALESPERSON") {
  const { token } = await inviteMember(owner, { email, role });
  const res = await acceptInvitation({ token, name: email.split("@")[0], password: PASSWORD });
  return (await resolveOrgContext(res.userId, res.organizationId))!;
}

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("invitations", () => {
  it("invites, previews and accepts a new user, who gets a session in the right org and role", async () => {
    const { ctx } = await setupOrg();
    const { token, invitation } = await inviteMember(ctx, { email: "Priya@Agency.test", name: "Priya", role: "SALESPERSON" });
    expect(invitation.email).toBe("priya@agency.test");

    // The raw token is never stored.
    const stored = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(stored.tokenHash).not.toContain(token);

    const preview = await previewInvitation(token);
    expect(preview).toMatchObject({ organizationName: "Acme", email: "priya@agency.test", role: "SALESPERSON", hasAccount: false });

    const res = await acceptInvitation({ token, name: "Priya", password: PASSWORD });
    const session = await validateSession(res.session.token);
    expect(session?.activeOrganizationId).toBe(ctx.organizationId);
    const member = await prisma.organizationMember.findUniqueOrThrow({ where: { id: res.memberId } });
    expect(member).toMatchObject({ role: "SALESPERSON", status: "ACTIVE" });
  });

  it("can only be used once, even with concurrent accepts", async () => {
    const { ctx } = await setupOrg();
    const { token } = await inviteMember(ctx, { email: "aman@agency.test", role: "SALESPERSON" });
    const results = await Promise.allSettled([
      acceptInvitation({ token, name: "Aman", password: PASSWORD }),
      acceptInvitation({ token, name: "Aman", password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.organizationMember.count({ where: { organizationId: ctx.organizationId } })).toBe(2);
    await expect(acceptInvitation({ token, name: "Aman", password: PASSWORD })).rejects.toMatchObject({ code: "INVITATION_USED" });
  });

  it("rejects expired and revoked invitations", async () => {
    const { ctx } = await setupOrg();
    const a = await inviteMember(ctx, { email: "a@agency.test", role: "SALESPERSON" });
    await prisma.invitation.update({ where: { id: a.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(previewInvitation(a.token)).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });

    const b = await inviteMember(ctx, { email: "b@agency.test", role: "SALESPERSON" });
    await revokeInvitation(ctx, b.invitation.id);
    await expect(acceptInvitation({ token: b.token, name: "B", password: PASSWORD })).rejects.toMatchObject({
      code: "INVITATION_INVALID",
    });
  });

  it("re-inviting the same email replaces the earlier invitation", async () => {
    const { ctx } = await setupOrg();
    const first = await inviteMember(ctx, { email: "x@agency.test", role: "SALESPERSON" });
    await inviteMember(ctx, { email: "x@agency.test", role: "MANAGER" });
    await expect(previewInvitation(first.token)).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    const { invitations } = await listMembers(ctx);
    expect(invitations).toHaveLength(1);
    expect(invitations[0]!.role).toBe("MANAGER");
  });

  it("an existing user joins a second business with their current password", async () => {
    const one = await setupOrg("owner1@a.test", "Business One");
    const two = await setupOrg("owner2@b.test", "Business Two");
    const { token } = await inviteMember(two.ctx, { email: "owner1@a.test", role: "MANAGER" });
    expect((await previewInvitation(token)).hasAccount).toBe(true);
    await expect(acceptInvitation({ token, password: "wrongpassword9" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await acceptInvitation({ token, password: PASSWORD });
    const orgs = await listMyOrganizations(one.reg.userId);
    expect(orgs.map((o) => o.name).sort()).toEqual(["Business One", "Business Two"]);
  });

  it("rejects inviting someone already on the team", async () => {
    const { ctx } = await setupOrg();
    await expect(inviteMember(ctx, { email: "owner@acme.test", role: "ADMIN" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("requires a strong password for new users", async () => {
    const { ctx } = await setupOrg();
    const { token } = await inviteMember(ctx, { email: "weak@agency.test", role: "SALESPERSON" });
    await expect(acceptInvitation({ token, name: "Weak", password: "123" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("role rules", () => {
  it("salespeople cannot invite or manage anyone", async () => {
    const { ctx } = await setupOrg();
    const sales = await addMember(ctx, "s@agency.test", "SALESPERSON");
    await expect(inviteMember(sales, { email: "z@agency.test", role: "SALESPERSON" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateMember(sales, ctx.memberId, { receivesLeads: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("managers can only invite and manage salespeople", async () => {
    const { ctx } = await setupOrg();
    const manager = await addMember(ctx, "m@agency.test", "MANAGER");
    const admin = await addMember(ctx, "a@agency.test", "ADMIN");
    const sales = await addMember(ctx, "s@agency.test", "SALESPERSON");

    await expect(inviteMember(manager, { email: "new@agency.test", role: "ADMIN" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await inviteMember(manager, { email: "new@agency.test", role: "SALESPERSON" });

    await updateMember(manager, sales.memberId, { isAvailable: false });
    await expect(updateMember(manager, sales.memberId, { role: "MANAGER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateMember(manager, admin.memberId, { status: "DISABLED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("nobody can change the owner's role/status or their own role/status", async () => {
    const { ctx } = await setupOrg();
    const admin = await addMember(ctx, "a@agency.test", "ADMIN");
    await expect(updateMember(admin, ctx.memberId, { status: "DISABLED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateMember(ctx, ctx.memberId, { status: "DISABLED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateMember(admin, admin.memberId, { role: "SALESPERSON" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // OWNER can't be granted.
    await expect(updateMember(ctx, admin.memberId, { role: "OWNER" as never })).rejects.toThrow();
  });

  it("owner can edit their own assignment settings", async () => {
    const { ctx } = await setupOrg();
    const m = await updateMember(ctx, ctx.memberId, { receivesLeads: false });
    expect(m.receivesLeads).toBe(false);
  });

  it("deactivating a member removes their access immediately; reactivating restores it", async () => {
    const { ctx } = await setupOrg();
    const sales = await addMember(ctx, "s@agency.test", "SALESPERSON");
    await updateMember(ctx, sales.memberId, { status: "DISABLED" });
    expect(await resolveOrgContext(sales.userId, ctx.organizationId)).toBeNull();
    await updateMember(ctx, sales.memberId, { status: "ACTIVE" });
    expect(await resolveOrgContext(sales.userId, ctx.organizationId)).not.toBeNull();
    const actions = (await listAuditLogs(ctx)).items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(["member.deactivated", "member.reactivated"]));
  });

  it("only managers and above can be fallback managers; demotion clears the flag", async () => {
    const { ctx } = await setupOrg();
    const sales = await addMember(ctx, "s@agency.test", "SALESPERSON");
    const manager = await addMember(ctx, "m@agency.test", "MANAGER");
    await expect(updateMember(ctx, sales.memberId, { isFallbackManager: true })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await updateMember(ctx, manager.memberId, { isFallbackManager: true });
    const demoted = await updateMember(ctx, manager.memberId, { role: "SALESPERSON" });
    expect(demoted.isFallbackManager).toBe(false);
  });

  it("any member can set their own availability and notification preferences", async () => {
    const { ctx } = await setupOrg();
    const sales = await addMember(ctx, "s@agency.test", "SALESPERSON");
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const m = await updateMyMembership(sales, {
      isAvailable: false,
      unavailableUntil: until,
      notificationPrefs: { followUpDue: { inApp: true, email: true } },
    });
    expect(m.isAvailable).toBe(false);
    expect(m.unavailableUntil?.toISOString()).toBe(until);
    expect((m.notificationPrefs as Record<string, unknown>).followUpDue).toEqual({ inApp: true, email: true });
    // Defaults are kept for untouched events.
    expect((m.notificationPrefs as Record<string, unknown>).leadAssigned).toEqual({ inApp: true, email: true });
  });
});

describe("tenant isolation", () => {
  it("members and invitations of another business are invisible and untouchable", async () => {
    const a = await setupOrg("a@a.test", "A");
    const b = await setupOrg("b@b.test", "B");
    const bSales = await addMember(b.ctx, "s@b.test", "SALESPERSON");
    const bInvite = await inviteMember(b.ctx, { email: "x@b.test", role: "SALESPERSON" });

    const listA = await listMembers(a.ctx);
    expect(listA.members.map((m) => m.email)).toEqual(["a@a.test"]);
    expect(listA.invitations).toHaveLength(0);

    await expect(updateMember(a.ctx, bSales.memberId, { status: "DISABLED" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(revokeInvitation(a.ctx, bInvite.invitation.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listAuditLogs(a.ctx)).items.every((i) => i.organizationId === a.ctx.organizationId)).toBe(true);
  });
});

describe("organization settings", () => {
  it("owner updates details, working hours and holidays", async () => {
    const { ctx } = await setupOrg();
    const day = [{ start: "10:00", end: "13:00" }, { start: "14:00", end: "19:00" }];
    const org = await updateOrganization(ctx, {
      name: "Acme Digital",
      website: "https://acme.test",
      defaultCountry: "us",
      workingHours: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: [], sun: [] },
      holidays: [{ date: "2026-12-25", name: "Christmas" }, { date: "2026-01-26" }],
    });
    expect(org.name).toBe("Acme Digital");
    expect(org.defaultCountry).toBe("US");
    expect((org.holidays as { date: string }[]).map((h) => h.date)).toEqual(["2026-01-26", "2026-12-25"]);
  });

  it("rejects overlapping or inverted hours and duplicate holidays", async () => {
    const { ctx } = await setupOrg();
    const closed = { tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    await expect(
      updateOrganization(ctx, { workingHours: { mon: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }], ...closed } }),
    ).rejects.toThrow();
    await expect(updateOrganization(ctx, { workingHours: { mon: [{ start: "18:00", end: "09:00" }], ...closed } })).rejects.toThrow();
    await expect(updateOrganization(ctx, { holidays: [{ date: "2026-12-25" }, { date: "2026-12-25" }] })).rejects.toThrow();
  });

  it("only the owner can change business settings", async () => {
    const { ctx } = await setupOrg();
    const admin = await addMember(ctx, "a@agency.test", "ADMIN");
    await expect(updateOrganization(admin, { name: "Hacked" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
