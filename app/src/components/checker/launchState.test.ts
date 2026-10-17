/** Launch-window page: coming-soon vs live decisions. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HERO, META, SOON_BANNER, SOON_CAVEAT, launchSections, launchState, soonLede } from "./launchState";

const MINT = "EsWqW6inhiDYKaYqpX4kGXaUkBUBmVqbXypoUB4bfmbL";

describe("launch-window page state", () => {
  it("is live only with a valid mint", () => {
    assert.deepEqual(launchState(MINT), { state: "live", mint: MINT });
    assert.deepEqual(launchState(`  ${MINT}\n`), { state: "live", mint: MINT });
    for (const m of [undefined, null, "", "   ", "not-a-mint", "0OIl".repeat(10), MINT.slice(0, 20), `${MINT}x`]) {
      assert.deepEqual(launchState(m), { state: "soon", mint: null }, String(m));
    }
  });
  it("coming soon: hero, follow, rules; no coin panel, checker or live banner", () => {
    assert.deepEqual(launchSections("soon"), { opensBanner: false, soonBanner: true, intro: true, follow: true, coin: false, checker: false, rules: true });
  });
  it("live: coin panel, checker, live banner and rules; no pre-launch intro", () => {
    assert.deepEqual(launchSections("live"), { opensBanner: true, soonBanner: false, intro: false, follow: false, coin: true, checker: true, rules: true });
  });
  it("only says 'live' when a mint is set", () => {
    const soonText = [...Object.values(HERO.soon), ...Object.values(META.soon), SOON_BANNER.strong, SOON_BANNER.rest, SOON_CAVEAT, soonLede({ triggerMultiple: 10, claimBps: 1000 })].join(" ");
    assert.doesNotMatch(soonText, /\blive\b/i);
    assert.match(HERO.soon.title, /^The first coin launches soon\.$/);
    assert.match(META.soon.title, /launches soon/);
    assert.match(META.soon.socialDescription, /Coming soon/);
    assert.match(HERO.live.title, /is live/);
    assert.match(META.live.title, /is live/);
  });
  it("makes no promises in the pre-launch copy, and keeps the caveat", () => {
    const soonText = [...Object.values(HERO.soon), ...Object.values(META.soon), soonLede({ triggerMultiple: 10, claimBps: 1000 })].join(" ");
    assert.doesNotMatch(soonText, /guarantee|profit|returns|free money|you will earn/i);
    assert.match(SOON_CAVEAT, /Nothing is guaranteed/);
    assert.ok(HERO.soon.bubble.split(/\s+/).length <= 8);
    assert.ok(HERO.live.bubble.split(/\s+/).length <= 8);
  });
  it("lede numbers follow the protocol params", () => {
    assert.match(soonLede({ triggerMultiple: 10, claimBps: 1000 }), /holds 10× that price, you can claim 10% of the tokens/);
    assert.match(soonLede({ triggerMultiple: 2, claimBps: 1250 }), /holds 2× that price, you can claim 12\.5% of the tokens/);
  });
});
