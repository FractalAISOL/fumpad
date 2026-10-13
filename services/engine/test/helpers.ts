// Synthetic event builders for hand-checked engine cases.
import { WSOL_MINT } from "@fumpad/meteora";

import {
  type CoinFacts,
  DEFAULT_ENGINE_PARAMS,
  type EngineEvent,
  type EngineOutput,
  type EngineParams,
  type PythPrice,
  runEngine,
  type SwapEvent,
  TRANSFER_IX_KEY,
} from "../src/index.js";

export const MINT = "Mint111111111111111111111111111111111111111";
export const DBC = "DbcPoo1111111111111111111111111111111111111";
export const DAMM = "DammPoo111111111111111111111111111111111111";
export const CREATOR = "Creator1111111111111111111111111111111111111";
export const A = "AliceWa11et11111111111111111111111111111111";
export const B = "BobWa11et1111111111111111111111111111111111";
export const C = "Caro1Wa11et111111111111111111111111111111111";

/** sqrt 2^59 ↔ spot 2^54 = 2^64/1024: 1 lamport per 1024 base units. */
export const SQRT0 = 1n << 59n;
export const SPOT0 = 1n << 54n;
export const T0 = 1_700_000_000;

export const coin = (over: Partial<CoinFacts> = {}): CoinFacts => ({
  mint: MINT,
  creator: CREATOR,
  dbcPool: DBC,
  config: "Config1111111111111111111111111111111111111",
  startSqrtPrice: SQRT0,
  launchBlockTime: T0,
  launchSlot: 1_000,
  dammPool: null,
  ...over,
});

/** $150.00 exactly (conf 0), published 1 s before every block. */
export const usd150 = (t: number): PythPrice => ({ price: 150_00000000n, conf: 0n, expo: -8, publishTime: t - 1 });

let seq = 0;
export const sig = (label: string) => `${label}-${++seq}`;

export class Tape {
  events: EngineEvent[] = [];
  slot = 1_000;
  constructor(public t = T0) {}
  /** Advance time (and the slot). */
  wait(secs: number) {
    this.t += secs;
    this.slot += Math.max(1, Math.round(secs / 0.4));
    return this;
  }
  swap(side: "buy" | "sell", trader: string | null, base: bigint, quote: bigint, o: Partial<SwapEvent> & { signature?: string; ix?: number; txIndex?: number } = {}) {
    const signature = o.signature ?? sig(side);
    const e: SwapEvent = {
      kind: "swap",
      key: { slot: this.slot, txIndex: o.txIndex ?? -1, phase: 2, ixKey: o.ix ?? 0 },
      signature,
      blockTime: this.t,
      venue: o.venue ?? "dbc",
      pool: o.pool ?? DBC,
      side,
      trader,
      traderSource: o.traderSource ?? "base_owner_signer",
      baseAmount: base,
      quoteGross: quote,
      quoteMint: o.quoteMint ?? WSOL_MINT,
      nextSqrtPrice: o.nextSqrtPrice ?? SQRT0,
      routed: o.routed ?? false,
    };
    this.events.push(e);
    return signature;
  }
  /** Flat-market trade at SPOT0: `sol` lamports ↔ sol × 1024 base units. */
  buy(trader: string, sol: bigint, o: Parameters<Tape["swap"]>[4] = {}) {
    return this.swap("buy", trader, sol * 1024n, sol, o);
  }
  sell(trader: string, sol: bigint, o: Parameters<Tape["swap"]>[4] = {}) {
    return this.swap("sell", trader, sol * 1024n, sol, o);
  }
  transfer(owner: string, delta: bigint, o: { signature?: string; payout?: boolean; txIndex?: number } = {}) {
    const signature = o.signature ?? sig("xfer");
    this.events.push({ kind: "transfer", key: { slot: this.slot, txIndex: o.txIndex ?? -1, phase: delta < 0n ? 3 : 0, ixKey: TRANSFER_IX_KEY }, signature, blockTime: this.t, owner, delta, payout: o.payout ?? false });
    return signature;
  }
  run(params: Partial<EngineParams> = {}, pyth: (t: number) => PythPrice | null | undefined = usd150, c: Partial<CoinFacts> = {}): EngineOutput {
    const r = runEngine(coin(c), this.events, { ...DEFAULT_ENGINE_PARAMS, ...params }, pyth);
    if (!r.done) throw new Error(`missing prices ${r.missingPrices}`);
    return r.output;
  }
}

export const SOL = 1_000_000_000n;
