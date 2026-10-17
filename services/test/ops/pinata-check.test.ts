/** scripts/ops/pinata-check.ts with a mocked fetch: the JWT is sent as Bearer and never printed. */
import { describe, expect, it } from "vitest";

import { checkPinata, PINATA_AUTH_URL } from "../../scripts/ops/pinata-check.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2VjcmV0LXNpZ25hdHVyZQ";

describe("pinata-check", () => {
  it("PASS: calls the auth test endpoint with the Bearer JWT; output never contains it", async () => {
    let seen: { url: string; auth?: string } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization };
      return new Response(JSON.stringify({ message: "Congratulations! You are communicating with the Pinata API!" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await checkPinata(JWT, "fumpad.mypinata.cloud", f);
    expect(r.ok).toBe(true);
    expect(seen).toEqual({ url: PINATA_AUTH_URL, auth: `Bearer ${JWT}` });
    expect(r.lines.join("\n")).not.toContain(JWT);
    expect(r.lines.join("\n")).toMatch(/PASS.*HTTP 200[\s\S]*PASS  PINATA_GATEWAY → https:\/\/fumpad\.mypinata\.cloud\/ipfs\//);
  });

  it("FAIL: refused, unreachable, unset, bad gateway; still never prints the JWT", async () => {
    const refused = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const r1 = await checkPinata(JWT, undefined, refused);
    expect(r1.ok).toBe(false);
    expect(r1.lines[0]).toMatch(/FAIL.*401/);
    const down = (async () => {
      throw new Error(`connect failed for ${JWT}`);
    }) as unknown as typeof fetch;
    const r2 = await checkPinata(JWT, undefined, down);
    expect(r2.ok).toBe(false);
    expect(r2.lines.join("\n")).not.toContain(JWT);
    expect((await checkPinata(undefined, undefined)).lines[0]).toMatch(/not set/);
    const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const r3 = await checkPinata(JWT, "http://10.0.0.1", ok);
    expect(r3.ok).toBe(false);
    expect(r3.lines.at(-1)).toMatch(/FAIL.*PINATA_GATEWAY/);
  });
});
