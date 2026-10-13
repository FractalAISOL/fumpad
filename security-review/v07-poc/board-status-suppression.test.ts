/**
 * PoC V7-M1 + V7-M2: the shared board's `attest_status` is trusted without any signature.
 *
 * (a) attestor.ts:180-181 skips every message whose board status is "landed" or "dropped", BEFORE checking
 *     the chain. Anyone with write access to the shared Postgres (one compromised keeper — all three share
 *     the board and the README's per-keeper RLS is "optional" and doesn't cover attest_status — or a leaked
 *     DATABASE_URL) can mark every message as soon as the first honest keeper publishes it: no honest sell
 *     is ever attested again. The board header claims "whoever controls the database can only withhold or
 *     spam signatures"; the status table breaks that — a single keeper can halt 2-of-3 liveness.
 * (b) attestor.ts:263-268: a "permanent" program error marks the message "dropped" for ALL keepers forever.
 *     `PoolNotOfCoin` is not permanent: a DAMM v2 sell between DBC migration (Meteora's keepers) and our
 *     `graduate` (Coin.damm_pool still default) — the engine learns the DAMM pool from the migration tx
 *     (history.ts:81-85) — is rejected once and then never retried after graduate records the pool.
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/board-status-suppression.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { Keypair, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
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
const coin = { mint, attestBucketStart: 0n, attestBucketTokens: 0n, attestPrevBucketTokens: 0n, totalSupply: 1_000_000_000_000_000n } as CoinAccount;

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
  async global() {
    return g;
  }
  async coins() {
    return [coin];
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
  const board = new MemoryBoard(() => NOW * 1000);
  const sub = new Sub();
  const atts = keepers.map((k) => new Attestor({ keeper: k, chain: new Chain(), derive: async () => der(out(venue)), board, submitter: sub, log, now: () => NOW }));
  return { board, sub, atts };
}

it("(a) one DB writer marks the honest message 'dropped': no keeper ever submits it", async () => {
  const { board, sub, atts } = setup("dbc");
  await atts[0].tick(); // first honest keeper publishes its signature
  for (const id of board.rows.keys()) await board.setStatus(id, "dropped", "evil"); // attacker: one UPDATE
  for (let i = 0; i < 3; i++) for (const a of atts) await a.tick();
  assert.equal(sub.calls.length, 0, "2 honest keepers agree, but nothing is ever submitted");
});

it("(b) PoolNotOfCoin before `graduate` drops a valid DAMM sell for good", async () => {
  const { sub, atts } = setup("damm_v2");
  sub.next = { ok: false, code: FUMPAD_ERROR.PoolNotOfCoin ?? 6035, error: "PoolNotOfCoin" };
  for (const a of atts) await a.tick();
  for (const a of atts) await a.tick();
  const before = sub.calls.length;
  assert.ok(before >= 1, "submitted once, rejected (Coin.damm_pool not recorded yet)");
  sub.next = { ok: true, signature: "tx" }; // graduate has now recorded the DAMM pool
  for (let i = 0; i < 3; i++) for (const a of atts) await a.tick();
  assert.equal(sub.calls.length, before, "never retried: the honest sell never gets its ticket");
});
