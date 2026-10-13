/**
 * PoC V7-H1: a rebuy that happens BEFORE the sell's TicketAttested lands is never attested.
 *
 * engine.ts:158 copies `t.address` (null until the ticket_attested event is replayed) into the
 * RebuyDebit. Events are replayed in chain order, so a buy between the sell and its attestation
 * (normal latency: finalization ~13 s + attestor tick 15 s + 2 signatures + submit; minutes or hours
 * when the hourly cap defers it) is recorded with ticketAddress = null forever. records.ts:70 then
 * drops it ("the sell isn't attested yet") on every later tick, and the watcher (verify.ts:111/130)
 * also ignores debits with a null address. Result: sell -> instant buy-back keeps the full ticket;
 * the 7-day rebuy rule is defeated.
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

it("sell, buy back before attestation: ticket keeps its full size, no rebuy is ever signed", () => {
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
  assert.equal(out.rebuys[0].ticketAddress, null, "but recorded it with no ticket address");

  const now = t.t + 3600; // an hour later: the attested ticket is on chain, full size
  const c = candidates(MINT, out, { clusterTag: 2, now, maxAttestAgeSecs: 86_400 });
  assert.equal(c.filter((x) => x.kind === "rebuy").length, 0, "no rebuy debit will ever be signed");

  const v = verifyCoin(MINT, out, [], now, 900);
  assert.equal(v.missing.filter((m) => m.kind === "rebuy").length, 0, "watcher does not flag it either");
});
