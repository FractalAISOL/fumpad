/** H-5 security headers. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentSecurityPolicy, cspMode, securityHeaders } from "./headers";

const prod = {
  NODE_ENV: "production",
  NEXT_PUBLIC_FUMPAD_API: "https://api-production-66441.up.railway.app",
  NEXT_PUBLIC_SOLANA_RPC: "https://devnet.helius-rpc.com/?api-key=abc",
};
const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(name + " "))?.split(" ").slice(1) ?? [];

describe("security headers", () => {
  it("enforces the CSP in production and only reports in development", () => {
    assert.equal(cspMode({ NODE_ENV: "production" }), "enforce");
    assert.equal(cspMode({ NODE_ENV: "development" }), "report-only");
    assert.equal(cspMode({ NODE_ENV: "production", CSP_MODE: "report-only" }), "report-only");
    assert.equal(cspMode({ NODE_ENV: "production", CSP_MODE: "bogus" }), "enforce");
    const keys = (env: object) => securityHeaders(env).map((h) => h.key);
    assert.ok(keys(prod).includes("Content-Security-Policy"));
    assert.ok(keys({ NODE_ENV: "development" }).includes("Content-Security-Policy-Report-Only"));
    assert.ok(!keys({ NODE_ENV: "production", CSP_MODE: "off" }).some((k) => k.startsWith("Content-Security")));
  });

  it("sends the static hardening headers", () => {
    const h = Object.fromEntries(securityHeaders(prod).map((x) => [x.key, x.value]));
    assert.equal(h["X-Frame-Options"], "DENY");
    assert.equal(h["Strict-Transport-Security"], "max-age=63072000; includeSubDomains; preload");
    assert.equal(h["X-Content-Type-Options"], "nosniff");
    assert.equal(h["Referrer-Policy"], "strict-origin-when-cross-origin");
    assert.match(h["Permissions-Policy"], /camera=\(\)/);
  });

  it("allows only our API, our RPC and Privy to be contacted", () => {
    const csp = contentSecurityPolicy(prod);
    const connect = directive(csp, "connect-src");
    for (const o of [
      "'self'",
      "https://api-production-66441.up.railway.app",
      "wss://api-production-66441.up.railway.app",
      "https://devnet.helius-rpc.com",
      "wss://devnet.helius-rpc.com",
      "https://auth.privy.io",
      "wss://*.privy.io",
      "https://*.rpc.privy.systems",
      "https://explorer-api.walletconnect.com",
    ])
      assert.ok(connect.includes(o), o);
    // Origins only: the RPC key in the query string never lands in a header.
    assert.ok(!csp.includes("api-key"));
    assert.ok(!connect.some((o) => o.startsWith("ws://")), "no dev sockets in production");
  });

  it("locks scripts, frames, plugins and the base URL", () => {
    const csp = contentSecurityPolicy(prod);
    assert.deepEqual(directive(csp, "script-src"), ["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com"]);
    assert.deepEqual(directive(csp, "frame-src"), ["https://auth.privy.io", "https://challenges.cloudflare.com"]);
    assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
    assert.deepEqual(directive(csp, "object-src"), ["'none'"]);
    assert.deepEqual(directive(csp, "base-uri"), ["'self'"]);
    assert.deepEqual(directive(csp, "form-action"), ["'self'"]);
    assert.ok(!csp.includes("unsafe-eval"));
    assert.ok(contentSecurityPolicy({ NODE_ENV: "development" }).includes("'unsafe-eval'"));
  });

  it("V7-L6: images only from our origin, data:/blob:, our API (image proxy) and the wallet registry — no https: wildcard", () => {
    const img = directive(contentSecurityPolicy(prod), "img-src");
    assert.deepEqual(img, ["'self'", "data:", "blob:", "https://api-production-66441.up.railway.app", "https://explorer-api.walletconnect.com"]);
    assert.ok(!img.includes("https:") && !img.includes("*") && !img.some((s) => s.startsWith("wss:")));
    // Mock mode (no API): nothing remote but the registry.
    assert.deepEqual(directive(contentSecurityPolicy({ NODE_ENV: "production" }), "img-src"), ["'self'", "data:", "blob:", "https://explorer-api.walletconnect.com"]);
    // The RPC origin (and its key) never become an image source.
    assert.ok(!img.some((s) => s.includes("helius")));
  });

  it("falls back to the public mainnet RPC like chain/cluster.ts, and takes a separate WS URL", () => {
    const csp = contentSecurityPolicy({ NODE_ENV: "production", NEXT_PUBLIC_FUMPAD_WS: "wss://live.fumpad.app/v1/ws" });
    const connect = directive(csp, "connect-src");
    assert.ok(connect.includes("https://api.mainnet-beta.solana.com"));
    assert.ok(connect.includes("wss://live.fumpad.app"));
  });
});
