/**
 * PoC V7-H2 (vault donation): anyone could permanently stop ticket attestation for any coin with one cheap tx.
 * STATUS: FIXED in e01899c — this file now asserts the attack FAILS.
 *
 * Attack tx = [any swap on the coin's DBC (or DAMM v2) pool] + [Token-2022 TransferChecked of 1 base unit
 * from the attacker's account INTO the pool's base vault]. Was: the vault cross-check saw event delta + 1,
 * rejected the swap with a pool-less `vault_mismatch` issue, and the engine's sticky `inconsistent` flag
 * gave every later sell of the coin `history_inconsistent`, forever, on every keeper and the watcher.
 * Fix:
 *  - meteora/src/vaultflow.ts: the cross-check adds every vault movement NOT made by the swaps (donations,
 *    pool-program fee claims / migration / leftover, launch mints, SyncNative) → the swap stays a record;
 *  - an unexplained delta is still an issue, now carrying the pool, and the engine scopes it (V7-H2): that
 *    tx's sells + one D10 window — never the coin. records.ts cuts off only on coin-scope issues.
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

type Msg = { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string; stackHeight?: number }[] };

/** The real attack tx: dbc_direct_sell + TransferChecked(seller ATA → base vault, 1) — instruction AND balances. */
function attackTx(withInstruction = true) {
  const tx = fixture("dbc_direct_sell");
  const trade = parseMeteoraTrades(tx).trades[0];
  const evil = JSON.parse(JSON.stringify(tx)) as ConfirmedTx;
  const m = evil.transaction.message as Msg;
  const keys = m.accountKeys;
  const post = evil.meta!.postTokenBalances!;
  const sellerAcc = post.find((b) => keys[b.accountIndex] === trade.inputTokenAccount)!;
  const vaultAcc = post.find((b) => b.owner === "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM" && b.mint === trade.baseMint)!;
  sellerAcc.uiTokenAmount.amount = String(BigInt(sellerAcc.uiTokenAmount.amount) - 1n);
  vaultAcc.uiTokenAmount.amount = String(BigInt(vaultAcc.uiTokenAmount.amount) + 1n);
  if (withInstruction) {
    const amount = new Uint8Array(8);
    amount[0] = 1;
    m.instructions.push({
      programIdIndex: keys.indexOf("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      accounts: [sellerAcc.accountIndex, keys.indexOf(trade.baseMint), vaultAcc.accountIndex, 0],
      data: bs58.encode(Uint8Array.from([12, ...amount, 6])),
      stackHeight: 1,
    });
  }
  return { tx, trade, evil };
}

it("1 base unit donated to the vault in a swap tx: the swap is still a record, nothing freezes", () => {
  const { tx, trade, evil } = attackTx();
  const r = parseMeteoraTrades(evil);
  assert.equal(r.trades.length, 1, "swap accepted (the donation is an explained vault movement)");
  assert.deepEqual(r.issues, []);

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
  assert.equal(evs.filter((e) => e.kind === "parse_issue").length, 0, "no parse_issue for our coin");

  // The coin's history: an honest holder A bought long before; the attacker's tx; A sells afterwards.
  const A = Keypair.generate().publicKey.toBase58();
  const t = new Tape(tx.blockTime! - 3_600);
  t.slot = tx.slot - 9_000;
  t.buy(A, 10n * SOL, { pool: trade.pool, signature: bs58.encode(Keypair.generate().secretKey) });
  t.wait(7_200);
  t.slot = tx.slot + 1_000; // after the attack
  const sellSig = t.sell(A, 2n * SOL, { pool: trade.pool, signature: bs58.encode(Keypair.generate().secretKey) });
  const res = runEngine({ ...coinFacts }, [...t.events, ...evs], DEFAULT_ENGINE_PARAMS, usd150);
  assert.ok(res.done);
  assert.ok(res.output.sells.find((s) => s.signature === sellSig)!.ticket, "honest sell after the attack: ticket");
  const c = candidates(coinFacts.mint, res.output, { clusterTag: 0, now: t.t + 60, maxAttestAgeSecs: 86_400 });
  assert.ok(c.some((x) => x.signature === sellSig), "and it is signed");
});

it("even an UNEXPLAINED vault delta is scoped: the issue names the pool and blocks one tx + one D10 window only", () => {
  const { tx, trade, evil } = attackTx(false); // balances only (not producible on chain; models any parser gap)
  const r = parseMeteoraTrades(evil);
  assert.equal(r.trades.length, 0);
  assert.equal(r.issues[0].code, "vault_mismatch");
  assert.equal(r.issues[0].pool, trade.pool, "issue carries the pool");
  const coinFacts = { mint: trade.baseMint, creator: Keypair.generate().publicKey.toBase58(), dbcPool: trade.pool, config: trade.config!, startSqrtPrice: 1n << 59n, launchBlockTime: tx.blockTime! - 86_400, launchSlot: tx.slot - 200_000, dammPool: null };
  const pi = buildEvents(coinFacts, [{ tx: evil, txIndex: -1 }]).find((e) => e.kind === "parse_issue")!;
  const A = Keypair.generate().publicKey.toBase58();
  const t = new Tape(tx.blockTime! - 3_600);
  t.slot = tx.slot - 9_000;
  t.buy(A, 10n * SOL, { pool: trade.pool, signature: bs58.encode(Keypair.generate().secretKey) });
  t.wait(3_600 + 700); // > one D10 window after the issue
  t.slot = tx.slot + 2_000;
  t.sell(A, SOL, { pool: trade.pool, signature: bs58.encode(Keypair.generate().secretKey) }); // first verified swap: stale pre-trade spot
  t.wait(1);
  const later = t.sell(A, SOL, { pool: trade.pool, signature: bs58.encode(Keypair.generate().secretKey) });
  const res = runEngine({ ...coinFacts }, [...t.events, pi], DEFAULT_ENGINE_PARAMS, usd150);
  assert.ok(res.done);
  assert.deepEqual(res.output.issues.map((i) => i.scope), ["tx"]);
  assert.ok(res.output.sells.find((s) => s.signature === later)!.ticket, "later sells get tickets again");
});
