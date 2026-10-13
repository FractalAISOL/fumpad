// records.ts: V7-H1 (a buy-back BEFORE the sell's attestation is still signed and watched) and V7-H2
// (only coin-scope engine issues cut a coin off; tx / wallet issues are left to the engine's decisions).
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import type { EngineOutput } from "@fumpad/engine";

import { SOL, Tape } from "../../engine/test/helpers.js";
import { candidates } from "../src/attest/records.js";
import { verifyCoin } from "../src/watch/verify.js";

const MINT = Keypair.generate().publicKey.toBase58();
const PDA = Keypair.generate().publicKey.toBase58();
const s64 = () => bs58.encode(Keypair.generate().secretKey);
const pk = () => Keypair.generate().publicKey.toBase58();

describe("V7-H1 rebuy before attestation", () => {
  it("the debit is signed once the ticket is attested, and the watcher flags it if it never lands", () => {
    const t = new Tape();
    const w = pk();
    t.buy(w, 10n * SOL, { signature: s64() });
    t.wait(700);
    const sell = t.sell(w, 2n * SOL, { signature: s64() });
    t.wait(2).buy(w, 2n * SOL, { signature: s64() });
    t.wait(40);
    t.events.push({ kind: "ticket_attested", key: { slot: t.slot, txIndex: -1, phase: 4, ixKey: 0 }, signature: "att", blockTime: t.t, ref: { signature: sell, ixKey: 0 }, ticket: PDA });
    const out = t.run({ trackAttestations: true });
    const now = t.t + 600;
    const c = candidates(MINT, out, { clusterTag: 2, now, maxAttestAgeSecs: 86_400 });
    const rebuys = c.filter((x) => x.kind === "rebuy");
    expect(rebuys).toHaveLength(1);
    expect(rebuys[0].rebuy!.ticket.toBase58()).toBe(PDA);
    expect(rebuys[0].rebuy!.debitTokens).toBe(2n * 1024n * SOL);
    const v = verifyCoin(MINT, out, [], now + 1_000, 900);
    expect(v.missing.filter((m) => m.kind === "rebuy")).toHaveLength(1);
  });
});

describe("V7-H2 scoped cut-off", () => {
  const A = pk();
  const B = pk();
  const base = (): EngineOutput => {
    const t = new Tape();
    t.buy(A, SOL, { signature: s64() });
    t.buy(B, SOL, { signature: s64() });
    t.wait(700);
    t.sell(A, SOL, { signature: s64() });
    t.sell(B, SOL, { signature: s64() });
    return t.run();
  };
  it("wallet / tx issues don't block other sells", () => {
    const o = base();
    o.issues.push({ signature: "x", slot: 0, kind: "negative_balance", scope: "wallet", wallet: "Someone", detail: "" });
    o.issues.push({ signature: "y", slot: 0, kind: "parse_issue", scope: "tx", detail: "" });
    expect(candidates(MINT, o, { clusterTag: 2, now: o.sells[0].blockTime + 60, maxAttestAgeSecs: 86_400 })).toHaveLength(2);
  });
  it("a coin-scope issue (engine invariant) stops everything from its slot", () => {
    const o = base();
    o.issues.push({ signature: "x", slot: 0, kind: "out_of_order", scope: "coin", detail: "" });
    expect(candidates(MINT, o, { clusterTag: 2, now: o.sells[0].blockTime + 60, maxAttestAgeSecs: 86_400 })).toHaveLength(0);
  });
});
