/**
 * Full local acceptance test (validator + Postgres + indexer + API + keeper), the same
 * run as `npm run local`. Needs `anchor build` in contracts/ and solana-test-validator.
 */
import { describe, expect, it } from "vitest";

import { runE2E } from "../../scripts/local/e2e.js";

describe("local stack end to end", () => {
  it("indexer → db → api on solana-test-validator, keeper cranking", async () => {
    const r = await runE2E({ rpcPort: 8899, apiPort: 18180, extraCoins: Number(process.env.EXTRA_COINS ?? 5), log: () => {} });
    const failed = r.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(r.counts.claims).toBeGreaterThanOrEqual(2);
    expect(r.wsEvents).toContain("claim");
  }, 1_200_000);
});
