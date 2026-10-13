/**
 * PoC V7-H2 (owner change): token-account owner changes were invisible to the engine -> negative balance ->
 * the coin's history was "inconsistent" forever (same sticky freeze as the vault donation).
 * STATUS: FIXED in e01899c — this file now asserts the attack FAILS.
 *
 * A non-ATA Token-2022 account (InitializeAccount3 on a fresh keypair, no ImmutableOwner extension) can be
 * handed to another wallet with SetAuthority(AccountOwner). That tx moves no tokens; ownerDeltas used to
 * attribute per OWNER with the first owner it saw, so W kept the balance and V went negative when moving it.
 * Fix:
 *  - meteora/src/tx.ts ownerDeltas attributes per TOKEN ACCOUNT with its pre and post owner: an owner change
 *    moves the balance W -> V like a transfer (V: a fresh acquisition, pending; W: an outflow);
 *  - a negative balance that still happens (missing history) is scoped to that wallet (no ticket until it
 *    fully exits) + alerted; it never freezes the coin.
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/owner-change-negative-balance.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { buildEvents, DEFAULT_ENGINE_PARAMS, runEngine } from "../../services/engine/src/index.ts";
import { usd150 } from "../../services/engine/test/helpers.ts";
import type { ConfirmedTx } from "../../services/meteora/src/index.ts";

const pk = () => Keypair.generate().publicKey.toBase58();
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINT = pk();
const W = pk();
const V = pk();
const OTHER = pk();
const ACC = pk(); // the non-ATA token account
const ACC2 = pk();

/** Minimal legacy json tx with only token-balance metadata (what history.ts reads for transfers). */
function tx(slot: number, signer: string, bals: { acc: string; owner: string; preOwner?: string; pre: bigint | null; post: bigint | null }[]): ConfirmedTx {
  const keys = [signer, ...bals.map((b) => b.acc)];
  const tb = (which: "pre" | "post") =>
    bals
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b[which] !== null)
      .map(({ b, i }) => ({ accountIndex: i + 1, mint: MINT, owner: which === "pre" ? b.preOwner ?? b.owner : b.owner, programId: T22, uiTokenAmount: { amount: String(b[which]), decimals: 6 } }));
  return {
    slot,
    blockTime: 1_700_000_000 + slot,
    version: "legacy",
    transaction: { signatures: [bs58.encode(Keypair.generate().secretKey)], message: { accountKeys: keys, header: { numRequiredSignatures: 1 }, instructions: [] } },
    meta: { err: null, innerInstructions: [], preTokenBalances: tb("pre"), postTokenBalances: tb("post") },
  } as unknown as ConfirmedTx;
}

it("SetAuthority(AccountOwner) W->V, then V moves the tokens: balances follow the account, no negative balance", () => {
  const coin = { mint: MINT, creator: pk(), dbcPool: pk(), config: pk(), startSqrtPrice: 1n << 59n, launchBlockTime: 1_700_000_000, launchSlot: 0, dammPool: null };
  const h = [
    // W receives 1,000 tokens into ACC
    { tx: tx(10, OTHER, [{ acc: ACC, owner: W, pre: 0n, post: 1_000n }]), txIndex: -1 },
    // SetAuthority: owner W -> V (no balance change)
    { tx: tx(20, W, [{ acc: ACC, preOwner: W, owner: V, pre: 1_000n, post: 1_000n }]), txIndex: -1 },
    // V transfers the tokens out to another account
    { tx: tx(30, V, [{ acc: ACC, owner: V, pre: 1_000n, post: 0n }, { acc: ACC2, owner: OTHER, pre: 0n, post: 1_000n }]), txIndex: -1 },
  ];
  const events = buildEvents(coin, h);
  const ownerChange = events.filter((e) => e.kind === "transfer" && e.signature === h[1].tx.transaction.signatures[0]);
  assert.deepEqual(
    ownerChange.map((e) => (e.kind === "transfer" ? [e.owner, e.delta] : null)).sort(),
    [[V, 1_000n], [W, -1_000n]].sort(),
    "the owner change moves the balance W -> V",
  );
  const r = runEngine(coin, events, DEFAULT_ENGINE_PARAMS, usd150);
  assert.ok(r.done);
  assert.deepEqual(r.output.issues, [], "no negative balance, nothing frozen");
});

it("a negative balance that still happens (missing history) is scoped to that wallet", () => {
  const coin = { mint: MINT, creator: pk(), dbcPool: pk(), config: pk(), startSqrtPrice: 1n << 59n, launchBlockTime: 1_700_000_000, launchSlot: 0, dammPool: null };
  // V moves tokens it was never seen receiving
  const h = [{ tx: tx(30, V, [{ acc: ACC, owner: V, pre: 1_000n, post: 0n }, { acc: ACC2, owner: OTHER, pre: 0n, post: 1_000n }]), txIndex: -1 }];
  const r = runEngine(coin, buildEvents(coin, h), DEFAULT_ENGINE_PARAMS, usd150);
  assert.ok(r.done);
  assert.deepEqual(r.output.issues.map((i) => [i.kind, i.scope, i.wallet]), [["negative_balance", "wallet", V]]);
});
