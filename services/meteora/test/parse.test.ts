/**
 * parseMeteoraTrades / parsePoolFacts against real mainnet transactions (test/fixtures, re-fetchable with
 * `npm run fixtures -w @fumpad/meteora`), plus tamper tests for the fail-closed paths.
 */
import { readFileSync } from "node:fs";

import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import {
  type ConfirmedTx,
  DAMM_V2_EVENT_AUTHORITY,
  DAMM_V2_POOL_AUTHORITY,
  DAMM_V2_PROGRAM_ID,
  DBC_EVENT_AUTHORITY,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  decodeEventRaw,
  normalizeTx,
  ownerDeltas,
  parseMeteoraTrades,
  parsePoolFacts,
  tokenDelta,
} from "../src/index.js";
import { EXPECTED } from "./expected.js";
import { FIXTURES } from "./fixtures/index.js";

const load = (name: string): ConfirmedTx => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as ConfirmedTx;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("constants", () => {
  it("PDAs re-derive from the program ids", () => {
    const pda = (seed: string, p: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(p))[0].toBase58();
    expect(pda("__event_authority", DBC_PROGRAM_ID)).toBe(DBC_EVENT_AUTHORITY);
    expect(pda("__event_authority", DAMM_V2_PROGRAM_ID)).toBe(DAMM_V2_EVENT_AUTHORITY);
    expect(pda("pool_authority", DBC_PROGRAM_ID)).toBe(DBC_POOL_AUTHORITY);
    expect(pda("pool_authority", DAMM_V2_PROGRAM_ID)).toBe(DAMM_V2_POOL_AUTHORITY);
  });
});

describe("fixtures: exact records", () => {
  for (const [name, exp] of Object.entries(EXPECTED)) {
    it(name, () => {
      const spec = FIXTURES.find((f) => f.name === name)!;
      const r = parseMeteoraTrades(load(name));
      expect(r.status).toBe("ok");
      expect(r.issues).toEqual([]);
      expect(r.signature).toBe(spec.signature);
      expect(r.version).toBe(exp.version);
      expect(r.trades.length).toBe(exp.trades.length);
      r.trades.forEach((t, i) => {
        const e = exp.trades[i];
        expect({
          ixKey: t.ixKey, topIx: t.topIx, innerIx: t.innerIx, venue: t.venue, side: t.side, app: t.app.app, pool: t.pool, baseMint: t.baseMint, quoteMint: t.quoteMint,
          trader: t.trader, traderSource: t.traderSource, feePayer: t.feePayer, swapAuthority: t.swapAuthority,
          baseAmount: t.baseAmount, quoteGross: t.quoteGross, quoteNet: t.quoteNet, fee: t.fee,
          referralTokenAccount: t.referralTokenAccount, curveComplete: t.curveComplete,
        }).toEqual(e);
        expect(t.signature).toBe(spec.signature);
        // the stored event re-decodes to the same thing
        expect(decodeEventRaw(t.venue, t.eventRaw)?.name).toBe("EvtSwap2");
      });
    });
  }
});

describe("fixtures: invariants re-checked against balances", () => {
  for (const name of Object.keys(EXPECTED)) {
    it(name, () => {
      const raw = load(name);
      const tx = normalizeTx(raw);
      const { trades } = parseMeteoraTrades(raw);
      // ixKey unique per tx
      expect(new Set(trades.map((t) => t.ixKey)).size).toBe(trades.length);
      for (const t of trades) {
        // fee arithmetic
        if (t.fee.onInput) expect(t.amountIn - t.amountInAfterFee).toBe(t.fee.total);
        else expect(t.amountIn).toBe(t.amountInAfterFee);
        expect(t.fee.total).toBe(t.fee.trading + t.fee.protocol + t.fee.referral + t.fee.compounding);
        // ticket price inputs: gross quote = net quote ± the quote-side fee
        const quoteFee = t.fee.token === "quote" ? t.fee.total : 0n;
        expect(t.quoteGross).toBe(t.side === "sell" ? t.quoteNet + quoteFee : t.quoteNet - (t.fee.onInput ? quoteFee : 0n));
        if (t.referralTokenAccount && t.fee.referral > 0n) expect(tokenDelta(tx, t.referralTokenAccount)).toBeGreaterThanOrEqual(t.fee.referral);
      }
      // every trade's pool vaults are in the tx's token balances (the parser's vault check ran on them)
      for (const t of trades) {
        const vaults = [...tx.tokenBalances.values()].filter((e) => (e.owner === DBC_POOL_AUTHORITY || e.owner === DAMM_V2_POOL_AUTHORITY) && (e.mint === t.baseMint || e.mint === t.quoteMint));
        expect(vaults.length).toBeGreaterThanOrEqual(2);
      }
    });
  }

  it("single direct swaps: the trader's own token accounts moved exactly baseAmount / quoteNet", () => {
    for (const name of ["dbc_direct_buy_quote_fee", "dbc_curve_complete", "damm_graduated_direct_buy", "damm_legacy_tx"]) {
      const raw = load(name);
      const tx = normalizeTx(raw);
      const [t] = parseMeteoraTrades(raw).trades;
      expect(ownerDeltas(tx, t.baseMint).get(t.trader!)).toBe(t.baseAmount);
      expect(ownerDeltas(tx, t.quoteMint).get(t.trader!)).toBe(-t.quoteNet);
    }
    for (const name of ["dbc_direct_sell", "dbc_axiom_sell_v1", "dbc_dflow_sell", "dbc_jupiter_sell_v1", "damm_direct_sell", "damm_axiom_sell_v1", "dbc_okx_sell"]) {
      const raw = load(name);
      const [t] = parseMeteoraTrades(raw).trades;
      expect(ownerDeltas(normalizeTx(raw), t.baseMint).get(t.trader!)).toBe(-t.baseAmount);
    }
  });

  it("WSOL-native sells: lamports received = quoteNet − tx fee (no app fee)", () => {
    for (const name of ["dbc_direct_sell", "damm_direct_sell"]) {
      const raw = load(name);
      const [t] = parseMeteoraTrades(raw).trades;
      expect(normalizeTx(raw).lamportDeltas.get(t.trader!)).toBe(t.quoteNet - BigInt(raw.meta!.fee!));
    }
  });
});

describe("encodings and versions", () => {
  it("jsonParsed yields the same records as json (v0 with lookup tables, and v1)", () => {
    for (const [a, b] of [["dbc_jupiter_buy", "dbc_jupiter_buy_parsed"], ["damm_axiom_buy_v1", "damm_axiom_buy_v1_parsed"]]) {
      const x = parseMeteoraTrades(load(a));
      const y = parseMeteoraTrades(load(b));
      expect(y.trades.length).toBe(1);
      expect(y.trades).toEqual(x.trades);
    }
  });

  it("version-1 transactions parse (no lookup tables, transactionConfig)", () => {
    for (const name of ["dbc_axiom_sell_v1", "dbc_jupiter_sell_v1", "damm_axiom_buy_v1", "damm_axiom_sell_v1", "damm_program_seller_v1"]) {
      const r = parseMeteoraTrades(load(name));
      expect(r.version).toBe(1);
      expect(r.trades.length).toBe(1);
    }
  });
});

describe("failed tx, pool facts", () => {
  it("a failed transaction yields no trades", () => {
    const r = parseMeteoraTrades(load("dbc_failed"));
    expect(r.status).toBe("failed");
    expect(r.trades).toEqual([]);
  });

  it("DBC pool creation and DBC → DAMM v2 migration", () => {
    expect(parsePoolFacts(load("dbc_pool_init")).dbcPools).toEqual([
      { pool: "7wqGhpe3rVqCYFxV5f3ninfmRLRsE4GvVBkCrBPLK6Rp", config: "7oZrYpk9qcCy13J68S2z6d5qhMRHDsSUMHv7dLpPf1uN", baseMint: "BQqBiNLXNVB3Y3h6yqGMvTgEfrYjFzUa2KHPUsaUpump", creator: "HSsUqEp3eZ5EckgEB7gEPitunLqnegRmhQT5PpaoQuCk" },
    ]);
    expect(parsePoolFacts(load("dbc_migration_damm_v2")).migrations).toEqual([
      {
        dbcPool: "7wqGhpe3rVqCYFxV5f3ninfmRLRsE4GvVBkCrBPLK6Rp",
        config: "7oZrYpk9qcCy13J68S2z6d5qhMRHDsSUMHv7dLpPf1uN",
        dammPool: "ApxZdXkBjKWomGyWBA3LcCzUkjhq4UcoiT2kVaj7WDUk",
        baseMint: "BQqBiNLXNVB3Y3h6yqGMvTgEfrYjFzUa2KHPUsaUpump",
        quoteMint: "So11111111111111111111111111111111111111112",
      },
    ]);
    // the curve-completing buy and the graduated pool's trades are on exactly these pools
    expect(parseMeteoraTrades(load("dbc_curve_complete")).trades[0].pool).toBe("7wqGhpe3rVqCYFxV5f3ninfmRLRsE4GvVBkCrBPLK6Rp");
    expect(parseMeteoraTrades(load("damm_graduated_direct_buy")).trades[0].pool).toBe("ApxZdXkBjKWomGyWBA3LcCzUkjhq4UcoiT2kVaj7WDUk");
  });

  it("DAMM v2 orientation can be pinned by known base mints", () => {
    const raw = load("damm_direct_sol_is_a");
    const def = parseMeteoraTrades(raw).trades[0];
    expect(def.baseIsTokenA).toBe(false);
    const forced = parseMeteoraTrades(raw, { baseMints: new Set(["So11111111111111111111111111111111111111112"]) }).trades[0];
    expect(forced.baseIsTokenA).toBe(true);
    expect(forced.side).toBe("sell");
    expect(forced.baseAmount).toBe(def.quoteNet);
  });
});

describe("fail closed", () => {
  it("a vault balance that disagrees with the event rejects the swap", () => {
    const raw = clone(load("dbc_direct_sell"));
    const tx = normalizeTx(raw);
    const [t] = parseMeteoraTrades(raw).trades;
    const quoteVault = [...tx.tokenBalances.values()].find((e) => e.owner === DBC_POOL_AUTHORITY && e.mint === t.quoteMint)!.account;
    const idx = tx.accountKeys.indexOf(quoteVault);
    const post = raw.meta!.postTokenBalances!.find((b) => b.accountIndex === idx)!;
    post.uiTokenAmount.amount = (BigInt(post.uiTokenAmount.amount) - 1n).toString();
    const r = parseMeteoraTrades(raw);
    expect(r.trades).toEqual([]);
    expect(r.issues.map((i) => i.code)).toEqual(["vault_mismatch"]);
  });

  it("an event not signed by the event authority is ignored", () => {
    const raw = clone(load("dbc_direct_sell"));
    const tx = normalizeTx(raw);
    // DBC emits EvtSwap + EvtSwap2 (+ EvtCurveComplete): re-point every one of them
    const evIxs = tx.flat.filter((i) => i.programId === DBC_PROGRAM_ID && i.accounts[0] === DBC_EVENT_AUTHORITY);
    expect(evIxs.length).toBe(2);
    for (const evIx of evIxs) {
      const group = raw.meta!.innerInstructions!.find((g) => g.index === evIx.topIx)!;
      (group.instructions[evIx.innerIx] as { accounts: number[] }).accounts = [tx.accountKeys.indexOf(tx.feePayer)];
    }
    expect(parseMeteoraTrades(raw).trades).toEqual([]);
  });

  it("a truncated event body is a decode issue, not a record", () => {
    const raw = clone(load("damm_direct_sell"));
    const tx = normalizeTx(raw);
    const evIx = tx.flat.find((i) => i.programId === DAMM_V2_PROGRAM_ID && i.accounts[0] === DAMM_V2_EVENT_AUTHORITY)!;
    const inner = raw.meta!.innerInstructions!.find((g) => g.index === evIx.topIx)!.instructions[evIx.innerIx] as { data: string };
    inner.data = bs58.encode(evIx.data!.subarray(0, evIx.data!.length - 8));
    const r = parseMeteoraTrades(raw);
    expect(r.trades).toEqual([]);
    expect(r.issues[0].code).toBe("event_decode");
  });

  it("missing stackHeight (very old RPC data) refuses to guess CPI parents", () => {
    const raw = clone(load("dbc_axiom_sell_v1"));
    for (const g of raw.meta!.innerInstructions!) for (const i of g.instructions as { stackHeight?: number | null }[]) delete i.stackHeight;
    const r = parseMeteoraTrades(raw);
    expect(r.trades).toEqual([]);
    expect(r.issues.every((i) => i.code === "no_stack_heights")).toBe(true);
  });

  it("garbage input is a tx_shape error", () => {
    const r = parseMeteoraTrades({ slot: 1, transaction: { signatures: ["x"], message: {} }, meta: { err: null } });
    expect(r.status).toBe("error");
    expect(r.issues[0].code).toBe("tx_shape");
  });
});
