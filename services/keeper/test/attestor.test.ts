// Attestor: 2-of-3 signature exchange over the shared board, designated submitter, pause / freeze /
// consumed / age / rate-cap handling, forged signatures ignored, disagreement never submitted.
import { Keypair, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import pino from "pino";
import { describe, expect, it } from "vitest";

import type { EngineOutput } from "@fumpad/engine";
import { type CoinAccount, DEFAULT_PARAMS, ED25519_PROGRAM_ID, FUMPAD_ERROR, type GlobalAccount, parseEd25519InstructionData, PAUSE, verifyAttestation } from "@fumpad/sdk";

import { PublicKey as Pk } from "@solana/web3.js";

import { Attestor, type ChainView, type SubmitResult } from "../src/attest/attestor.js";

const PublicKeyDefault = Pk.default;
import { MemoryBoard } from "../src/attest/board.js";
import type { Derivation } from "../src/attest/derive.js";

const log = pino({ level: "silent" });
const NOW = 1_800_000_000;
const keepers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const mint = Keypair.generate().publicKey;
const trader = Keypair.generate().publicKey;
/** a syntactically valid 64-byte base58 tx signature */
const realSig = () => bs58.encode(new Uint8Array(64).fill(7));

function global(over: Partial<GlobalAccount> = {}): GlobalAccount {
  return {
    keepers: keepers.map((k) => k.publicKey),
    keeperAddedAt: [0n, 0n, 0n],
    paused: 0,
    pauseExpiresAt: 0n,
    clusterTag: 2,
    params: DEFAULT_PARAMS,
    ...over,
  } as GlobalAccount;
}

const coin = { mint, attestCursor: 0n, totalSupply: 1_000_000_000_000_000n } as CoinAccount;

function output(ticketTokens: bigint, blockTime = NOW - 100): EngineOutput {
  return {
    mint: mint.toBase58(),
    sells: [
      {
        signature: realSig(),
        ixKey: 0,
        slot: 100,
        txIndex: -1,
        blockTime,
        venue: "dbc",
        pool: Keypair.generate().publicKey.toBase58(),
        routed: false,
        trader: trader.toBase58(),
        baseAmount: 1_000_000_000n,
        quoteGross: 500_000_000n,
        ticket: { ticketTokens, ticketPriceQ64: 1n << 60n, usdCents: 7_500n, pythPublishTime: blockTime - 2, executionQ64: 1n << 60n, referenceQ64: 1n << 60n, preSpotQ64: 1n << 60n },
        reason: null,
      },
    ],
    rebuys: [],
    issues: [],
    reference: { avgQ64: 0n, lastSpotQ64: 0n, updatedAt: 0n },
    lastKey: null,
  };
}
// One pool per run of the test file: every keeper must derive the SAME pool to agree.
const POOL = Keypair.generate().publicKey.toBase58();
const derivation = (o: EngineOutput): Derivation => {
  o.sells.forEach((s) => (s.pool = POOL));
  return { coin: { mint: mint.toBase58() } as never, output: o, maxSlot: 1_000, txCount: 1, history: [] };
};

class StubChain implements ChainView {
  consumed = false;
  constructor(public g: GlobalAccount) {}
  async global() {
    return this.g;
  }
  async coins() {
    return [coin];
  }
  async accountsExist(keys: PublicKey[]) {
    return keys.map(() => this.consumed);
  }
  async position() {
    return null;
  }
  async ticket() {
    return null;
  }
}

class RecordingSubmitter {
  calls: TransactionInstruction[][] = [];
  next: SubmitResult = { ok: true, signature: "tx" };
  async submit(_l: string, ixs: TransactionInstruction[]) {
    this.calls.push(ixs);
    return this.next;
  }
}

function setup(o: { outputs?: EngineOutput[]; g?: GlobalAccount } = {}) {
  const board = new MemoryBoard(() => NOW * 1000);
  const chain = new StubChain(o.g ?? global());
  const sub = new RecordingSubmitter();
  const outs = o.outputs ?? [output(100n), output(100n), output(100n)];
  const atts = keepers.map(
    (k, i) =>
      new Attestor({ keeper: k, chain, derive: async () => derivation(structuredClone(outs[i])), board, submitter: sub, log, now: () => NOW, fallbackSubmitSecs: 60 }),
  );
  return { board, chain, sub, atts };
}

describe("attestor 2-of-3", () => {
  it("two matching keepers → exactly one submission carrying 2 valid signatures over the derived bytes", async () => {
    const { sub, atts } = setup();
    for (const a of atts) await a.tick();
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBe(1);
    const ixs = sub.calls[0];
    const ed = ixs.find((i) => i.programId.equals(ED25519_PROGRAM_ID))!;
    const idx = ixs.indexOf(ed);
    expect(ixs[idx + 1].programId.toBase58()).toBe("5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb"); // attest right after Ed25519
    const p = parseEd25519InstructionData(Uint8Array.from(ed.data))!;
    expect(p.signatures.length).toBe(2);
    expect(new Set(p.signatures.map((s) => s.keeper.toBase58())).size).toBe(2);
    for (const s of p.signatures) expect(verifyAttestation(p.message, s)).toBe(true);
  });

  it("a keeper that derives something different never gets its message submitted", async () => {
    const { sub, atts, board } = setup({ outputs: [output(100n), output(101n), output(102n)] });
    for (const a of atts) await a.tick();
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBe(0);
    expect(board.rows.size).toBe(3); // three distinct messages, one signature each
  });

  it("only the designated (lowest-key) signer submits; another takes over after the fallback delay", async () => {
    let now = NOW;
    const board = new MemoryBoard(() => now * 1000);
    const chain = new StubChain(global());
    const sub = new RecordingSubmitter();
    const sorted = [...keepers].sort((a, b) => (a.publicKey.toBase58() < b.publicKey.toBase58() ? -1 : 1));
    const mk = (k: Keypair) => new Attestor({ keeper: k, chain, derive: async () => derivation(output(100n)), board, submitter: sub, log, now: () => now, fallbackSubmitSecs: 60 });
    // keepers 1 and 2 sign; 1 (lowest valid signer) is designated, then goes offline before submitting
    const [b, c] = [mk(sorted[1]), mk(sorted[2])];
    await b.tick();
    await c.tick();
    expect(sub.calls.length).toBe(0); // c is not designated
    await c.tick();
    expect(sub.calls.length).toBe(0);
    now += 61; // fallback: c takes over
    await c.tick();
    expect(sub.calls.length).toBe(1);
    await b.tick(); // landed status is shared on the board: no duplicate
    expect(sub.calls.length).toBe(1);
  });

  it("forged / non-keeper signatures on the board are ignored", async () => {
    const { sub, atts, board } = setup();
    await atts[0].tick();
    const id = [...board.rows.keys()][0];
    const outsider = Keypair.generate();
    await board.publish(id, "sell", mint.toBase58(), new Uint8Array(), outsider.publicKey.toBase58(), new Uint8Array(64).fill(1));
    await board.publish(id, "sell", mint.toBase58(), new Uint8Array(), keepers[1].publicKey.toBase58(), new Uint8Array(64).fill(2)); // bad sig in K2's name
    await atts[0].tick();
    expect(sub.calls.length).toBe(0);
  });

  it("PAUSE_ATTEST: nothing is signed or sent", async () => {
    const { sub, atts, board } = setup({ g: global({ paused: PAUSE.attest, pauseExpiresAt: BigInt(NOW + 3_600) }) });
    for (const a of atts) await a.tick();
    expect(board.rows.size).toBe(0);
    expect(sub.calls.length).toBe(0);
    expect(atts[0].stats.state).toBe("paused");
  });

  it("a keeper inside its 6 h freeze doesn't attest", async () => {
    const { atts, board } = setup({ g: global({ keeperAddedAt: [BigInt(NOW - 60), 0n, 0n] }) });
    await atts[0].tick();
    expect(atts[0].stats.state).toBe("not_active_keeper");
    expect(board.rows.size).toBe(0);
  });

  it("already consumed on chain → skipped", async () => {
    const { atts, chain, board } = setup();
    chain.consumed = true;
    for (const a of atts) await a.tick();
    expect(board.rows.size).toBe(0);
  });

  it("too old to attest (max_attest_age − margin) → not signed", async () => {
    const old = NOW - 86_400 + 100;
    const { atts, board } = setup({ outputs: [output(100n, old), output(100n, old), output(100n, old)] });
    for (const a of atts) await a.tick();
    expect(board.rows.size).toBe(0);
  });

  it("program rejections: a transient error backs the message off; a permanent error drops it for that keeper (hint on the board)", async () => {
    const { atts, sub, board } = setup();
    sub.next = { ok: false, code: null, error: "blockhash expired" }; // the rate cap never rejects any more (M-1)
    for (const a of atts) await a.tick();
    for (const a of atts) await a.tick(); // whoever was designated has tried once and backed off
    const n = sub.calls.length;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2); // the designated signer can change as signatures arrive
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBe(n); // backed off
    const { atts: b, sub: s2, board: bd2 } = setup();
    s2.next = { ok: false, code: FUMPAD_ERROR.BelowMinimumUsd, error: "x" };
    for (const a of b) await a.tick();
    for (const a of b) await a.tick();
    const st = [...bd2.st.values()].flatMap((m) => [...m.values()]);
    expect(st.some((x) => x.status === "dropped" && x.detail === "BelowMinimumUsd")).toBe(true);
    void board;
  });
});

describe("board status is only a hint (V7-M1, L4)", () => {
  it("a DB writer marking every message 'dropped' changes nothing: the honest pair still submits", async () => {
    const { sub, atts, board } = setup();
    await atts[0].tick();
    for (const id of board.rows.keys()) for (const k of keepers) await board.setStatus(id, k.publicKey.toBase58(), "dropped", "evil");
    for (let i = 0; i < 2; i++) for (const a of atts) await a.tick();
    expect(sub.calls.length).toBe(1);
  });

  it("a forged fresh 'landed' hint defers submission once, for a bounded time only", async () => {
    let now = NOW;
    const board = new MemoryBoard(() => now * 1000);
    const chain = new StubChain(global());
    const sub = new RecordingSubmitter();
    const atts = keepers.map((k) => new Attestor({ keeper: k, chain, derive: async () => derivation(output(100n)), board, submitter: sub, log, now: () => now, fallbackSubmitSecs: 0, landedHintSecs: 90 }));
    await atts[0].tick();
    const id = [...board.rows.keys()][0];
    const forge = async () => {
      for (const k of keepers) await board.setStatus(id, k.publicKey.toBase58(), "landed", "fake"); // keeps re-stamping it
    };
    await forge();
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBe(0); // deferred
    now += 91;
    await forge();
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBeGreaterThanOrEqual(1); // the hint can't hold it back again
  });

  it("own landing at confirmed: no resend while it finalizes; resent if the marker never finalizes; skipped once consumed", async () => {
    let now = NOW;
    const board = new MemoryBoard(() => now * 1000);
    const chain = new StubChain(global());
    const sub = new RecordingSubmitter();
    const atts = keepers.map((k) => new Attestor({ keeper: k, chain, derive: async () => derivation(output(100n)), board, submitter: sub, log, now: () => now, fallbackSubmitSecs: 0, landedHintSecs: 90 }));
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBe(1);
    now += 30;
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBe(1);
    now += 200; // never finalized (dropped by a fork): sent again (a duplicate only fails simulation)
    for (const a of atts) await a.tick();
    const resent = sub.calls.length;
    expect(resent).toBeGreaterThanOrEqual(2);
    chain.consumed = true;
    now += 200;
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBe(resent);
  });
});

describe("reopened replay markers (guardian void with reopen, INTERFACE §8.2)", () => {
  it("a corrected message is attested again; the voided message itself never is", async () => {
    const { createHash } = await import("node:crypto");
    const board = new MemoryBoard(() => NOW * 1000);
    const chain = new StubChain(global());
    const sub = new RecordingSubmitter();
    let voidedHash = new Uint8Array(16);
    (chain as ChainView).consumedMarkers = async (keys) => keys.map(() => ({ kind: 2, messageHash: voidedHash }));
    const mk = (tokens: bigint) => keepers.map((k) => new Attestor({ keeper: k, chain, derive: async () => derivation(output(tokens)), board, submitter: sub, log, now: () => NOW, fallbackSubmitSecs: 0 }));
    // the voided message (same derivation as before the void): skipped
    const first = mk(100n);
    await first[0].tick();
    const id = [...board.rows.keys()][0];
    const msg = [...board.rows.get(id)!.values()][0].message;
    voidedHash = Uint8Array.from(createHash("sha256").update(msg).digest().subarray(0, 16));
    const again = mk(100n);
    for (const a of again) await a.tick();
    expect(sub.calls.length).toBe(0);
    // a corrected derivation (different bytes): attested
    const fixed = mk(90n);
    for (const a of fixed) await a.tick();
    for (const a of fixed) await a.tick();
    expect(sub.calls.length).toBe(1);
  });
});

describe("DAMM v2 sells wait for graduate (V7-M2)", () => {
  const damm = () => {
    const o = output(100n);
    o.sells[0].venue = "damm_v2";
    return o;
  };
  it("not signed while Coin.damm_pool is unset; signed and submitted once graduate recorded it", async () => {
    const board = new MemoryBoard(() => NOW * 1000);
    const chain = new StubChain(global());
    const ungraduated = { ...coin, dammPool: PublicKeyDefault } as CoinAccount;
    let current = ungraduated;
    chain.coins = async () => [current];
    const sub = new RecordingSubmitter();
    const atts = keepers.map((k) => new Attestor({ keeper: k, chain, derive: async () => derivation(damm()), board, submitter: sub, log, now: () => NOW, fallbackSubmitSecs: 0 }));
    for (const a of atts) await a.tick();
    expect(board.rows.size).toBe(0);
    current = { ...coin, dammPool: Keypair.generate().publicKey } as CoinAccount;
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBe(1);
  });

  it("PoolNotOfCoin / TooManyOpenTickets are retried after a back-off, never dropped", async () => {
    let now = NOW;
    const board = new MemoryBoard(() => now * 1000);
    const chain = new StubChain(global());
    const sub = new RecordingSubmitter();
    const atts = keepers.map((k) => new Attestor({ keeper: k, chain, derive: async () => derivation(output(100n)), board, submitter: sub, log, now: () => now, fallbackSubmitSecs: 0 }));
    sub.next = { ok: false, code: FUMPAD_ERROR.PoolNotOfCoin, error: "PoolNotOfCoin" };
    for (const a of atts) await a.tick();
    const n = sub.calls.length;
    expect(n).toBeGreaterThanOrEqual(1);
    sub.next = { ok: false, code: FUMPAD_ERROR.TooManyOpenTickets, error: "TooManyOpenTickets" };
    now += 3_601;
    for (const a of atts) await a.tick();
    expect(sub.calls.length).toBeGreaterThan(n);
    sub.next = { ok: true, signature: "tx" };
    now += 3_601;
    for (const a of atts) await a.tick();
    expect([...board.st.values()].flatMap((m) => [...m.values()]).some((h) => h.status === "landed")).toBe(true);
  });
});

describe("coin scheduling (V7-M6)", () => {
  it("coins with recent sells are derived first; a tick budget leaves the rest for the next tick", async () => {
    const mints = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
    const coins = mints.map((m) => ({ ...coin, mint: m }) as CoinAccount);
    const chain = new StubChain(global());
    chain.coins = async () => coins;
    const order: string[] = [];
    const hot = mints[4].toBase58();
    let budgetHit = false;
    let ms = 0;
    const att = new Attestor({
      keeper: keepers[0],
      chain,
      derive: async (c) => {
        order.push(c.mint.toBase58());
        const o = output(100n, c.mint.toBase58() === hot ? NOW - 50 : NOW - 80_000);
        o.sells[0].ticket = null;
        if (budgetHit) ms += 30;
        return derivation(o);
      },
      board: new MemoryBoard(() => NOW * 1000),
      submitter: new RecordingSubmitter(),
      log,
      now: () => NOW,
      coinConcurrency: 1,
      tickBudgetMs: 45,
      recentActivitySecs: 3_600,
      clockMs: () => ms,
    });
    await att.tick(); // learns activity
    expect(order).toHaveLength(6);
    order.length = 0;
    budgetHit = true;
    await att.tick();
    expect(order[0]).toBe(hot);
    expect(order.length).toBeLessThan(6); // budget: stopped starting coins
    const first = [...order];
    order.length = 0;
    await att.tick();
    expect(order[0]).toBe(hot);
    expect(order[1]).not.toBe(first[1]); // the least recently derived go next
  });
});
