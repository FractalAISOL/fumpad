/**
 * PoC V7-M6: attestor/watcher RPC cost per tick grows with every token account EVER created for a mint,
 * and coins are derived one after another every 15 s.
 *
 * fetch.ts crawlMintHistory re-runs `getSignaturesForAddress` (full pagination, no `until` cursor) for the
 * mint, the Coin PDA, every known ticket PDA and every token account that ever held the mint — on every
 * tick, for every coin (attestor.ts:155-166, sequential). Closed accounts stay in the set forever. An
 * attacker sprays 1-unit transfers to N fresh accounts and closes them (rent refunded, cost = tx fees,
 * ~10-20 accounts per tx) — or registers many coins on our allow-listed config (register_coin needs no API
 * co-signature) — and every keeper's tick goes from seconds to hours. Sells older than max_attest_age
 * (24 h) can then never be attested. Caches (txCache, blockIndexCache, priceCache) are also unbounded Maps.
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

it("each tick re-crawls every token account ever seen (N dust accounts -> N+1 calls per tick per coin)", async () => {
  const mint = pk();
  const N = 2_000;
  const accounts = Array.from({ length: N }, pk);
  const sig = bs58.encode(Keypair.generate().secretKey);
  // one spray tx: N accounts each received 1 unit (then closed in a later tx, not needed here)
  const spray: ConfirmedTx = {
    slot: 100,
    blockTime: 1_700_000_000,
    transaction: { signatures: [sig], message: { accountKeys: [pk(), ...accounts], header: { numRequiredSignatures: 1 }, instructions: [] } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: accounts.map((_, i) => ({ accountIndex: i + 1, mint, owner: pk(), uiTokenAmount: { amount: "1" } })) },
  } as unknown as ConfirmedTx;
  let sigCalls = 0;
  const rpc = {
    getSlot: async () => 1_000,
    getSignaturesForAddress: async () => {
      sigCalls++;
      return [{ signature: sig, slot: 100, err: null, blockTime: 1_700_000_000 }];
    },
    getTransaction: async () => spray,
    call: async () => ({ signatures: [sig] }),
  } as unknown as MeteoraRpc;
  const caches = { txCache: new Map(), blockIndexCache: new Map() };
  await crawlMintHistory(rpc, mint, caches);
  const first = sigCalls;
  sigCalls = 0;
  await crawlMintHistory(rpc, mint, caches); // next tick, nothing new on chain
  assert.equal(first, N + 1);
  assert.equal(sigCalls, N + 1, "no incremental cursor: the whole account set is re-crawled every tick");
});
