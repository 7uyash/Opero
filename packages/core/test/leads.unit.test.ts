import { describe, expect, it } from "vitest";
import { allowedNextStatuses, createLeadSchema, listLeadsQuerySchema } from "@lfm/shared";
import { normalizeContact, normalizeEmail, normalizePhone } from "../src";

describe("normalizeEmail", () => {
  it("lower-cases and trims", () => {
    expect(normalizeEmail("  Rahul@Example.COM ")).toBe("rahul@example.com");
  });
  it("collapses Gmail dots and +tags so the same mailbox matches", () => {
    expect(normalizeEmail("Rahul.Sharma+leads@gmail.com")).toBe("rahulsharma@gmail.com");
    expect(normalizeEmail("rahulsharma@googlemail.com")).toBe("rahulsharma@gmail.com");
  });
  it("keeps +tags for other providers", () => {
    expect(normalizeEmail("a+b@company.com")).toBe("a+b@company.com");
  });
  it("returns null for empty or invalid input", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("nope")).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("parses local numbers with the default country", () => {
    expect(normalizePhone("98765 43210", "IN")).toMatchObject({ ok: true, e164: "+919876543210" });
    expect(normalizePhone("(415) 555-2671", "US")).toMatchObject({ ok: true, e164: "+14155552671" });
  });
  it("keeps international numbers regardless of default country", () => {
    expect(normalizePhone("+44 20 7946 0958", "IN")).toMatchObject({ ok: true, e164: "+442079460958" });
    expect(normalizePhone("0044 20 7946 0958", "IN")).toMatchObject({ ok: true, e164: "+442079460958" });
  });
  it("treats different formats of the same number as equal", () => {
    const a = normalizePhone("+91 98765-43210", "US");
    const b = normalizePhone("09876543210", "IN");
    expect(a.ok && b.ok && a.e164 === b.e164).toBe(true);
  });
  it("rejects invalid numbers", () => {
    expect(normalizePhone("12345", "IN").ok).toBe(false);
    expect(normalizePhone("call me", "IN").ok).toBe(false);
  });
});

describe("normalizeContact", () => {
  it("strict mode rejects a bad phone with a field error", () => {
    expect(() => normalizeContact({ name: "A", phone: "123" }, { defaultCountry: "IN", strict: true })).toThrow(/phone/i);
  });
  it("lenient mode keeps the raw phone so automated leads are never lost", () => {
    const c = normalizeContact({ name: "A", phone: "123" }, { defaultCountry: "IN", strict: false });
    expect(c.phone).toBe("123");
    expect(c.phoneE164).toBeNull();
  });
  it("falls back to email for the name and squashes whitespace", () => {
    const c = normalizeContact({ name: "  ", email: "X@Y.com" }, { defaultCountry: "IN", strict: false });
    expect(c.name).toBe("x@y.com");
    const d = normalizeContact({ name: "  Rahul   Sharma ", email: "r@y.com" }, { defaultCountry: "IN", strict: true });
    expect(d.name).toBe("Rahul Sharma");
  });
});

describe("status rules", () => {
  it("open leads can move to any manual status but not back to NEW/ASSIGNED", () => {
    const next = allowedNextStatuses("CONTACTED");
    expect(next).toContain("CONVERTED");
    expect(next).toContain("LOST");
    expect(next).not.toContain("NEW");
    expect(next).not.toContain("ASSIGNED");
    expect(next).not.toContain("CONTACTED");
  });
  it("closed leads can only be reopened", () => {
    expect(allowedNextStatuses("LOST").sort()).toEqual(["CONTACTED", "ON_HOLD", "QUALIFIED"]);
    expect(allowedNextStatuses("CONVERTED")).not.toContain("LOST");
  });
});

describe("lead schemas", () => {
  it("requires an email or a phone", () => {
    expect(createLeadSchema.safeParse({ name: "A" }).success).toBe(false);
    expect(createLeadSchema.safeParse({ name: "A", phone: "98765 43210" }).success).toBe(true);
  });
  it("parses list filters from query strings", () => {
    const q = listLeadsQuerySchema.parse({ status: "NEW,LOST", page: "2", includeClosed: "false" });
    expect(q.status).toEqual(["NEW", "LOST"]);
    expect(q.page).toBe(2);
    expect(q.includeClosed).toBe(false);
    expect(listLeadsQuerySchema.safeParse({ status: "BOGUS" }).success).toBe(false);
  });
});
