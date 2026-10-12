/**
 * PoC for finding H-4: keeper `runQueues` (keeper/src/keeper.ts:474) decides to crank when
 * ANY queue entry fits the per-claim cap, but `FumpadClient.buildProcessQueue`
 * (sdk/src/client.ts:423) always passes quadruples for the FIRST 13 entries only.
 *
 * The program walks the whole queue with skip-ahead (process_queue.rs): an entry that
 * doesn't fit is skipped; an entry that fits but has no quadruple HALTS the walk. So when
 * the 13 head entries are all too large for the current pool (normal as the pool drains,
 * or forced by an attacker with large queued claims), every later fitting entry is
 * never paid by the keeper, while the keeper still:
 *   - sends a process_queue tx every QUEUE_INTERVAL_SECS (30 s) that pays nothing, and
 *   - re-creates (keeper-paid, ~0.00204 SOL rent each) any missing ATA of those 13 head
 *     owners first. An owner can close its empty ATA between runs and pocket the rent:
 *     up to 13 x 0.00204 SOL every 30 s, ~76 SOL/day, for as long as a later entry fits.
 *
 * Run (from services/):  node --import tsx --test ../security-review/services-poc/process-queue-stall.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { FumpadClient } from "../../services/sdk/src/client.ts";
import type { ClaimQueueAccount, QueueEntry } from "../../services/sdk/src/accounts.ts";

const BPS = 10_000n;

it("13 non-fitting head entries make every later fitting entry unreachable for the keeper", async () => {
  const mint = Keypair.generate().publicKey;
  const pool = 1_000_000n; // reward-vault balance
  const maxClaimPoolBps = 1_000n; // per-claim cap: 10% of the pool (illustrative)
  const cap = (pool * maxClaimPoolBps) / BPS;

  const big: QueueEntry[] = Array.from({ length: 13 }, (_, i) => ({ ticket: Keypair.generate().publicKey, owner: Keypair.generate().publicKey, amount: cap + 1n + BigInt(i), sellTs: BigInt(i) }));
  const small: QueueEntry = { ticket: Keypair.generate().publicKey, owner: Keypair.generate().publicKey, amount: cap / 2n, sellTs: 100n };
  const queue: ClaimQueueAccount = { mint, len: 14, totalOwed: 0n, entries: [...big, small] } as ClaimQueueAccount;

  const client = new FumpadClient({} as never);
  (client as unknown as { claimQueue: () => Promise<ClaimQueueAccount> }).claimQueue = async () => queue;

  // keeper.ts:474 — the keeper's gate: passes because `small` fits.
  const keeperWillCrank = queue.entries.some((e) => e.amount > 0n && e.amount <= cap && e.amount <= pool);
  assert.equal(keeperWillCrank, true);

  const b = await client.buildProcessQueue({ cranker: Keypair.generate().publicKey, mint });
  assert.ok(b);
  const ix = b.instructions[b.instructions.length - 1];
  // 8 fixed accounts + event_cpi (2), then quadruples [ticket, position, ata, escrow].
  const tickets = new Set(ix.keys.map((k) => k.pubkey.toBase58()));
  assert.equal(big.every((e) => tickets.has(e.ticket.toBase58())), true, "all 13 head entries get quadruples");
  assert.equal(tickets.has(small.ticket.toBase58()), false, "the only payable entry gets no quadruple → program halts there");
  // …and the keeper pre-creates ATAs for the 13 head owners on every run.
  assert.deepEqual(new Set(b.owners.map((o: PublicKey) => o.toBase58())), new Set(big.map((e) => e.owner.toBase58())));

  // Program walk (process_queue.rs) simulated: skip non-fitting, halt on fitting-without-quad.
  let paid = 0;
  let r = 0;
  const quads = big.map((e) => e.ticket.toBase58());
  for (const e of queue.entries) {
    const loaded = r < quads.length && quads[r] === e.ticket.toBase58();
    if (loaded) r++;
    const fits = e.amount <= cap;
    if (!fits) continue;
    if (!loaded) break; // halted
    paid++;
  }
  assert.equal(paid, 0, "keeper cranks forever, pays nothing");
});
