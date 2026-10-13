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

import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { DBC_POOL_AUTHORITY, parseMeteoraTrades } from "@fumpad/meteora";

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

function replay(name: string, params: EngineParams, edit: (h: HistoryTx[], coin: CoinFacts) => HistoryTx[] = (h) => h) {
  const f = load(name); // fresh objects every run
  const coin: CoinFacts = { ...f.coin, startSqrtPrice: BigInt(f.coin.startSqrtPrice), dammPool: null };
  const events = buildEvents(coin, edit(f.history, coin));
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
  for (const name of names) {
    it(`${name}: history fed in reverse order derives the same bytes (keepers crawl in different orders)`, () => {
      expect(canonicalJson(replay(name, RELAXED, (h) => [...h].reverse()).output)).toBe(canonicalJson(replay(name, RELAXED).output));
    });
    it(`${name}: a 1-unit donation into the DBC base vault inside a swap tx changes no decision (V7-H2)`, () => {
      const DONOR = "Donor11111111111111111111111111111111111111";
      const base = replay(name, RELAXED);
      let injected = false;
      const evil = replay(name, RELAXED, (h, coin) =>
        h.map((x) => {
          if (injected) return x;
          const r = parseMeteoraTrades(x.tx, { baseMints: new Set([coin.mint]) });
          if (!r.trades.some((t) => t.pool === coin.dbcPool) || r.issues.length) return x;
          const tx = JSON.parse(JSON.stringify(x.tx)) as typeof x.tx;
          const m = tx.transaction.message as { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string; stackHeight?: number }[] };
          const post = tx.meta!.postTokenBalances!;
          const vault = post.find((b) => b.owner === DBC_POOL_AUTHORITY && b.mint === coin.mint)!;
          vault.uiTokenAmount.amount = String(BigInt(vault.uiTokenAmount.amount) + 1n);
          // insert the donor's account at the end of the static keys (shifting lookup-table indices)
          const donorIdx = m.accountKeys.length;
          const shift = (i: number) => (i >= donorIdx ? i + 1 : i);
          type RawIx = { programIdIndex: number; accounts: number[] };
          const remap = (ix: RawIx) => {
            ix.programIdIndex = shift(ix.programIdIndex);
            ix.accounts = ix.accounts.map(shift);
          };
          m.instructions.forEach(remap);
          for (const g of tx.meta!.innerInstructions ?? []) (g.instructions as RawIx[]).forEach(remap);
          for (const b of [...tx.meta!.preTokenBalances!, ...post]) b.accountIndex = shift(b.accountIndex);
          const shiftBal = (a?: number[]) => a && a.splice(donorIdx, 0, 0);
          shiftBal(tx.meta!.preBalances);
          shiftBal(tx.meta!.postBalances);
          m.accountKeys.push("DonorAcc1111111111111111111111111111111111");
          const prog = m.accountKeys.indexOf(vault.programId ?? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
          const amount = new Uint8Array(8);
          amount[0] = 1;
          m.instructions.push({ programIdIndex: prog, accounts: [donorIdx, m.accountKeys.indexOf(coin.mint), vault.accountIndex, 0], data: bs58.encode(Uint8Array.from([12, ...amount, 6])), stackHeight: 1 });
          tx.meta!.preTokenBalances!.push({ accountIndex: donorIdx, mint: coin.mint, owner: DONOR, programId: vault.programId, uiTokenAmount: { amount: "1", decimals: 6 } });
          tx.meta!.postTokenBalances!.push({ accountIndex: donorIdx, mint: coin.mint, owner: DONOR, programId: vault.programId, uiTokenAmount: { amount: "0", decimals: 6 } });
          expect(parseMeteoraTrades(tx, { baseMints: new Set([coin.mint]) }).issues.map((i) => i.message)).toEqual([]);
          injected = true;
          return { ...x, tx };
        }),
      );
      expect(injected).toBe(true);
      expect(canonicalJson(evil.output.sells)).toBe(canonicalJson(base.output.sells));
      expect(canonicalJson(evil.output.rebuys)).toBe(canonicalJson(base.output.rebuys));
      // the donor's own unexplained outflow is its problem only
      expect(evil.output.issues.map((i) => [i.kind, i.scope, i.wallet])).toEqual([["negative_balance", "wallet", DONOR]]);
    });
  }
  it("the recorded histories exercise tickets, rebuys and both venues", () => {
    expect(totals.tickets).toBeGreaterThan(0);
    expect(totals.rebuys).toBeGreaterThan(0);
    expect(totals.dbcSells).toBeGreaterThan(0);
    expect(totals.dammSells).toBeGreaterThan(0);
  });
});
