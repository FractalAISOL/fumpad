/**
 * V7-H2 regression: vault movements that aren't swaps (donations, SyncNative, pool-program transfers)
 * must not reject an authentic swap; an unexplained vault delta still does, and the issue names the pool.
 * Owner changes are attributed per token account (ownerDeltas).
 */
import { readFileSync } from "node:fs";

import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { type ConfirmedTx, normalizeTx, ownerDeltas, parseMeteoraTrades, tokenMovement } from "../src/index.js";

const load = (name: string): ConfirmedTx => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as ConfirmedTx;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// dbc_direct_sell account indexes: 0 seller (signer), 1 seller base ATA, 4 base vault, 5 quote vault,
// 8 base mint, 10 Token-2022, 12 SPL Token.
const SELLER_ACC = 1;
const BASE_VAULT = 4;
const QUOTE_VAULT = 5;

type Msg = { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string; stackHeight?: number }[] };
type Bal = { accountIndex: number; uiTokenAmount: { amount: string } };

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return b;
};

function bump(tx: ConfirmedTx, accountIndex: number, d: bigint) {
  const b = (tx.meta!.postTokenBalances as Bal[]).find((x) => x.accountIndex === accountIndex)!;
  b.uiTokenAmount.amount = String(BigInt(b.uiTokenAmount.amount) + d);
}

/** dbc_direct_sell + a top-level TransferChecked(seller ATA → base vault, `n`) appended after the swap. */
function withDonation(n: bigint, opts: { instruction: boolean } = { instruction: true }): ConfirmedTx {
  const tx = clone(load("dbc_direct_sell"));
  const m = tx.transaction.message as Msg;
  if (opts.instruction) m.instructions.push({ programIdIndex: 10, accounts: [SELLER_ACC, 8, BASE_VAULT, 0], data: bs58.encode(Uint8Array.from([12, ...u64(n), 6])), stackHeight: 1 });
  bump(tx, SELLER_ACC, -n);
  bump(tx, BASE_VAULT, n);
  return tx;
}

describe("vault cross-check tolerates non-swap vault movements (V7-H2)", () => {
  it("a 1-unit donation into the base vault in the swap tx: the swap is still a record, no issue", () => {
    const honest = parseMeteoraTrades(load("dbc_direct_sell"));
    const r = parseMeteoraTrades(withDonation(1n));
    expect(r.issues).toEqual([]);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].baseAmount).toBe(honest.trades[0].baseAmount);
    expect(r.trades[0].quoteGross).toBe(honest.trades[0].quoteGross);
  });

  it("a large donation is accounted exactly too", () => {
    expect(parseMeteoraTrades(withDonation(123_456_789n)).trades).toHaveLength(1);
  });

  it("an unexplained vault delta (no instruction) is still rejected, and the issue names the pool", () => {
    const r = parseMeteoraTrades(withDonation(1n, { instruction: false }));
    expect(r.trades).toHaveLength(0);
    expect(r.issues[0].code).toBe("vault_mismatch");
    expect(r.issues[0].pool).toBe(parseMeteoraTrades(load("dbc_direct_sell")).trades[0].pool);
  });

  it("a donation instruction for the wrong amount does not hide a mismatch", () => {
    const tx = withDonation(5n);
    bump(tx, BASE_VAULT, 1n); // vault got 6, instructions show 5
    expect(parseMeteoraTrades(tx).issues[0]?.code).toBe("vault_mismatch");
  });

  it("SyncNative on the WSOL quote vault (lamports donated by system transfer) is tolerated, only upwards", () => {
    const tx = clone(load("dbc_direct_sell"));
    (tx.transaction.message as Msg).instructions.push({ programIdIndex: 12, accounts: [QUOTE_VAULT], data: bs58.encode(Uint8Array.from([17])), stackHeight: 1 });
    bump(tx, QUOTE_VAULT, 777n);
    expect(parseMeteoraTrades(tx).trades).toHaveLength(1);
    const down = clone(tx);
    bump(down, QUOTE_VAULT, -1_000n); // below what the swap implies: never explained by a sync
    expect(parseMeteoraTrades(down).trades).toHaveLength(0);
  });

  it("reads jsonParsed token instructions", () => {
    const ix = { ordinal: 0, topIx: 0, innerIx: -1, stackHeight: 1, programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", accounts: [], data: null, parent: null };
    expect(tokenMovement({ ...ix, parsed: { type: "transferChecked", info: { source: "S", destination: "D", tokenAmount: { amount: "42" } } } })).toEqual({ from: "S", to: "D", amount: 42n, received: 42n });
    expect(tokenMovement({ ...ix, parsed: { type: "syncNative", info: { account: "V" } } })).toMatchObject({ sync: "V" });
    expect(tokenMovement({ ...ix, parsed: { type: "transfer", info: { source: "S", destination: "D" } } })).toBe("unknown");
    expect(tokenMovement({ ...ix, parsed: { type: "approve", info: {} } })).toBeNull();
  });
});

describe("ownerDeltas attributes per token account (V7-H2 owner change)", () => {
  const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const MINT = "Mint111111111111111111111111111111111111111";
  const tx = (bals: { pre?: [string, bigint, string?]; post?: [string, bigint, string?] }[]): ConfirmedTx =>
    ({
      slot: 1,
      blockTime: 1,
      transaction: { signatures: ["s"], message: { accountKeys: ["Signer1111111111111111111111111111111111111", ...bals.map((_, i) => `Acc${i}111111111111111111111111111111111111111`.slice(0, 44))], header: { numRequiredSignatures: 1 }, instructions: [] } },
      meta: {
        err: null,
        innerInstructions: [],
        preTokenBalances: bals.flatMap((b, i) => (b.pre ? [{ accountIndex: i + 1, mint: b.pre[2] ?? MINT, owner: b.pre[0], programId: T22, uiTokenAmount: { amount: String(b.pre[1]) } }] : [])),
        postTokenBalances: bals.flatMap((b, i) => (b.post ? [{ accountIndex: i + 1, mint: b.post[2] ?? MINT, owner: b.post[0], programId: T22, uiTokenAmount: { amount: String(b.post[1]) } }] : [])),
      },
    }) as unknown as ConfirmedTx;

  it("SetAuthority(AccountOwner) W → V moves the balance like a transfer", () => {
    const d = ownerDeltas(normalizeTx(tx([{ pre: ["W", 1_000n], post: ["V", 1_000n] }])), MINT);
    expect(d.get("W")).toBe(-1_000n);
    expect(d.get("V")).toBe(1_000n);
  });

  it("same owner: plain delta", () => {
    const d = ownerDeltas(normalizeTx(tx([{ pre: ["W", 1_000n], post: ["W", 400n] }])), MINT);
    expect([...d]).toEqual([["W", -600n]]);
  });

  it("close + re-init of the same address for another mint in one tx doesn't throw; our mint's balance leaves", () => {
    const n = normalizeTx(tx([{ pre: ["W", 5n], post: ["W", 0n, "Other11111111111111111111111111111111111111"] }]));
    expect([...ownerDeltas(n, MINT)]).toEqual([["W", -5n]]);
    expect([...ownerDeltas(n, "Other11111111111111111111111111111111111111")]).toEqual([]);
  });
});
