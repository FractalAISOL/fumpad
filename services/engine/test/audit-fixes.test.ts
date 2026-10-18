// External audit 2026-10-17 — engine-side fixes: H-1 (rebuy debits aggregate below a per-ticket threshold), M-1
// (dust transfer-ins don't restart a wallet's pending hold clock), L-5 (payout exemption per owner) and M-2 (a swap
// event we can't turn into a trade still keeps the price exact: only that tx's sells are refused).
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { type ConfirmedTx, TOKEN_2022_PROGRAM_ID } from "@fumpad/meteora";

import { buildEvents, type TransferEvent } from "../src/index.js";
import { A, B, coin, DBC, MINT, SOL, SQRT0, Tape } from "./helpers.js";

/** Tape: A buys 10 SOL, waits 10 min, sells `sellSol` → one ticket of sellSol × 1024 tokens. */
const ticketTape = (sellSol: bigint) => {
  const t = new Tape();
  t.buy(A, 10n * SOL);
  t.wait(600);
  const s = t.sell(A, sellSol);
  return { t, s, tokens: sellSol * 1024n };
};

describe("H-1: rebuy spam can't drain the attestors (SPEC Clarification 32)", () => {
  it("1,000 dust transfers to a ticket holder → at most ⌈total / threshold⌉ attestations, each ≥ 1% of the ticket, debits exact", () => {
    const { t, s, tokens } = ticketTape(SOL); // 1,024e9 tokens; 1% = 10.24e9
    const threshold = (tokens + 99n) / 100n;
    const dust = 33_333_333n;
    for (let i = 0; i < 1_000; i++) t.wait(1).transfer(A, dust);
    const o = t.run();
    const total = dust * 1_000n;
    expect(o.rebuys.length).toBe(Number(total / threshold)); // 3, not 1,000
    expect(o.rebuys.length).toBe(3);
    for (const r of o.rebuys) {
      expect(r.ticket.signature).toBe(s);
      expect(r.debit >= threshold).toBe(true);
      expect(r.debit < threshold + dust).toBe(true);
      expect(r.acquisitions! > 1).toBe(true);
    }
    const attested = o.rebuys.reduce((a, r) => a + r.debit, 0n);
    expect(total - attested < threshold).toBe(true); // the unattested residual stays below the threshold
    expect(o.rebuys.at(-1)!.remaining).toBe(tokens - attested); // each attestation leaves the on-chain ticket = the engine's
  });

  it("a meaningful rebuy (≥ 1% of the ticket) is attested at once, carrying any earlier sub-threshold residual", () => {
    const { t, tokens } = ticketTape(SOL);
    t.wait(5).transfer(A, 1_000n, { signature: "dust" });
    const big = t.wait(5).buy(A, SOL / 50n); // 2% of the ticket
    const o = t.run();
    expect(o.rebuys).toHaveLength(1);
    expect(o.rebuys[0]).toMatchObject({ signature: big, kind: "buy", debit: (SOL / 50n) * 1024n + 1_000n, acquisitions: 2, voided: false });
    expect(o.rebuys[0].remaining).toBe(tokens - o.rebuys[0].debit);
  });

  it("an acquisition that voids the ticket is attested even below the threshold (the program voids at the same point)", () => {
    const { t, tokens } = ticketTape(SOL); // claim 10% → the ticket voids once ≤ 9 tokens remain
    t.wait(5).transfer(A, tokens - 15n); // ≥ threshold: attested
    t.wait(5).transfer(A, 6n); // 6 tokens ≪ 1%, but remaining 9 → claim 0 → void: attested too
    const o = t.run();
    expect(o.rebuys.map((r) => [r.debit, r.remaining, r.voided])).toEqual([
      [tokens - 15n, 15n, false],
      [6n, 9n, true],
    ]);
  });

  it("bound: a ticket gets at most ⌈10,000 / bps⌉ + 1 rebuy attestations whatever the spam pattern", () => {
    const { t } = ticketTape(SOL);
    for (let i = 0; i < 3_000; i++) t.wait(1).transfer(A, 3_456_789n + BigInt(i % 7) * 1_000_000_000n);
    const o = t.run();
    expect(o.rebuys.length).toBeLessThanOrEqual(10_000 / 100 + 1);
    expect(o.rebuys.at(-1)!.voided).toBe(true);
  });

  it("minRebuyDebitBps = 0 → every acquisition is attested on its own (pre-fix behaviour)", () => {
    const { t } = ticketTape(SOL);
    for (let i = 0; i < 5; i++) t.wait(1).transfer(A, 7n);
    expect(t.run({ minRebuyDebitBps: 0n }).rebuys.map((r) => r.debit)).toEqual([7n, 7n, 7n, 7n, 7n]);
  });
});

describe("M-1: unsolicited dust can't reset a holder's maturity (SPEC Clarification 33)", () => {
  it("a 1-unit transfer-in at 9:50 doesn't restart the 10-min clock; the dust itself is never ticketed", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(590).transfer(A, 1n); // attacker dust
    t.wait(10).sell(A, SOL); // 10:00 after the buy
    const s = t.run().sells[0];
    expect(s.reason).toBe(null);
    expect(s.ticket!.ticketTokens).toBe(SOL * 1024n - 1n); // the dust is sold first (untracked), never credited
  });
  it("a real transfer-in (≥ 1% of the pending bucket) still restarts it, as before", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(590).transfer(A, (SOL * 1024n) / 100n);
    t.wait(10).sell(A, SOL);
    expect(t.run().sells[0].reason).toBe("not_matured");
  });
  it("dustTransferBps = 0 → the old rule (any transfer-in restarts the clock)", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(590).transfer(A, 1n);
    t.wait(10).sell(A, SOL);
    expect(t.run({ dustTransferBps: 0n }).sells[0].reason).toBe("not_matured");
  });
  it("matured tokens are never affected by any transfer-in", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(700).transfer(A, 5n * SOL * 1024n); // big, restarts only its own (new) pending bucket
    t.wait(1).sell(A, SOL);
    // V7-M4: the sell draws on pending first, so it gets no ticket; the matured lot stays for later
    t.wait(1).sell(A, 5n * SOL);
    const o = t.run();
    expect(o.sells.map((s) => s.reason)).toEqual(["not_matured", null]);
    expect(o.sells[1].ticket!.ticketTokens).toBe(SOL * 1024n);
  });
});

describe("M-2: a swap we can't parse but whose program event gives the price taints only its own tx", () => {
  const issue = (t: Tape, priceTouch?: { pool: string; sqrtPrice: bigint }) =>
    t.events.push({ kind: "parse_issue", key: { slot: t.slot, txIndex: -1, phase: 2, ixKey: 0 }, signature: "orphan", blockTime: t.t, code: "event_without_swap_parent", message: "x", pool: DBC, ...(priceTouch ? { priceTouch } : {}) });
  it("with the event's price: later sells keep their tickets; without it: one D10 window is unverified (unchanged)", () => {
    for (const withPrice of [true, false]) {
      const t = new Tape();
      t.buy(A, SOL);
      t.buy(B, SOL);
      t.wait(600);
      issue(t, withPrice ? { pool: DBC, sqrtPrice: SQRT0 } : undefined);
      t.wait(1).sell(A, SOL);
      t.wait(1).sell(B, SOL);
      const o = t.run();
      expect(o.sells.map((s) => s.reason)).toEqual(withPrice ? [null, null] : ["price_unverified", "price_unverified"]);
      expect(o.issues).toMatchObject([{ kind: "parse_issue", scope: "tx" }]);
    }
  });
  it("the event's price feeds the D10 reference exactly: a pump hidden in an unparseable swap still raises the floor", () => {
    const t = new Tape();
    t.buy(A, SOL);
    t.wait(600);
    issue(t, { pool: DBC, sqrtPrice: SQRT0 * 2n }); // spot ×4
    t.wait(60).sell(A, SOL, { nextSqrtPrice: SQRT0 });
    const s = t.run().sells[0];
    expect(s.reason).toBe(null);
    expect(s.ticket!.referenceQ64 > s.ticket!.executionQ64).toBe(true);
  });
});

describe("L-5: the payout exemption is per owner and capped at what the payout account sent", () => {
  // claim tx: reward vault → A (1,000), bundled: B → A (500) and B → C (300), plain token transfers
  const POOL_PDA = "RewardPoo1Pda1111111111111111111111111111111";
  const C = "Caro1Wa11et111111111111111111111111111111111";
  const keys = ["Signer11111111111111111111111111111111111111", "Vau1t111111111111111111111111111111111111111", "AtaA1111111111111111111111111111111111111111", "AtaB1111111111111111111111111111111111111111", "AtaC1111111111111111111111111111111111111111", MINT, TOKEN_2022_PROGRAM_ID];
  const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
  const ix = (data: number[], accounts: number[], stackHeight?: number) => ({ programIdIndex: 6, accounts, data: bs58.encode(Uint8Array.from(data)), ...(stackHeight ? { stackHeight } : {}) });
  const bal = (i: number, owner: string, amount: bigint) => ({ accountIndex: i, mint: MINT, owner, programId: TOKEN_2022_PROGRAM_ID, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const tx: ConfirmedTx = {
    slot: 5_000,
    blockTime: 1_700_100_000,
    transaction: {
      signatures: ["claimTx"],
      message: {
        accountKeys: keys,
        header: { numRequiredSignatures: 1 },
        instructions: [
          ix([12, ...u64(1_000n), 6], [1, 5, 2, 0]), // TransferChecked vault → AtaA (the claim)
          ix([3, ...u64(500n)], [3, 2, 0]), // Transfer AtaB → AtaA
          ix([3, ...u64(300n)], [3, 4, 0]), // Transfer AtaB → AtaC
        ],
      },
    },
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [bal(1, POOL_PDA, 10_000n), bal(2, A, 0n), bal(3, B, 1_000n), bal(4, C, 0n)],
      postTokenBalances: [bal(1, POOL_PDA, 9_000n), bal(2, A, 1_500n), bal(3, B, 200n), bal(4, C, 300n)],
    },
  };
  it("A: 1,000 of its 1,500 is the payout (500 is an acquisition); C's 300 is an acquisition", () => {
    const ev = buildEvents(coin(), [{ tx, txIndex: -1 }], { protocolOwners: new Set([POOL_PDA]), payoutOwners: new Set([POOL_PDA]) });
    const tr = ev.filter((e): e is TransferEvent => e.kind === "transfer").map((e) => [e.owner, e.delta, e.payout, e.payoutAmount]);
    expect(tr).toEqual([
      [A, 1_500n, false, 1_000n],
      [B, -800n, false, undefined],
      [C, 300n, false, undefined],
    ]);
  });
  it("the engine debits A's ticket with the 500 only", () => {
    const { t, s } = ticketTape(SOL);
    const base = { kind: "transfer" as const, signature: "claimTx", blockTime: t.t + 5, owner: A };
    t.wait(5);
    t.events.push({ ...base, key: { slot: t.slot, txIndex: -1, phase: 0, ixKey: 0xffff_ffff }, delta: 20n * SOL, payout: false, payoutAmount: 20n * SOL - 500n * 1_000_000n });
    const o = t.run();
    expect(o.rebuys.map((r) => [r.ticket.signature, r.debit])).toEqual([]); // 0.5e9 < 1% of 1,024e9: accumulated (H-1)
    t.wait(5).transfer(A, 10n * SOL);
    const o2 = t.run();
    expect(o2.rebuys.map((r) => [r.ticket.signature, r.debit])).toEqual([[s, 500n * 1_000_000n + 10n * SOL]]);
  });
});
