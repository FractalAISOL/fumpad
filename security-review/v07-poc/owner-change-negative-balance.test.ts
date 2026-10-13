/**
 * PoC V7-H2 (owner change): token-account owner changes are invisible to the engine -> negative balance -> the coin's
 * history is "inconsistent" forever (same sticky freeze as the vault donation).
 *
 * A non-ATA Token-2022 account (InitializeAccount3 on a fresh keypair, no ImmutableOwner extension) can be
 * handed to another wallet with SetAuthority(AccountOwner). That tx moves no tokens: history.ts derives
 * transfers from per-OWNER deltas, normalizeTx keeps only the first owner it sees, so W keeps the
 * balance in the engine while V really owns it. When V moves or sells the tokens, V's engine balance goes
 * negative -> engine.ts:236 / :281 set `inconsistent = true` -> no ticket for anyone on the coin again.
 * (W also keeps a phantom matured balance; V never had one.)
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

it("SetAuthority(AccountOwner) W->V, then V moves the tokens: negative balance, coin frozen", () => {
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
  const r = runEngine(coin, events, DEFAULT_ENGINE_PARAMS, usd150);
  assert.ok(r.done);
  const neg = r.output.issues.find((i) => i.kind === "negative_balance");
  assert.ok(neg, "engine reports a negative balance");
  assert.match(neg!.detail, new RegExp(V));
});
