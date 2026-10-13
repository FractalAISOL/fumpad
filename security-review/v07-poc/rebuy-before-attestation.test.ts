/**
 * PoC V7-H1: a rebuy that happens BEFORE the sell's TicketAttested lands is never attested.
 * STATUS: FIXED in e01899c — this file now asserts the attack FAILS.
 *
 * Was: engine.ts copied `t.address` (null until the ticket_attested event is replayed) into the
 * RebuyDebit, so a buy between the sell and its attestation was recorded with ticketAddress = null
 * forever; records.ts dropped it and the watcher ignored it ("sell, buy back next slot" kept a full ticket).
 * Fix: the engine resolves every debit's ticket address from the ticket's FINAL state after the replay
 * (engine.ts, "V7-H1"), so the debit is signed as soon as the ticket exists on chain, and the watcher
 * reports it as missing if it never lands.
 *
 * Run (from services/):  node --import tsx --test ../security-review/v07-poc/rebuy-before-attestation.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { SOL, Tape } from "../../services/engine/test/helpers.ts";
import { candidates } from "../../services/keeper/src/attest/records.ts";
import { verifyCoin } from "../../services/keeper/src/watch/verify.ts";

const pk = () => Keypair.generate().publicKey.toBase58();
const txSig = () => bs58.encode(Keypair.generate().secretKey); // 64 random bytes
const MINT = pk();
const PDA = pk();
const A = pk();

it("sell, buy back before attestation: the debit IS signed against the attested ticket", () => {
  const t = new Tape();
  t.buy(A, 10n * SOL, { signature: txSig() });
  t.wait(700); // matured
  const sellSig = t.sell(A, 2n * SOL, { signature: txSig() }); // ~$300 sell -> ticket
  t.wait(2);
  t.buy(A, 2n * SOL, { signature: txSig() }); // immediate buy-back, 2 s later (attestation not landed yet)
  t.wait(40);
  // the keepers attest the sell 42 s after it
  t.events.push({ kind: "ticket_attested", key: { slot: t.slot, txIndex: -1, phase: 4, ixKey: 0 }, signature: "att", blockTime: t.t, ref: { signature: sellSig, ixKey: 0 }, ticket: PDA });

  const out = t.run({ trackAttestations: true });
  const sell = out.sells.find((s) => s.signature === sellSig)!;
  assert.ok(sell.ticket, "sell made a ticket");
  assert.equal(out.rebuys.length, 1, "engine did see the rebuy");
  assert.equal(out.rebuys[0].voided, true, "engine voided the ticket internally");
  assert.equal(out.rebuys[0].ticketAddress, PDA, "the debit carries the attested ticket's address");

  const now = t.t + 3600; // an hour later: the attested ticket is on chain
  const c = candidates(MINT, out, { clusterTag: 2, now, maxAttestAgeSecs: 86_400 });
  const rebuys = c.filter((x) => x.kind === "rebuy");
  assert.equal(rebuys.length, 1, "the rebuy debit is signed");
  assert.equal(rebuys[0].rebuy!.debitTokens, 2n * 1024n * SOL, "for the full bought-back amount (voids the ticket)");

  const v = verifyCoin(MINT, out, [], now, 900);
  assert.equal(v.missing.filter((m) => m.kind === "rebuy").length, 1, "and the watcher flags it until it lands");
});
