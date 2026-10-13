/**
 * Full v0.7 local acceptance test — the same run as `npm run local` (validator with fumpad v0.7 + mainnet
 * DBC/DAMM v2, Postgres, indexer, API, grinder, keeper, 3 attestors, watcher). Needs `anchor build -p
 * fumpad` in contracts/ and solana-test-validator.
 */
import { describe, expect, it } from "vitest";

import { runE2E } from "../../scripts/local/e2e.js";

describe("local stack end to end (v0.7)", () => {
  it("launch → trades (any app) → attested tickets → graduation → claims → watcher clean", async () => {
    const r = await runE2E({ rpcPort: 8899, apiPort: 18180, log: () => {} });
    const failed = r.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(r.counts.tickets).toBeGreaterThanOrEqual(2);
  }, 1_500_000);
});
