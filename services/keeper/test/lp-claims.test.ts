/**
 * Keeper tidy-ups:
 *  (a) claim_lp_fees after graduation: a pre-check from the DAMM v2 pool + position data skips the claim when
 *      nothing is pending, and NothingToClaim (6021) is a quiet no-op in the sender (debug, not "tx failed").
 *  (b) claim_for outcome from the tx's events: paid / escrowed / queued (no more "auto-claimed" for a queue entry).
 */
import { Keypair, PublicKey, SendTransactionError, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { FUMPAD_ERROR, type FumpadEvent } from "@fumpad/sdk";

import { claimForOutcome, pendingLpQuoteFees } from "../src/keeper.js";
import { Sender } from "../src/sender.js";

const putLE = (d: Uint8Array, o: number, n: number, v: bigint) => {
  for (let i = 0; i < n; i++) {
    d[o + i] = Number(v & 0xffn);
    v >>= 8n;
  }
};
// Numbers read from a graduated devnet coin (pool 72U5…34Vc, its locked position 6UTb…Dx9z) right after its
// LP fees were claimed: checkpoint == pool accumulator, nothing pending.
const L = 7338634131812253408036557443463n;
const PER_L = 146045585823610n;
function accounts(o: { perL: bigint; checkpoint: bigint; pending?: bigint; unlocked?: bigint; vested?: bigint; perm?: bigint }) {
  const pool = new Uint8Array(1112);
  const pos = new Uint8Array(408);
  putLE(pool, 520, 32, o.perL);
  putLE(pos, 104, 32, o.checkpoint);
  putLE(pos, 144, 8, o.pending ?? 0n);
  putLE(pos, 152, 16, o.unlocked ?? 0n);
  putLE(pos, 168, 16, o.vested ?? 0n);
  putLE(pos, 184, 16, o.perm ?? L);
  return { pool, pos };
}

describe("(a) pendingLpQuoteFees", () => {
  it("0 when the position's checkpoint equals the pool accumulator (the devnet post-claim state)", () => {
    const { pool, pos } = accounts({ perL: PER_L, checkpoint: PER_L });
    expect(pendingLpQuoteFees(pool, pos)).toBe(0n);
  });
  it("cp-amm accrual: liquidity × Δaccumulator >> 128, plus fee_b_pending", () => {
    // From zero, the devnet position accrued exactly the pool's total LP fee B (3 149 663 lamports).
    expect(pendingLpQuoteFees(...Object.values(accounts({ perL: PER_L, checkpoint: 0n })) as [Uint8Array, Uint8Array])).toBe(3_149_663n);
    const { pool, pos } = accounts({ perL: PER_L + (1n << 100n), checkpoint: PER_L, pending: 7n, unlocked: 1n << 28n, perm: 0n });
    expect(pendingLpQuoteFees(pool, pos)).toBe(7n + 1n);
    expect(pendingLpQuoteFees(...Object.values(accounts({ perL: 0n, checkpoint: 0n, pending: 5n })) as [Uint8Array, Uint8Array])).toBe(5n);
  });
  it("null on short accounts (falls back to sending; the sender treats 6021 quietly)", () => {
    expect(pendingLpQuoteFees(new Uint8Array(100), new Uint8Array(408))).toBeNull();
  });
});

const silent = () => {
  const lines: { level: string; msg: string }[] = [];
  const mk = (level: string) => (_o: unknown, msg?: string) => void lines.push({ level, msg: msg ?? "" });
  return { lines, log: { info: mk("info"), warn: mk("warn"), debug: mk("debug"), error: mk("error") } };
};
function sender(code: number, dryRun = false) {
  const conn = {
    getRecentPrioritizationFees: async () => [],
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    sendRawTransaction: async () => {
      throw new SendTransactionError({ action: "send", signature: "", transactionMessage: `Transaction simulation failed: Error processing Instruction 1: custom program error: 0x${code.toString(16)}`, logs: ["Program log: AnchorError"] });
    },
    simulateTransaction: async () => ({ value: { err: { InstructionError: [1, { Custom: code }] }, logs: [], unitsConsumed: 1 } }),
  };
  const s = silent();
  return { s, sender: new Sender(conn as never, Keypair.generate(), { dryRun, priorityPercentile: 50, priorityMinMicroLamports: 0, priorityMaxMicroLamports: 1 }, s.log as never) };
}
const ix = { instructions: [SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] };

describe("(a) NothingToClaim is a quiet no-op", () => {
  const NOTHING = FUMPAD_ERROR.NothingToClaim;
  it("is code 6021", () => expect(NOTHING).toBe(6021));
  it("send: quiet code → debug, not counted as failed; the code is still returned", async () => {
    const { s, sender: snd } = sender(NOTHING);
    const r = await snd.send("claim_lp_fees", ix, { retries: 0, quietCodes: new Set([NOTHING]) });
    expect(r).toMatchObject({ ok: false, code: NOTHING });
    expect(snd.stats).toMatchObject({ failed: 0, quiet: 1 });
    expect(s.lines.filter((l) => l.level === "warn")).toEqual([]);
  });
  it("send: any other program error still warns", async () => {
    const { s, sender: snd } = sender(6000);
    const r = await snd.send("claim_lp_fees", ix, { retries: 0, quietCodes: new Set([NOTHING]) });
    expect(r.code).toBe(6000);
    expect(snd.stats.failed).toBe(1);
    expect(s.lines.some((l) => l.level === "warn" && l.msg === "tx failed")).toBe(true);
  });
  it("dry-run simulation: quiet code logged at debug", async () => {
    const { s, sender: snd } = sender(NOTHING, true);
    const r = await snd.send("claim_lp_fees", ix, { quietCodes: new Set([NOTHING]) });
    expect(r).toMatchObject({ ok: false, simulated: true, code: NOTHING });
    expect(s.lines.map((l) => l.level)).toEqual(["debug"]);
  });
});

describe("(b) claimForOutcome", () => {
  const ticket = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const ev = (name: string, data: Record<string, unknown>, index = 0): FumpadEvent => ({ name, data: data as never, index, topIx: 2, raw: "" });
  const base = { mint: Keypair.generate().publicKey, owner: Keypair.generate().publicKey, ts: 1n, triggeredBy: Keypair.generate().publicKey };
  it("paid / escrowed / queued for this ticket", () => {
    expect(claimForOutcome([ev("ClaimPaid", { ...base, ticket, amount: 5n, fromQueue: false, medianPriceQ64: 1n })], ticket)).toEqual({ kind: "paid", amount: 5n });
    expect(claimForOutcome([ev("ClaimEscrowed", { ...base, ticket, escrow: other, amount: 6n })], ticket)).toEqual({ kind: "escrowed", amount: 6n });
    expect(claimForOutcome([ev("ClaimQueued", { ...base, ticket, amount: 7n, queueLen: 3 })], ticket)).toEqual({ kind: "queued", amount: 7n, queueLen: 3 });
  });
  it("ignores other tickets' events and unrelated events; unknown when nothing matches", () => {
    const evs = [ev("SampleRecorded", { mint: base.mint, venue: 1, priceQ64: 1n, fallback: false, ts: 1n }), ev("ClaimPaid", { ...base, ticket: other, amount: 1n, fromQueue: false, medianPriceQ64: 1n }, 1)];
    expect(claimForOutcome(evs, ticket)).toEqual({ kind: "unknown" });
    expect(claimForOutcome([], new PublicKey(ticket.toBytes()))).toEqual({ kind: "unknown" });
  });
});
