/** Pre-launch waitlist: body parsing, normalisation, client IP and IP hashing. */
import { describe, expect, it } from "vitest";

import { DEV_WAITLIST_IP_SALT, loadApiConfig, waitlistConfig } from "../src/config.js";
import { clientIp, ipHasher, normalizeEmail, normalizeHandle, parseWaitlistBody, waitlistSalt } from "../src/waitlist.js";

describe("waitlist normalisation", () => {
  it("handles: @, URLs, case; rejects anything X wouldn't allow", () => {
    expect(normalizeHandle("@Fumblepad")).toBe("fumblepad");
    expect(normalizeHandle("fumble_pad")).toBe("fumble_pad");
    expect(normalizeHandle("https://x.com/Fumblepad?s=20")).toBe("fumblepad");
    expect(normalizeHandle("twitter.com/Fumblepad/")).toBe("fumblepad");
    expect(normalizeHandle("www.x.com/abc")).toBe("abc");
    expect(normalizeHandle("a".repeat(16))).toBeNull();
    expect(normalizeHandle("no spaces")).toBeNull();
    expect(normalizeHandle("@")).toBeNull();
    expect(normalizeHandle("bad-dash")).toBeNull();
  });
  it("emails: trimmed, lowercased, sane shape and length", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com");
    expect(normalizeEmail("a+b@sub.example.io")).toBe("a+b@sub.example.io");
    expect(normalizeEmail("nope")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("a b@c.de")).toBeNull();
    expect(normalizeEmail("<x>@c.de")).toBeNull();
    expect(normalizeEmail(`${"a".repeat(65)}@c.de`)).toBeNull();
    expect(normalizeEmail(`a@${"b".repeat(250)}.de`)).toBeNull();
  });
});

describe("POST /v1/waitlist body", () => {
  it("single contact field: email or handle", () => {
    expect(parseWaitlistBody({ contact: "Ana@Example.com" })).toEqual({ email: "ana@example.com", xHandle: null, bot: false });
    expect(parseWaitlistBody({ contact: "@Ana_1" })).toEqual({ email: null, xHandle: "ana_1", bot: false });
    expect(parseWaitlistBody({ contact: "ana_1" })).toEqual({ email: null, xHandle: "ana_1", bot: false });
  });
  it("explicit fields, both at once", () => {
    expect(parseWaitlistBody({ email: "a@b.co", xHandle: "@b" })).toEqual({ email: "a@b.co", xHandle: "b", bot: false });
  });
  it("rejects empty, malformed and oversized input", () => {
    expect(() => parseWaitlistBody(null)).toThrow(/JSON/);
    expect(() => parseWaitlistBody([])).toThrow(/JSON/);
    expect(() => parseWaitlistBody({})).toThrow(/email or an X handle/);
    expect(() => parseWaitlistBody({ contact: "   " })).toThrow(/email or an X handle/);
    expect(() => parseWaitlistBody({ contact: "a@b" })).toThrow(/email/);
    expect(() => parseWaitlistBody({ contact: "has space" })).toThrow(/X handles/);
    expect(() => parseWaitlistBody({ email: 5 })).toThrow(/invalid email/);
    expect(() => parseWaitlistBody({ xHandle: "x".repeat(400) })).toThrow(/invalid xHandle/);
  });
  it("flags the honeypot", () => {
    expect(parseWaitlistBody({ contact: "@a", website: "spam.biz" }).bot).toBe(true);
  });
});

describe("client IP + hashing", () => {
  it("uses req.ip (the API's one TRUST_PROXY_HOPS-based derivation, tested in security.test.ts)", () => {
    expect(clientIp({ ip: "2.2.2.2" } as never)).toBe("2.2.2.2");
    expect(clientIp({ ip: "" } as never)).toBe("unknown");
  });
  it("hashes deterministically under the salt, never the raw IP", () => {
    const h = ipHasher("salt");
    expect(h("1.2.3.4")).toBe(h("1.2.3.4"));
    expect(h("1.2.3.4")).not.toBe(h("1.2.3.5"));
    expect(h("1.2.3.4")).not.toContain("1.2.3.4");
    expect(ipHasher("other")("1.2.3.4")).not.toBe(h("1.2.3.4"));
    expect(waitlistSalt({ waitlistIpSalt: "s" })).toBe("s");
    expect(() => waitlistSalt({})).toThrow(/WAITLIST_IP_SALT/);
  });
});

const PROD = { NODE_ENV: "production", DATABASE_URL: "postgres://backend/db", RPC_URL: "http://rpc", CORS_ORIGINS: "https://fumpad.app", API_SSR_SECRET: "x".repeat(32) };

describe("waitlist database + salt config", () => {
  it("outside production: falls back to DATABASE_URL and a fixed dev salt (never derived from a DB URL)", () => {
    const a = loadApiConfig({ DATABASE_URL: "postgres://a/1" } as NodeJS.ProcessEnv);
    const b = loadApiConfig({ DATABASE_URL: "postgres://b/2" } as NodeJS.ProcessEnv);
    expect(a.waitlistDatabaseUrl).toBe("postgres://a/1");
    expect(a.waitlistIpSalt).toBe(DEV_WAITLIST_IP_SALT);
    expect(b.waitlistIpSalt).toBe(a.waitlistIpSalt); // moving the DB doesn't change the hashes
    expect(a.waitlistDisabledReason).toBeUndefined();
    const c = loadApiConfig({ DATABASE_URL: "postgres://a/1", WAITLIST_DATABASE_URL: "postgres://w/1", WAITLIST_IP_SALT: "salt" } as NodeJS.ProcessEnv);
    expect([c.waitlistDatabaseUrl, c.waitlistIpSalt]).toEqual(["postgres://w/1", "salt"]);
  });

  it("production: needs its own DB and the salt, else the waitlist alone is disabled (config still loads)", () => {
    const none = loadApiConfig(PROD as NodeJS.ProcessEnv);
    expect(none.waitlistDisabledReason).toMatch(/WAITLIST_DATABASE_URL is not set/);
    expect(none.waitlistDisabledReason).toMatch(/WAITLIST_IP_SALT is not set/);
    expect(none.waitlistDatabaseUrl).toBeUndefined(); // never the backend DB
    const same = loadApiConfig({ ...PROD, WAITLIST_DATABASE_URL: PROD.DATABASE_URL, WAITLIST_IP_SALT: "s" } as NodeJS.ProcessEnv);
    expect(same.waitlistDisabledReason).toMatch(/separate database/);
    const noSalt = loadApiConfig({ ...PROD, WAITLIST_DATABASE_URL: "postgres://w/1" } as NodeJS.ProcessEnv);
    expect(noSalt.waitlistDisabledReason).toMatch(/^WAITLIST_IP_SALT is not set/);
    const ok = loadApiConfig({ ...PROD, WAITLIST_DATABASE_URL: "postgres://w/1", WAITLIST_IP_SALT: "s" } as NodeJS.ProcessEnv);
    expect(ok.waitlistDisabledReason).toBeUndefined();
    expect(waitlistConfig({ WAITLIST_DATABASE_URL: " postgres://w/1 ", WAITLIST_IP_SALT: " s " } as NodeJS.ProcessEnv, true)).toEqual({ waitlistDatabaseUrl: "postgres://w/1", waitlistIpSalt: "s", waitlistDisabledReason: undefined });
  });
});
