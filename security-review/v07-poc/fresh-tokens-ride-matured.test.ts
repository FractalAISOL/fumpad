/**
 * PoC V7-M4: fresh tokens ride on matured credit.
 * STATUS: FIXED in e01899c (design decision restored from v0.6) — this file now asserts the attack FAILS.
 *
 * v0.6 SPEC §5.2: "fresh tokens can't ride on matured credit ('buy elsewhere / receive -> dump' gets no
 * ticket)". In v0.7 every arrival is seen (pending) and plan_sell/debit_sold drew `matured` FIRST, so a
 * holder with M matured tokens could receive or buy X and dump X a second later for a full X ticket.
 * Fix (SPEC-v0.7 Clarifications 21): a sell draws on the wallet's most recently acquired (pending) tokens
 * first; only the remainder can come from matured tokens and count for the ticket
 * (engine/src/rules/position.ts planSell / debitSold).
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/fresh-tokens-ride-matured.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { A, B, SOL, Tape } from "../../services/engine/test/helpers.ts";

it("receive X from a sybil, sell X in the next slot: no ticket; the matured stock keeps its full credit", () => {
  const t = new Tape();
  t.buy(A, 10n * SOL); // A: 10 SOL worth, will mature
  t.buy(B, 2n * SOL); // B: the sybil
  t.wait(700);
  t.transfer(B, -2n * 1024n * SOL);
  t.transfer(A, 2n * 1024n * SOL); // A receives fresh tokens (separate tx)
  t.wait(1);
  const s = t.sell(A, 2n * SOL); // A dumps exactly the fresh tokens, 1 s later
  t.wait(1);
  const rest = t.sell(A, 10n * SOL); // the honest matured stock
  const o = t.run();
  const d = o.sells.find((x) => x.signature === s)!;
  assert.equal(d.ticket, null, "no ticket for the fresh tokens");
  assert.equal(d.reason, "not_matured");
  assert.equal(o.sells.find((x) => x.signature === rest)!.ticket?.ticketTokens, 10n * 1024n * SOL, "matured tokens still count in full");
});

it("buy X, sell X 1 s later (separate txs): no ticket", () => {
  const t = new Tape();
  t.buy(A, 10n * SOL);
  t.wait(700);
  t.buy(A, 2n * SOL);
  t.wait(1);
  const s = t.sell(A, 2n * SOL);
  const d = t.run().sells.find((x) => x.signature === s)!;
  assert.equal(d.ticket, null);
  assert.equal(d.reason, "not_matured");
});
