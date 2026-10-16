/** Wallet profile: Fumi's line. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Ticket } from "../../../data/types";
import { profileMood } from "./mood";

const none = { tickets: [], positions: [], closed: [], created: [] };
const tk = (...states: Ticket["state"][]) => states.map((state) => ({ state }));

describe("profile: Fumi's line", () => {
  it("empty wallets", () => {
    assert.equal(profileMood({ ticketsFiled: 0, crossed10x: 0 }, none).pose, "thinking");
    assert.equal(profileMood({ ticketsFiled: 0, crossed10x: 0 }, { ...none, positions: [{}] }).pose, "waving");
  });
  it("fumblers", () => {
    assert.equal(profileMood({ ticketsFiled: 3, crossed10x: 0 }, { ...none, tickets: tk("tracking") }).pose, "ticket");
    assert.equal(profileMood({ ticketsFiled: 3, crossed10x: 1 }, { ...none, tickets: tk("claimed") }).pose, "cheering");
    assert.equal(profileMood({ ticketsFiled: 3, crossed10x: 0 }, { ...none, tickets: tk("tracking", "claimable") }).quip, "Claim time?");
  });
  it("quips stay short and promise nothing", () => {
    const cases = [
      profileMood({ ticketsFiled: 0, crossed10x: 0 }, none),
      profileMood({ ticketsFiled: 0, crossed10x: 0 }, { ...none, closed: [{}] }),
      profileMood({ ticketsFiled: 2, crossed10x: 0 }, { ...none, tickets: tk("expired") }),
      profileMood({ ticketsFiled: 2, crossed10x: 2 }, { ...none, tickets: tk("claimed") }),
      profileMood({ ticketsFiled: 2, crossed10x: 0 }, { ...none, tickets: tk("queued") }),
    ];
    for (const m of cases) {
      assert.ok(m.quip.split(/\s+/).length <= 8, m.quip);
      assert.doesNotMatch(m.quip, /profit|guarantee|earn|returns|free money|\$|\bSOL\b/i, m.quip);
    }
  });
});
