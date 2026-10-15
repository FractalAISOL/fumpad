/** Pre-launch gate decisions. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide, gateMode, gatedHosts } from "./gate";

const on = {};
const go = (host: string, path: string, env = on) => decide(host, path, env);

describe("prelaunch gate", () => {
  it("serves the waiting room at / on fumpad.app and www", () => {
    assert.deepEqual(go("fumpad.app", "/"), { action: "rewrite", pathname: "/soon" });
    assert.deepEqual(go("www.fumpad.app", "/"), { action: "rewrite", pathname: "/soon" });
    assert.deepEqual(go("FUMPAD.APP:443", "/"), { action: "rewrite", pathname: "/soon" });
  });
  it("sends every app route on a gated host to /", () => {
    for (const p of ["/launches", "/coin/PIGN", "/fumbles", "/launch", "/u/abc", "/how-it-works", "/design", "/c/PIGN", "/share/x"]) {
      assert.deepEqual(go("fumpad.app", p), { action: "redirect", pathname: "/" }, p);
    }
  });
  it("keeps one public URL for the waiting room and its legal pages", () => {
    assert.deepEqual(go("fumpad.app", "/soon"), { action: "redirect", pathname: "/" });
    assert.deepEqual(go("fumpad.app", "/terms"), { action: "rewrite", pathname: "/soon/terms" });
    assert.deepEqual(go("fumpad.app", "/privacy/"), { action: "rewrite", pathname: "/soon/privacy" });
    assert.deepEqual(go("fumpad.app", "/soon/risk"), { action: "redirect", pathname: "/risk" });
  });
  it("lets assets, share cards and API routes through", () => {
    for (const p of ["/_next/static/x.js", "/og/abc", "/api/health", "/api", "/favicon.ico", "/icon.svg", "/opengraph-image.png", "/robots.txt", "/manifest.webmanifest"]) {
      assert.deepEqual(go("fumpad.app", p), { action: "next" }, p);
    }
  });
  it("leaves other hosts alone", () => {
    for (const h of ["fumpad.vercel.app", "localhost:3100", "fumpad-git-x.vercel.app", "", "evilfumpad.app"]) {
      assert.deepEqual(go(h, "/launches"), { action: "next" }, h);
    }
  });
  it("switches off with NEXT_PUBLIC_PRELAUNCH=off or an empty host list", () => {
    assert.deepEqual(go("fumpad.app", "/launches", { NEXT_PUBLIC_PRELAUNCH: "off" }), { action: "next" });
    assert.deepEqual(go("fumpad.app", "/launches", { NEXT_PUBLIC_PRELAUNCH: " OFF " }), { action: "next" });
    assert.deepEqual(go("fumpad.app", "/launches", { PRELAUNCH_HOSTS: "" }), { action: "next" });
    assert.deepEqual(go("fumpad.app", "/launches", { NEXT_PUBLIC_PRELAUNCH: "on" }), { action: "redirect", pathname: "/" });
  });
  it("checker mode: the launch-window page at /, everything else in the app still gated", () => {
    const env = { NEXT_PUBLIC_PRELAUNCH: "checker", NEXT_PUBLIC_CHECKER_MINT: "EsWqW6inhiDYKaYqpX4kGXaUkBUBmVqbXypoUB4bfmbL" };
    assert.equal(gateMode(env), "checker");
    assert.deepEqual(go("fumpad.app", "/", env), { action: "rewrite", pathname: "/live" });
    assert.deepEqual(go("www.fumpad.app", "/", { ...env, NEXT_PUBLIC_PRELAUNCH: " Checker " }), { action: "rewrite", pathname: "/live" });
    assert.deepEqual(go("fumpad.app", "/live", env), { action: "redirect", pathname: "/", keepQuery: true });
    assert.deepEqual(go("fumpad.app", "/live/", env), { action: "redirect", pathname: "/", keepQuery: true });
    for (const p of ["/launches", "/coin/x", "/fumbles", "/checker", "/launch", "/soon", "/u/abc"]) {
      const d = go("fumpad.app", p, env);
      assert.equal(d.action, "redirect", p);
      assert.equal((d as { pathname: string }).pathname, "/", p);
    }
    assert.deepEqual(go("fumpad.app", "/terms", env), { action: "rewrite", pathname: "/soon/terms" });
    for (const p of ["/video/howtoplay-16x9.mp4", "/api/x", "/_next/static/a.js", "/og/abc"]) assert.deepEqual(go("fumpad.app", p, env), { action: "next" }, p);
    // other hosts: the full app (and /live as a preview)
    assert.deepEqual(go("fumpad.vercel.app", "/live", env), { action: "next" });
  });
  it("checker mode without a valid mint stays the waiting room", () => {
    for (const m of [undefined, "", "not-a-mint", "0OIl".repeat(10)]) {
      const env = { NEXT_PUBLIC_PRELAUNCH: "checker", NEXT_PUBLIC_CHECKER_MINT: m };
      assert.equal(gateMode(env), "room", String(m));
      assert.deepEqual(go("fumpad.app", "/", env), { action: "rewrite", pathname: "/soon" });
      assert.deepEqual(go("fumpad.app", "/live", env), { action: "redirect", pathname: "/" });
    }
    assert.equal(gateMode({}), "room");
    assert.equal(gateMode({ NEXT_PUBLIC_PRELAUNCH: "off", NEXT_PUBLIC_CHECKER_MINT: "x" }), "off");
    // the waiting room's mp4 passthrough doesn't open anything else
    assert.deepEqual(go("fumpad.app", "/launches", {}), { action: "redirect", pathname: "/" });
  });
  it("parses custom host lists", () => {
    assert.deepEqual([...gatedHosts({ PRELAUNCH_HOSTS: " A.com , b.io:8080 ,," })], ["a.com", "b.io"]);
    assert.deepEqual(go("staging.fumpad.app", "/x", { PRELAUNCH_HOSTS: "staging.fumpad.app" }), { action: "redirect", pathname: "/" });
  });
});
