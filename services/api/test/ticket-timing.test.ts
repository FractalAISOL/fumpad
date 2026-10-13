import { describe, expect, it } from "vitest";

import { ticketTiming } from "../src/repo.js";

const CH = 21_600;

describe("ticket attestation timing", () => {
  it("the challenge window runs from effective_at (rate-cap deferral, INTERFACE §8.4)", () => {
    expect(ticketTiming("1000", "1500", CH)).toEqual({ attestedAt: 1_000_000, effectiveAt: 1_500_000, challengeEnd: 1500 + CH, claimableFrom: (1500 + CH) * 1000 });
  });

  it("effective_at 0 or NULL (pre-§8.4 rows/events) falls back to attested_at", () => {
    const expected = { attestedAt: 1_000_000, effectiveAt: undefined, challengeEnd: 1000 + CH, claimableFrom: (1000 + CH) * 1000 };
    expect(ticketTiming("1000", "0", CH)).toEqual(expected);
    expect(ticketTiming("1000", 0, BigInt(CH))).toEqual(expected);
    expect(ticketTiming("1000", null, CH)).toEqual(expected);
    expect(ticketTiming(1000, undefined, CH)).toEqual(expected);
  });

  it("not attested (attested_at 0/NULL, no effective_at): no claimableFrom", () => {
    for (const a of [null, undefined, "0", 0]) expect(ticketTiming(a, null, CH)).toEqual({ attestedAt: undefined, effectiveAt: undefined, challengeEnd: undefined, claimableFrom: undefined });
  });
});
