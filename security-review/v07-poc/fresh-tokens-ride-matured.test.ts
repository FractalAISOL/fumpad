/**
 * PoC V7-M4: fresh tokens ride on matured credit.
 *
 * v0.6 SPEC §5.2 (L155): tokens that arrived unseen "are untracked and a sell draws on them first, so fresh
 * tokens can't ride on matured credit ('buy elsewhere / receive -> dump' gets no ticket)". In v0.7 every
 * arrival is seen (buys on any app + transfers in -> observe_buy -> `pending`), and plan_sell/debit_sold
 * draw `matured` FIRST. So a holder with M matured tokens can receive (or buy) X fresh tokens and dump them
 * at once for a full X-token ticket while keeping the M position, every 10 minutes, up to 5 open tickets
 * per wallet, across any number of wallets. The rebuy rule only looks at acquisitions AFTER a sell.
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/fresh-tokens-ride-matured.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { A, B, SOL, Tape } from "../../services/engine/test/helpers.ts";

it("receive X from a sybil, sell X in the next slot: ticket for X, matured stock untouched in size", () => {
  const t = new Tape();
  t.buy(A, 10n * SOL); // A: 10 SOL worth, will mature
  t.buy(B, 2n * SOL); // B: the sybil
  t.wait(700);
  t.transfer(B, -2n * 1024n * SOL);
  t.transfer(A, 2n * 1024n * SOL); // A receives fresh tokens (separate tx)
  t.wait(1);
  const s = t.sell(A, 2n * SOL); // A dumps exactly the fresh tokens, 1 s later
  const o = t.run();
  const d = o.sells.find((x) => x.signature === s)!;
  assert.ok(d.ticket, "ticket created");
  assert.equal(d.ticket!.ticketTokens, 2n * 1024n * SOL, "full size, charged against A's matured stock");
});

it("buy X, sell X 1 s later (separate txs): full ticket", () => {
  const t = new Tape();
  t.buy(A, 10n * SOL);
  t.wait(700);
  t.buy(A, 2n * SOL);
  t.wait(1);
  const s = t.sell(A, 2n * SOL);
  const d = t.run().sells.find((x) => x.signature === s)!;
  assert.equal(d.ticket?.ticketTokens, 2n * 1024n * SOL);
});
