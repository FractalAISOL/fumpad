/**
 * PoC V7-M1 + V7-M2: the shared board's status was trusted without any signature.
 * STATUS: FIXED in e01899c — this file now asserts both attacks FAIL.
 *
 * (a) Was: attestors skipped every message whose board status was "landed" or "dropped" BEFORE checking the
 *     chain, so one DB writer could mark every honest message and halt 2-of-3 liveness.
 *     Fix: board rows are per-keeper HINTS (attest_hints); "landed" is decided only from the consumed marker
 *     at finalized, "dropped" only from the keeper's own simulation; a fresh "landed" hint defers a keeper's
 *     own submission once, for a bounded time. Per-keeper DB roles + RLS are the documented default
 *     (ATTEST_BOARD_RLS, services/README.md "Keeper board").
 * (b) Was: `PoolNotOfCoin` (a DAMM v2 sell between Meteora's migration and our `graduate`) dropped the
 *     message for all keepers forever.
 *     Fix: DAMM v2 sells aren't signed until the finalized Coin has `damm_pool`; PoolNotOfCoin /
 *     TooManyOpenTickets / TicketNotOpen are retried with back-off after a re-check, never dropped.
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/board-status-suppression.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import pino from "pino";

import type { EngineOutput } from "../../services/engine/src/index.ts";
import { type CoinAccount, DEFAULT_PARAMS, FUMPAD_ERROR, type GlobalAccount } from "../../services/sdk/src/index.ts";
import { Attestor, type ChainView, type SubmitResult } from "../../services/keeper/src/attest/attestor.ts";
import { MemoryBoard } from "../../services/keeper/src/attest/board.ts";
import type { Derivation } from "../../services/keeper/src/attest/derive.ts";

const log = pino({ level: "silent" });
const NOW = 1_800_000_000;
const keepers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const mint = Keypair.generate().publicKey;
const trader = Keypair.generate().publicKey;
const POOL = Keypair.generate().publicKey.toBase58();
const g = { keepers: keepers.map((k) => k.publicKey), keeperAddedAt: [0n, 0n, 0n], paused: 0, pauseExpiresAt: 0n, clusterTag: 2, params: DEFAULT_PARAMS } as unknown as GlobalAccount;
const baseCoin = { mint, dammPool: PublicKey.default, attestCursor: 0n, totalSupply: 1_000_000_000_000_000n } as unknown as CoinAccount;

const out = (venue: "dbc" | "damm_v2"): EngineOutput => ({
  mint: mint.toBase58(),
  sells: [
    {
      signature: bs58.encode(new Uint8Array(64).fill(9)),
      ixKey: 0,
      slot: 100,
      txIndex: -1,
      blockTime: NOW - 100,
      venue,
      pool: POOL,
      routed: false,
      trader: trader.toBase58(),
      baseAmount: 1_000_000_000n,
      quoteGross: 500_000_000n,
      ticket: { ticketTokens: 100n, ticketPriceQ64: 1n << 60n, usdCents: 7_500n, pythPublishTime: NOW - 102, executionQ64: 1n << 60n, referenceQ64: 1n << 60n, preSpotQ64: 1n << 60n },
      reason: null,
    },
  ],
  rebuys: [],
  issues: [],
  reference: { avgQ64: 0n, lastSpotQ64: 0n, updatedAt: 0n },
  lastKey: null,
});
const der = (o: EngineOutput): Derivation => ({ coin: { mint: mint.toBase58() } as never, output: o, maxSlot: 1_000, txCount: 1, history: [] });

class Chain implements ChainView {
  coin = baseCoin;
  async global() {
    return g;
  }
  async coins() {
    return [this.coin];
  }
  async accountsExist(keys: PublicKey[]) {
    return keys.map(() => false); // never consumed
  }
  async position() {
    return null;
  }
  async ticket() {
    return null;
  }
}
class Sub {
  calls: TransactionInstruction[][] = [];
  next: SubmitResult = { ok: true, signature: "tx" };
  async submit(_l: string, ixs: TransactionInstruction[]) {
    this.calls.push(ixs);
    return this.next;
  }
}

function setup(venue: "dbc" | "damm_v2") {
  let now = NOW;
  const board = new MemoryBoard(() => now * 1000);
  const sub = new Sub();
  const chain = new Chain();
  const atts = keepers.map((k) => new Attestor({ keeper: k, chain, derive: async () => der(out(venue)), board, submitter: sub, log, now: () => now }));
  return { board, sub, atts, chain, advance: (s: number) => (now += s) };
}

it("(a) one DB writer marks the honest message 'dropped' (and keeps re-stamping 'landed'): it is still submitted", async () => {
  const { board, sub, atts, advance } = setup("dbc");
  await atts[0].tick(); // first honest keeper publishes its signature
  const forge = async (status: string) => {
    for (const id of board.rows.keys()) for (const k of keepers) await board.setStatus(id, k.publicKey.toBase58(), status, "evil");
  };
  await forge("dropped");
  for (let i = 0; i < 3; i++) for (const a of atts) await a.tick();
  assert.ok(sub.calls.length >= 1, "'dropped' hints are ignored: submitted");
  // a fresh forged 'landed' hint can delay a NEW message at most once, for a bounded time
  const n = sub.calls.length;
  advance(3_600 * 2); // our own landing was never finalized (consumed stays false): it must be re-sent
  await forge("landed");
  for (const a of atts) await a.tick();
  advance(91);
  await forge("landed");
  for (const a of atts) await a.tick();
  assert.ok(sub.calls.length > n, "a forged 'landed' hint can't hold a message back");
});

it("(b) PoolNotOfCoin before `graduate`: not signed until Coin.damm_pool is set, then retried until it lands", async () => {
  const { sub, atts, chain, board, advance } = setup("damm_v2");
  for (const a of atts) await a.tick();
  assert.equal(board.rows.size, 0, "a DAMM sell isn't even signed before graduate");
  chain.coin = { ...baseCoin, dammPool: Keypair.generate().publicKey } as CoinAccount; // graduate recorded the pool
  sub.next = { ok: false, code: FUMPAD_ERROR.PoolNotOfCoin ?? 6035, error: "PoolNotOfCoin" }; // e.g. a lagging RPC
  for (const a of atts) await a.tick();
  for (const a of atts) await a.tick();
  const before = sub.calls.length;
  assert.ok(before >= 1, "submitted, rejected once");
  sub.next = { ok: true, signature: "tx" };
  advance(3_601);
  for (let i = 0; i < 3; i++) for (const a of atts) await a.tick();
  assert.ok(sub.calls.length > before, "retried after the back-off: the honest sell gets its ticket");
});
