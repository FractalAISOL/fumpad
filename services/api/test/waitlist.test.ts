/** Pre-launch waitlist: body parsing, normalisation, client IP and IP hashing. */
import { describe, expect, it } from "vitest";

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
    expect(waitlistSalt({ waitlistIpSalt: "s", databaseUrl: "x" })).toBe("s");
    expect(waitlistSalt({ databaseUrl: "postgres://a" })).toMatch(/^[0-9a-f]{64}$/);
  });
});
