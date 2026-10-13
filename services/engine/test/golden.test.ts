// Golden replays of recorded MAINNET DBC → DAMM v2 coin histories (engine/scripts/record-history.ts,
// read-only). Each replay runs twice from the raw transactions (fresh parse each time) and must be
// byte-identical, match the committed expected output, and leave every wallet balance non-negative
// (the crawl was complete). These coins aren't FUMPAD coins: the engine is pointed at their pools
// exactly as it would be at ours. SOL/USD is SYNTHETIC ($150.00, conf 0, published 1 s before each
// block) because Pyth Hermes needs an API key (see src/pyth.ts) — USD values are not real.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { buildEvents, canonicalJson, type CoinFacts, DEFAULT_ENGINE_PARAMS, type EngineParams, type HistoryTx, runEngine } from "../src/index.js";
import { usd150 } from "./helpers.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

interface Fixture {
  coin: Omit<CoinFacts, "startSqrtPrice"> & { startSqrtPrice: string };
  history: HistoryTx[];
  maxSlot: number;
}

const load = (name: string): Fixture => JSON.parse(gunzipSync(readFileSync(join(dir, `${name}.history.json.gz`))).toString());

/**
 * Stress terms (engine-only, OUTSIDE the D23 bounds: 1 s hold, $0.50 minimum). These recorded coins are
 * bot-flipped (most sells < 60 s after the buy), so the default terms make almost no tickets; the stress
 * terms make the same real flows exercise ticket creation, D10/D12 pricing and rebuy debits.
 */
const RELAXED: EngineParams = { ...DEFAULT_ENGINE_PARAMS, minHoldSecs: 1n, minSellUsdCents: 50n };

function replay(name: string, params: EngineParams) {
  const f = load(name); // fresh objects every run
  const coin: CoinFacts = { ...f.coin, startSqrtPrice: BigInt(f.coin.startSqrtPrice), dammPool: null };
  const events = buildEvents(coin, f.history);
  const r = runEngine(coin, events, params, usd150);
  if (!r.done) throw new Error("prices missing");
  return { coin: f.coin, events, output: r.output };
}

const names = readdirSync(dir)
  .filter((f) => f.endsWith(".history.json.gz"))
  .map((f) => f.replace(".history.json.gz", ""))
  .sort();

describe("golden mainnet histories", () => {
  it("has fixtures", () => expect(names.length).toBeGreaterThanOrEqual(2));
  const totals = { tickets: 0, rebuys: 0, dbcSells: 0, dammSells: 0 };
  for (const name of names) {
    for (const [label, params] of [["default", DEFAULT_ENGINE_PARAMS], ["stress", RELAXED]] as const) {
      it(`${name} (${label} terms): two independent replays are byte-identical and match the recorded output`, () => {
        const a = replay(name, params);
        const b = replay(name, params);
        const ca = canonicalJson(a.output);
        expect(canonicalJson(b.output)).toBe(ca);
        expect(a.output.issues).toEqual([]); // complete history: no negative balance, no parser issue on its pools
        const kinds = new Map<string, number>();
        for (const e of a.events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
        expect(kinds.get("swap")).toBeGreaterThan(10);
        expect(kinds.get("pool_init")).toBe(1); // graduated to DAMM v2
        for (const s of a.output.sells) {
          if (s.ticket) totals.tickets++;
          if (s.venue === "dbc") totals.dbcSells++;
          else totals.dammSells++;
        }
        totals.rebuys += a.output.rebuys.length;

        const expectedFile = join(dir, `${name}.${label}.expected.json`);
        if (UPDATE || !existsSync(expectedFile)) writeFileSync(expectedFile, ca + "\n");
        expect(ca + "\n").toBe(readFileSync(expectedFile, "utf8"));
      });
    }
  }
  it("the recorded histories exercise tickets, rebuys and both venues", () => {
    expect(totals.tickets).toBeGreaterThan(0);
    expect(totals.rebuys).toBeGreaterThan(0);
    expect(totals.dbcSells).toBeGreaterThan(0);
    expect(totals.dammSells).toBeGreaterThan(0);
  });
});
