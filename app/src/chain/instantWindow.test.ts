/** APP-6: the instant-trading spend window, one per browser origin (all tabs). `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addSpent, INSTANT_WINDOW_MS, parseSpent } from "./instantWindow";

const T0 = 1_800_000_000_000;
const SOL = BigInt(1_000_000_000);

describe("instant spend window (APP-6)", () => {
  it("adds up across calls (as two tabs writing the same localStorage key do) and keeps the window's start", () => {
    let raw: string | null = null;
    raw = addSpent(raw, SOL, T0); // tab A
    raw = addSpent(raw, SOL * BigInt(2), T0 + 60_000); // tab B reads A's value and adds
    assert.deepEqual(parseSpent(raw, T0 + 120_000), { lamports: SOL * BigInt(3), since: T0 });
  });

  it("a new window starts once the old one is over; nothing spent means null", () => {
    const raw = addSpent(null, SOL, T0);
    assert.equal(parseSpent(raw, T0 + INSTANT_WINDOW_MS - 1)?.lamports, SOL);
    assert.equal(parseSpent(raw, T0 + INSTANT_WINDOW_MS), null);
    assert.deepEqual(parseSpent(addSpent(raw, BigInt(5), T0 + INSTANT_WINDOW_MS), T0 + INSTANT_WINDOW_MS), { lamports: BigInt(5), since: T0 + INSTANT_WINDOW_MS });
    assert.equal(parseSpent(null, T0), null);
  });

  it("ignores malformed values and never treats a negative add as a refund", () => {
    for (const raw of ["", "5", "{}", '{"l":5,"t":1}', '{"l":"-1","t":1}', '{"l":"1","t":"x"}', "not json", '{"l":"1e9","t":1}']) assert.equal(parseSpent(raw, T0), null, raw);
    const raw = addSpent(null, SOL, T0);
    assert.equal(parseSpent(addSpent(raw, -SOL, T0), T0)?.lamports, SOL);
  });

  it("a start time in the future (clock moved back, or a tampered value) counts from now, never a reset", () => {
    const future = JSON.stringify({ l: SOL.toString(), t: T0 + 10 * INSTANT_WINDOW_MS });
    assert.deepEqual(parseSpent(future, T0), { lamports: SOL, since: T0 });
  });
});
