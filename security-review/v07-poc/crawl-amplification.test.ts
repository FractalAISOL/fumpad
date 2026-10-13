/**
 * PoC V7-M6: attestor/watcher RPC cost per tick grew with every token account EVER created for a mint.
 * STATUS: FIXED in e01899c — this file now asserts the attack FAILS.
 *
 * Was: crawlMintHistory re-ran full `getSignaturesForAddress` pagination (no `until` cursor) for the mint and
 * every token account that ever held it, every tick, every coin, one coin after another; caches unbounded.
 * Spraying 1-unit transfers to N fresh accounts and closing them (rent refunded) cost the attacker only fees.
 * Fix:
 *  - incremental crawl (engine/src/fetch.ts): per-address `until` cursors kept across ticks; token accounts
 *    CLOSED at their latest tx are never asked again (a re-init lists the mint, so the mint's crawl re-opens
 *    them); a per-coin RPC budget resumes next tick (CrawlBudgetExceeded) instead of stalling;
 *  - attestor: coins derived in parallel (ATTEST_COIN_CONCURRENCY), coins with recent sells first, a tick
 *    budget, least recently derived next; bounded LRU caches (txs, block indices, prices).
 *  - Keeping N accounts OPEN still costs one cursor call each per tick, but costs the attacker N × rent.
 *  - API co-signature on register_coin (spam coins): contracts side (Params.launch_signer).
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/crawl-amplification.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { crawlMintHistory } from "../../services/engine/src/index.ts";
import type { ConfirmedTx, MeteoraRpc } from "../../services/meteora/src/index.ts";

const pk = () => Keypair.generate().publicKey.toBase58();

it("N sprayed-and-closed dust accounts: crawled once, then the next tick costs O(1) calls", async () => {
  const mint = pk();
  const N = 2_000;
  const accounts = Array.from({ length: N }, pk);
  const sig = () => bs58.encode(Keypair.generate().secretKey);
  const mk = (slot: number, keys: string[], pre: (string | null)[], post: (string | null)[]): ConfirmedTx =>
    ({
      slot,
      blockTime: 1_700_000_000 + slot,
      transaction: { signatures: [sig()], message: { accountKeys: [pk(), ...keys], header: { numRequiredSignatures: 1 }, instructions: [] } },
      meta: {
        err: null,
        preTokenBalances: keys.flatMap((_, i) => (pre[i] === null ? [] : [{ accountIndex: i + 1, mint, owner: "Evil", uiTokenAmount: { amount: pre[i] } }])),
        postTokenBalances: keys.flatMap((_, i) => (post[i] === null ? [] : [{ accountIndex: i + 1, mint, owner: "Evil", uiTokenAmount: { amount: post[i] } }])),
      },
    }) as unknown as ConfirmedTx;
  // spray: N accounts created with 1 unit (lists the mint), then all closed
  const spray = mk(100, [...accounts, mint], [...accounts.map(() => null), null], [...accounts.map(() => "1"), null]);
  const close = mk(101, accounts, accounts.map(() => "1"), accounts.map(() => null));
  const txs = [spray, close];
  let sigCalls = 0;
  const rpc = {
    getSlot: async () => 1_000,
    getSignaturesForAddress: async (addr: string, o: { until?: string }) => {
      sigCalls++;
      const out = [];
      for (const t of [...txs].sort((a, b) => b.slot - a.slot)) {
        if (!(t.transaction.message as { accountKeys: string[] }).accountKeys.includes(addr)) continue;
        if (t.transaction.signatures[0] === o.until) break;
        out.push({ signature: t.transaction.signatures[0], slot: t.slot, err: null, blockTime: t.blockTime });
      }
      return out;
    },
    getTransaction: async (s: string) => txs.find((t) => t.transaction.signatures[0] === s) ?? null,
    call: async () => ({ signatures: [] }),
  } as unknown as MeteoraRpc;
  const caches = { txCache: new Map(), blockIndexCache: new Map() };
  await crawlMintHistory(rpc, mint, caches);
  const first = sigCalls;
  sigCalls = 0;
  const again = await crawlMintHistory(rpc, mint, caches); // next tick, nothing new on chain
  assert.equal(first, N + 1, "first discovery crawls each account once");
  assert.equal(sigCalls, 1, "next tick: only the mint's cursor; closed dust accounts are never asked again");
  assert.equal(again.history.length, 2, "same history");
});
