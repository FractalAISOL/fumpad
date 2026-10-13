// Item 11: keeper attestation data source — extract trader, side, exact amounts in/out and fees for any DBC or
// DAMM v2 swap from a confirmed transaction, whether the swap was top-level (Axiom/Jupiter/bots/SDK) or a CPI
// (FUMPAD router, aggregators).
//
// Mechanism: both programs use Anchor `emit_cpi!` — the event is a self-CPI inner instruction to the venue program
// whose data = EVENT_IX_TAG_LE (8) ‖ sha256("event:<Name>")[..8] ‖ borsh(event). The trader is NOT in the event;
// it is the `payer` account of the swap instruction that emitted it (DBC index 9, DAMM v2 index 8), and the swap
// instruction is the self-CPI's parent (the closest preceding venue instruction with a swap discriminator, at a
// lower stack height). Events are only inside the tx meta (innerInstructions), never in program logs, so log
// truncation can't drop them.
import crypto from "node:crypto";
import bs58 from "bs58";
import { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";

export const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2 = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const EVENT_IX_TAG_LE = Buffer.from("e445a52e51cb9a1d", "hex");
const evDisc = (n: string) => crypto.createHash("sha256").update(`event:${n}`).digest().subarray(0, 8);
const ixDisc = (n: string) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const SWAP_DISCS = [ixDisc("swap"), ixDisc("swap2"), ixDisc("swap2_with_transfer_hook")];
const D_EVT_SWAP3 = evDisc("EvtSwap3");
const D_EVT_SWAP3_TH = evDisc("EvtSwap3WithTransferHook");
const D_EVT_SWAP2 = evDisc("EvtSwap2"); // DAMM v2 (and DBC legacy, layout differs per program)
const D_EVT_CURVE_COMPLETE = evDisc("EvtCurveComplete");

class R {
  o = 0;
  constructor(public b: Buffer) {}
  pk() { const v = new PublicKey(this.b.subarray(this.o, this.o + 32)); this.o += 32; return v.toBase58(); }
  u8() { return this.b[this.o++]; }
  bool() { return this.b[this.o++] === 1; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  u128() { const lo = this.b.readBigUInt64LE(this.o), hi = this.b.readBigUInt64LE(this.o + 8); this.o += 16; return (hi << 64n) | lo; }
}

export type ParsedSwap = {
  venue: "dbc" | "damm_v2";
  pool: string;
  trader: string; // payer/signer of the venue swap instruction
  side: "buy" | "sell"; // buy = quote->base (SOL in), sell = base->quote
  amountIn: bigint; // what left the trader (incl. fee, incl. transfer fee)
  amountOut: bigint; // what the trader received (after fee, after transfer fee)
  tradingFee: bigint; // LP/partner+creator share (DBC: trading_fee; DAMM: claiming_fee + compounding_fee)
  protocolFee: bigint;
  referralFee: bigint;
  feeToken: "quote" | "base";
  nextSqrtPrice: bigint;
  topLevel: boolean; // swap called directly (true) or via CPI (false)
  viaProgram: string | null; // the program that CPI'd into the venue, if any
  timestamp: bigint;
  curveComplete?: boolean;
};

type FlatIx = { programId: string; accounts: string[]; data: Buffer; stackHeight: number; outerIndex: number; inner: boolean };

function flatten(tx: VersionedTransactionResponse): FlatIx[] {
  const msg = tx.transaction.message;
  const keys = [
    ...msg.staticAccountKeys.map((k) => k.toBase58()),
    ...(tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
    ...(tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
  ];
  const out: FlatIx[] = [];
  msg.compiledInstructions.forEach((ix, i) => {
    out.push({ programId: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map((k) => keys[k]), data: Buffer.from(ix.data), stackHeight: 1, outerIndex: i, inner: false });
    const inner = tx.meta?.innerInstructions?.find((x) => x.index === i);
    for (const iix of inner?.instructions ?? []) {
      out.push({
        programId: keys[iix.programIdIndex],
        accounts: iix.accounts.map((k) => keys[k]),
        data: Buffer.from(bs58.decode(iix.data)),
        stackHeight: (iix as any).stackHeight ?? 2,
        outerIndex: i,
        inner: true,
      });
    }
  });
  return out;
}

export function parseSwaps(tx: VersionedTransactionResponse): ParsedSwap[] {
  if (!tx.meta || tx.meta.err) return [];
  const ixs = flatten(tx);
  const res: ParsedSwap[] = [];
  const dbcV3Parents = new Set<number>();
  const dbcV2: { parentIdx: number; swap: ParsedSwap }[] = [];
  let lastSwap: { ix: FlatIx; idx: number } | null = null;
  ixs.forEach((ix, idx) => {
    const isVenue = ix.programId === DBC || ix.programId === DAMM_V2;
    if (!isVenue) return;
    if (SWAP_DISCS.some((d) => ix.data.subarray(0, 8).equals(d))) { lastSwap = { ix, idx }; return; }
    if (!ix.data.subarray(0, 8).equals(EVENT_IX_TAG_LE)) return;
    const disc = ix.data.subarray(8, 16);
    const body = ix.data.subarray(16);
    const parent = lastSwap as { ix: FlatIx; idx: number } | null;
    if (!parent || parent.ix.programId !== ix.programId) return;
    // the program that invoked the venue swap (if CPI): nearest preceding ix at stackHeight-1 in the same outer ix
    let via: string | null = null;
    if (parent.ix.stackHeight > 1) {
      for (let j = parent.idx - 1; j >= 0; j--) {
        if (ixs[j].outerIndex !== parent.ix.outerIndex) break;
        if (ixs[j].stackHeight === parent.ix.stackHeight - 1) { via = ixs[j].programId; break; }
      }
    }
    if (ix.programId === DBC && (disc.equals(D_EVT_SWAP3) || disc.equals(D_EVT_SWAP3_TH))) {
      const r = new R(body);
      const pool = r.pk(); r.pk(); // config
      const dir = r.u8(); r.u8(); // swap_mode
      const hasRef = r.bool(); const feeOnBase = r.bool();
      const inclIn = r.u64(); r.u64(); r.u64(); const exclOut = r.u64();
      const tradingFee = r.u64(), protocolFee = r.u64(), referralFee = r.u64();
      const nextSqrtPrice = r.u128(); r.u64(); const ts = r.u64();
      void hasRef;
      dbcV3Parents.add(parent.idx);
      res.push({
        venue: "dbc", pool, trader: parent.ix.accounts[9], side: dir === 1 ? "buy" : "sell",
        amountIn: inclIn, amountOut: exclOut, tradingFee, protocolFee, referralFee, feeToken: feeOnBase ? "base" : "quote",
        nextSqrtPrice, topLevel: !parent.ix.inner, viaProgram: via, timestamp: ts,
      });
    } else if (ix.programId === DBC && disc.equals(D_EVT_SWAP2)) {
      // DBC <= 0.2.1 (mainnet as of 2026-10-12) has no EvtSwap3; EvtSwap2 carries the same numbers (no transfer-fee
      // fields; DBC base mints have no transfer fee in FUMPAD's config). Emitted before EvtSwap3 on 0.2.2.
      const r = new R(body);
      const pool = r.pk(); r.pk();
      const dir = r.u8(); r.bool();
      r.u64(); r.u64(); r.u8(); // swap_parameters
      const inclFeeIn = r.u64(); r.u64(); r.u64(); const out = r.u64();
      const nextSqrtPrice = r.u128(); const tradingFee = r.u64(), protocolFee = r.u64(), referralFee = r.u64();
      r.u64(); r.u64(); const ts = r.u64();
      dbcV2.push({
        parentIdx: parent.idx,
        swap: {
          venue: "dbc", pool, trader: parent.ix.accounts[9], side: dir === 1 ? "buy" : "sell", amountIn: inclFeeIn, amountOut: out,
          tradingFee, protocolFee, referralFee, feeToken: "quote", nextSqrtPrice, topLevel: !parent.ix.inner, viaProgram: via, timestamp: ts,
        },
      });
    } else if (ix.programId === DBC && disc.equals(D_EVT_CURVE_COMPLETE)) {
      if (res.length) res[res.length - 1].curveComplete = true;
    } else if (ix.programId === DAMM_V2 && disc.equals(D_EVT_SWAP2)) {
      const r = new R(body);
      const pool = r.pk(); const dir = r.u8(); const cfm = r.u8(); r.bool();
      r.u64(); r.u64(); r.u8(); // params
      r.u64(); r.u64(); r.u64(); r.u64(); // swap_result: included_fee_input, excluded_fee_input, amount_left, output
      const nextSqrtPrice = r.u128(); const claiming = r.u64(); const protocolFee = r.u64(); const compounding = r.u64(); const referralFee = r.u64();
      const inclTfIn = r.u64(); r.u64(); const exclTfOut = r.u64(); const ts = r.u64();
      // DAMM v2 trade_direction: 0 = AtoB (base->quote, sell), 1 = BtoA (buy). OnlyB/Compounding: fee in token B.
      res.push({
        venue: "damm_v2", pool, trader: parent.ix.accounts[8], side: dir === 1 ? "buy" : "sell",
        amountIn: inclTfIn, amountOut: exclTfOut, tradingFee: claiming + compounding, protocolFee, referralFee,
        feeToken: cfm === 0 ? (dir === 1 ? "base" : "quote") : "quote", nextSqrtPrice, topLevel: !parent.ix.inner, viaProgram: via, timestamp: ts,
      });
    }
  });
  // mainnet fallback: use DBC EvtSwap2 only for swaps that emitted no EvtSwap3
  for (const v of dbcV2) if (!dbcV3Parents.has(v.parentIdx)) res.push(v.swap);
  return res;
}

/** Same as parseSwaps but DBC from EvtSwap2 only (to prove the mainnet-0.2.1 fallback matches EvtSwap3). */
export function parseSwapsDbcV2Only(tx: VersionedTransactionResponse): ParsedSwap[] {
  const D3 = D_EVT_SWAP3;
  const clone = JSON.parse(JSON.stringify(tx));
  for (const g of clone.meta.innerInstructions ?? []) {
    g.instructions = g.instructions.filter((i: any) => {
      const d = Buffer.from(bs58.decode(i.data));
      return !(d.subarray(0, 8).equals(EVENT_IX_TAG_LE) && d.subarray(8, 16).equals(D3));
    });
  }
  clone.transaction.message = tx.transaction.message;
  return parseSwaps(clone);
}

export const fmt = (s: ParsedSwap) => JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v));
