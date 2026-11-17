import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@lfm/db";
import {
  AppError,
  login,
  registerOwner,
  resolveOrgContext,
  revokeSession,
  validateSession,
} from "../src";
import { resetDatabase } from "@lfm/db/testing";

const input = {
  name: "Priya Sharma",
  email: "priya@agency.com",
  password: "longpassword1",
  businessName: "Acme Agency",
  businessEmail: "hello@acme.com",
  timezone: "Asia/Kolkata",
};

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("registration", () => {
  it("creates user, organization, owner membership, cursor and manual source atomically", async () => {
    const res = await registerOwner(input, { ip: "127.0.0.1" });

    const member = await prisma.organizationMember.findFirstOrThrow({ where: { organizationId: res.organizationId } });
    expect(member.role).toBe("OWNER");
    expect(member.status).toBe("ACTIVE");
    expect(await prisma.assignmentCursor.count({ where: { organizationId: res.organizationId } })).toBe(1);
    expect(await prisma.leadSource.count({ where: { organizationId: res.organizationId, type: "MANUAL" } })).toBe(1);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: res.organizationId } });
    expect(org.timezone).toBe("Asia/Kolkata");

    const user = await prisma.user.findUniqueOrThrow({ where: { email: input.email } });
    expect(user.passwordHash).not.toBe(input.password);
    expect(await prisma.auditLog.count({ where: { action: "organization.created" } })).toBe(1);
  });

  it("rejects a duplicate email (case-insensitive) without leaving partial data", async () => {
    await registerOwner(input);
    await expect(registerOwner({ ...input, email: "PRIYA@agency.com", businessName: "Other" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await prisma.organization.count()).toBe(1);
  });
});

describe("sessions", () => {
  it("stores only a hash of the session token", async () => {
    const res = await registerOwner(input);
    const stored = await prisma.session.findFirstOrThrow();
    expect(stored.tokenHash).not.toBe(res.session.token);
    expect(stored.tokenHash).not.toContain(res.session.token);
  });

  it("validates, then rejects after revocation", async () => {
    const { session } = await registerOwner(input);
    const valid = await validateSession(session.token);
    expect(valid?.user.email).toBe(input.email);
    await revokeSession(session.token);
    expect(await validateSession(session.token)).toBeNull();
  });

  it("rejects unknown and expired tokens", async () => {
    const { session } = await registerOwner(input);
    expect(await validateSession("not-a-real-token")).toBeNull();
    expect(await validateSession("")).toBeNull();
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateSession(session.token)).toBeNull();
    expect(await prisma.session.count()).toBe(0);
  });
});

describe("login", () => {
  it("succeeds with correct credentials and opens a session on the organization", async () => {
    const reg = await registerOwner(input);
    const res = await login({ email: "Priya@Agency.com", password: input.password });
    expect(res.organizationId).toBe(reg.organizationId);
    expect(await validateSession(res.session.token)).not.toBeNull();
  });

  it("gives the same error for wrong password and unknown email", async () => {
    await registerOwner(input);
    const a = await login({ email: input.email, password: "wrongpassword1" }).catch((e) => e);
    const b = await login({ email: "nobody@x.com", password: "wrongpassword1" }).catch((e) => e);
    expect(a).toBeInstanceOf(AppError);
    expect(b).toBeInstanceOf(AppError);
    expect(a.message).toBe(b.message);
    expect(a.code).toBe("INVALID_CREDENTIALS");
    expect(await prisma.auditLog.count({ where: { action: "auth.login_failed" } })).toBe(2);
  });
});

describe("organization context (tenant isolation)", () => {
  it("resolves the member's own org and refuses another org", async () => {
    const a = await registerOwner(input);
    const b = await registerOwner({ ...input, email: "aman@other.com", businessName: "Other Co" });

    const ctx = await resolveOrgContext(a.userId, a.organizationId);
    expect(ctx).toMatchObject({ organizationId: a.organizationId, role: "OWNER" });

    // User A asking for org B's context gets nothing.
    expect(await resolveOrgContext(a.userId, b.organizationId)).toBeNull();
  });

  it("refuses disabled members", async () => {
    const a = await registerOwner(input);
    await prisma.organizationMember.updateMany({ data: { status: "DISABLED" } });
    expect(await resolveOrgContext(a.userId, a.organizationId)).toBeNull();
  });
});
