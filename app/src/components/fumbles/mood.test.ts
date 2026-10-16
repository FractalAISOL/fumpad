/** My fumbles: Fumi's reaction. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ticket } from "../../data/types";
import { fumblesMood } from "./mood";

const t = (...states: Ticket["state"][]) => states.map((state) => ({ state }));

describe("My fumbles: Fumi's reaction", () => {
  it("no tickets: no reaction (the empty state has her)", () => {
    assert.equal(fumblesMood(null), null);
    assert.equal(fumblesMood([]), null);
  });
  it("the strongest stage wins", () => {
    assert.equal(fumblesMood(t("tracking", "claimable", "verifying"))?.pose, "cheering");
    assert.equal(fumblesMood(t("queued"))?.pose, "cheering");
    assert.equal(fumblesMood(t("tracking", "verifying", "challenge"))?.pose, "thinking");
    assert.equal(fumblesMood(t("tracking", "challenge", "claimed"))?.pose, "ticket");
    assert.equal(fumblesMood(t("expired", "claimed", "tracking"))?.pose, "cheering");
    assert.equal(fumblesMood(t("awaiting-graduation", "expired"))?.pose, "ticket");
    assert.equal(fumblesMood(t("expired", "voided"))?.pose, "crying");
  });
  it("quips stay short and promise nothing", () => {
    const states: Ticket["state"][] = ["claimable", "queued", "verifying", "challenge", "claimed", "tracking", "awaiting-graduation", "expired", "voided"];
    for (const st of states) {
      const m = fumblesMood(t(st))!;
      assert.ok(m.quip.split(/\s+/).length <= 8, m.quip);
      assert.doesNotMatch(m.quip, /profit|guarantee|earn|returns|free money|\$|\bSOL\b/i, m.quip);
    }
  });
});
