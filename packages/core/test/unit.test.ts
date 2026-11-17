import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema } from "@lfm/shared";
import {
  MemoryRateLimitStore,
  RateLimiter,
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  hasPermission,
  productionProblems,
  hashPassword,
  hashToken,
  manageableRoles,
  randomToken,
  safeEqual,
  verifyPassword,
} from "../src";

describe("encryption (AES-256-GCM)", () => {
  const key = randomBytes(32).toString("base64");

  it("round-trips strings and JSON", () => {
    expect(decrypt(encrypt("secret-token", key), key)).toBe("secret-token");
    expect(decryptJson(encryptJson({ a: 1, b: ["x"] }, key), key)).toEqual({ a: 1, b: ["x"] });
  });

  it("uses a fresh IV for every encryption", () => {
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("rejects tampered ciphertext", () => {
    const parts = encrypt("hello", key).split(":");
    parts[3] = Buffer.from("jello").toString("base64url");
    expect(() => decrypt(parts.join(":"), key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const other = randomBytes(32).toString("base64");
    expect(() => decrypt(encrypt("hello", key), other)).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => encrypt("x", randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("tokens", () => {
  it("generates unique url-safe tokens", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });

  it("hashes deterministically with the secret", () => {
    expect(hashToken("abc", "s1".repeat(16))).toBe(hashToken("abc", "s1".repeat(16)));
    expect(hashToken("abc", "s1".repeat(16))).not.toBe(hashToken("abc", "s2".repeat(16)));
  });

  it("compares in constant time and handles length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("passwords", () => {
  it("hashes and verifies", async () => {
    const hash = await hashPassword("correct horse 1");
    expect(hash).not.toContain("correct");
    expect(await verifyPassword("correct horse 1", hash)).toBe(true);
    expect(await verifyPassword("wrong horse 1", hash)).toBe(false);
  });
});

describe("permissions", () => {
  it("matches the RBAC matrix", () => {
    expect(hasPermission("OWNER", "org:delete")).toBe(true);
    expect(hasPermission("ADMIN", "org:delete")).toBe(false);
    expect(hasPermission("ADMIN", "integrations:manage")).toBe(true);
    expect(hasPermission("MANAGER", "integrations:manage")).toBe(false);
    expect(hasPermission("MANAGER", "leads:assign")).toBe(true);
    expect(hasPermission("SALESPERSON", "leads:view_all")).toBe(false);
    expect(hasPermission("SALESPERSON", "leads:view_assigned")).toBe(true);
  });

  it("never lets anyone grant OWNER, and limits managers to salespeople", () => {
    for (const r of ["OWNER", "ADMIN", "MANAGER", "SALESPERSON"] as const) {
      expect(manageableRoles(r)).not.toContain("OWNER");
    }
    expect(manageableRoles("MANAGER")).toEqual(["SALESPERSON"]);
    expect(manageableRoles("SALESPERSON")).toEqual([]);
  });
});

describe("rate limiter", () => {
  it("blocks after the limit within a window", async () => {
    const rl = new RateLimiter(new MemoryRateLimitStore(), 2, 60_000);
    expect((await rl.check("k")).allowed).toBe(true);
    expect((await rl.check("k")).allowed).toBe(true);
    expect((await rl.check("k")).allowed).toBe(false);
    expect((await rl.check("other")).allowed).toBe(true);
  });
});

describe("validation schemas", () => {
  const valid = {
    name: "Priya",
    email: " Priya@Agency.com ",
    password: "longpassword1",
    businessName: "Acme Agency",
    businessEmail: "hello@acme.com",
    timezone: "Asia/Kolkata",
    website: "",
  };

  it("normalizes email and treats empty website as absent", () => {
    const parsed = registerSchema.parse(valid);
    expect(parsed.email).toBe("priya@agency.com");
    expect(parsed.website).toBeUndefined();
  });

  it("rejects weak passwords, bad timezones and bad URLs", () => {
    expect(registerSchema.safeParse({ ...valid, password: "short1" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: "onlyletterslong" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, website: "not a url" }).success).toBe(false);
  });

  it("requires login fields", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });
});

describe("production configuration checks", () => {
  const good = {
    NODE_ENV: "production",
    APP_URL: "https://leads.example.org",
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    SESSION_SECRET: randomBytes(32).toString("base64"),
  } as NodeJS.ProcessEnv;

  it("accepts a proper production setup and ignores development", () => {
    expect(productionProblems(good)).toEqual([]);
    expect(productionProblems({ ...good, NODE_ENV: "development", APP_URL: "http://localhost:3000" })).toEqual([]);
  });

  it("rejects http, localhost, weak keys, reused secrets and half-configured providers", () => {
    expect(productionProblems({ ...good, APP_URL: "http://leads.example.org" }).join()).toMatch(/https/);
    expect(productionProblems({ ...good, APP_URL: "https://localhost" }).join()).toMatch(/localhost/);
    expect(productionProblems({ ...good, ENCRYPTION_KEY: "c2hvcnQ=" }).join()).toMatch(/32 random bytes/);
    expect(productionProblems({ ...good, SESSION_SECRET: good.ENCRYPTION_KEY }).join()).toMatch(/different/);
    expect(productionProblems({ ...good, GOOGLE_CLIENT_ID: "x" }).join()).toMatch(/GOOGLE_CLIENT_SECRET/);
    expect(productionProblems({ ...good, META_APP_ID: "1", META_APP_SECRET: "s" }).join()).toMatch(/WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
    expect(productionProblems({ ...good, APP_URL: "http://10.0.0.5:3000", ALLOW_INSECURE_HTTP: "1" })).toEqual([]);
  });
});
