import { describe, expect, it } from "vitest";

import { summarize, worst } from "../src/status.js";

const NOW = 1_800_000_000_000;
const hb = (agoMs: number, pollMs = 2_000, ok = true) => ({
  name: "indexer",
  sha: "abc123",
  deploymentId: "dep-1",
  startedAt: NOW - 3_600_000,
  at: NOW - agoMs,
  ok,
  tipSlot: 123,
  msSinceLastPoll: pollMs,
});
const base = { now: NOW, lastTxTime: NOW / 1000 - 30, lastSampleTs: NOW / 1000 - 100, graduatedCoins: 3, indexer: hb(5_000), pool: { available: 150, reserved: 2 }, keeper: null };

describe("/v1/status summary", () => {
  it("all green", () => {
    const s = summarize(base);
    expect(s.level).toBe("ok");
    expect(s.indexer).toEqual({ level: "ok", lagSecs: 7, lastTxAgeSecs: 30, tipSlot: 123 });
    expect(s.keeper).toEqual({ level: "ok", lastSampleAgeSecs: 100, graduatedCoins: 3 });
    expect(s.vanityPool).toEqual({ level: "ok", available: 150, reserved: 2 });
    expect(s.services.map((v) => v.name)).toEqual(["api", "indexer"]);
    expect(s.services[1]).toMatchObject({ sha: "abc123", deploymentId: "dep-1", seenAt: NOW - 5_000 });
  });

  it("indexer: stale heartbeat is down, slow polling degraded, no heartbeat unknown", () => {
    expect(summarize({ ...base, indexer: hb(200_000) }).indexer.level).toBe("down");
    expect(summarize({ ...base, indexer: hb(5_000, 90_000) }).indexer.level).toBe("degraded");
    expect(summarize({ ...base, indexer: hb(5_000, 1_000, false) }).indexer.level).toBe("degraded");
    const s = summarize({ ...base, indexer: null });
    expect(s.indexer.level).toBe("unknown");
    expect(s.level).toBe("unknown");
  });

  it("keeper: late samples degrade, very late is down, nothing graduated is fine", () => {
    expect(summarize({ ...base, lastSampleTs: NOW / 1000 - 1_500 }).keeper.level).toBe("degraded");
    expect(summarize({ ...base, lastSampleTs: NOW / 1000 - 4_000 }).level).toBe("down");
    expect(summarize({ ...base, lastSampleTs: null, graduatedCoins: 0 }).keeper.level).toBe("ok");
    expect(summarize({ ...base, keeper: { ok: false } }).keeper.level).toBe("degraded");
    expect(summarize({ ...base, keeper: { ok: true, version: { sha: "k1" } } }).services[2]).toMatchObject({ name: "keeper", sha: "k1", seenAt: NOW });
  });

  it("vanity pool: empty is down, low degraded, disabled is null", () => {
    expect(summarize({ ...base, pool: { available: 0, reserved: 0 } }).vanityPool?.level).toBe("down");
    expect(summarize({ ...base, pool: { available: 5, reserved: 0 } }).level).toBe("degraded");
    expect(summarize({ ...base, pool: null }).vanityPool).toBeNull();
  });

  it("worst()", () => {
    expect(worst("ok", "unknown", "degraded")).toBe("degraded");
    expect(worst()).toBe("ok");
  });
});
