/** Pre-launch gate decisions. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decide, gateMode, gatedHosts } from "./gate";

const on = {};
const go = (host: string, path: string, env = on) => decide(host, path, env);
const LIVE = { action: "rewrite", pathname: "/live" };

describe("prelaunch gate", () => {
  it("serves the launch-window page at / on fumpad.app and www (default mode)", () => {
    assert.deepEqual(go("fumpad.app", "/"), LIVE);
    assert.deepEqual(go("www.fumpad.app", "/"), LIVE);
    assert.deepEqual(go("FUMPAD.APP:443", "/"), LIVE);
    assert.deepEqual(go("fumpad.app", "//"), LIVE);
  });
  it("unset, checker, live and any other value are the same launch-window mode; only off opens the app", () => {
    for (const v of [undefined, "", "checker", " Checker ", "live", "LIVE", "on", "soon", "room"]) {
      const env = { NEXT_PUBLIC_PRELAUNCH: v };
      assert.equal(gateMode(env), "launch", String(v));
      assert.deepEqual(go("fumpad.app", "/", env), LIVE, String(v));
      assert.deepEqual(go("fumpad.app", "/launches", env), { action: "redirect", pathname: "/" }, String(v));
    }
    for (const v of ["off", " OFF ", "Off"]) assert.equal(gateMode({ NEXT_PUBLIC_PRELAUNCH: v }), "off", v);
  });
  it("sends every app route on a gated host to /", () => {
    for (const p of ["/launches", "/coin/PIGN", "/fumbles", "/checker", "/launch", "/u/abc", "/how-it-works", "/design", "/c/PIGN", "/share/x"]) {
      assert.deepEqual(go("fumpad.app", p), { action: "redirect", pathname: "/" }, p);
    }
  });
  it("keeps one public URL for the page, with its ?wallet= links", () => {
    assert.deepEqual(go("fumpad.app", "/live"), { action: "redirect", pathname: "/", keepQuery: true });
    assert.deepEqual(go("www.fumpad.app", "/live/"), { action: "redirect", pathname: "/", keepQuery: true });
  });
  it("no longer serves the old waiting room on a gated host", () => {
    assert.deepEqual(go("fumpad.app", "/soon"), { action: "redirect", pathname: "/" });
    assert.deepEqual(go("fumpad.app", "/soon/"), { action: "redirect", pathname: "/" });
    for (const v of [undefined, "checker"]) assert.notDeepEqual(go("fumpad.app", "/", { NEXT_PUBLIC_PRELAUNCH: v }), { action: "rewrite", pathname: "/soon" });
  });
  it("serves the legal pages (pre-launch frame), one public URL each", () => {
    assert.deepEqual(go("fumpad.app", "/terms"), { action: "rewrite", pathname: "/soon/terms" });
    assert.deepEqual(go("fumpad.app", "/privacy/"), { action: "rewrite", pathname: "/soon/privacy" });
    assert.deepEqual(go("www.fumpad.app", "/risk"), { action: "rewrite", pathname: "/soon/risk" });
    assert.deepEqual(go("fumpad.app", "/soon/risk"), { action: "redirect", pathname: "/risk" });
    assert.deepEqual(go("fumpad.app", "/soon/terms"), { action: "redirect", pathname: "/terms" });
  });
  it("lets assets, share cards, the video and API routes through", () => {
    for (const p of ["/_next/static/x.js", "/og/abc", "/api/health", "/api", "/favicon.ico", "/icon.svg", "/opengraph-image.png", "/live/opengraph-image.png", "/robots.txt", "/manifest.webmanifest", "/video/howtoplay-16x9.mp4"]) {
      assert.deepEqual(go("fumpad.app", p), { action: "next" }, p);
    }
  });
  it("leaves other hosts alone (the app, plus /live and /soon as previews)", () => {
    for (const h of ["fumpad.vercel.app", "localhost:3100", "fumpad-git-x.vercel.app", "", "evilfumpad.app"]) {
      for (const p of ["/launches", "/live", "/soon", "/"]) assert.deepEqual(go(h, p), { action: "next" }, `${h}${p}`);
    }
  });
  it("switches off with NEXT_PUBLIC_PRELAUNCH=off or an empty host list", () => {
    assert.deepEqual(go("fumpad.app", "/launches", { NEXT_PUBLIC_PRELAUNCH: "off" }), { action: "next" });
    assert.deepEqual(go("fumpad.app", "/", { NEXT_PUBLIC_PRELAUNCH: " OFF " }), { action: "next" });
    assert.deepEqual(go("fumpad.app", "/launches", { PRELAUNCH_HOSTS: "" }), { action: "next" });
  });
  it("parses custom host lists", () => {
    assert.deepEqual([...gatedHosts({ PRELAUNCH_HOSTS: " A.com , b.io:8080 ,," })], ["a.com", "b.io"]);
    assert.deepEqual(go("staging.fumpad.app", "/x", { PRELAUNCH_HOSTS: "staging.fumpad.app" }), { action: "redirect", pathname: "/" });
  });
});
