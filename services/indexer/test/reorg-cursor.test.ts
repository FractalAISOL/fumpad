/**
 * M-4 (finalizer) and M-5 (poller cursor) regressions, with in-memory DB/RPC stubs.
 */
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_PARAMS, FUMPAD_PROGRAM_ID, type TxLike } from "@fumpad/sdk/v06";

import { Finalizer } from "../src/finality.js";
import { cursorTarget, RpcSource } from "../src/sources/rpc.js";

const log = { warn() {}, info() {}, debug() {}, error() {} } as never;
const sig = (i: number) => `${i}`.padStart(64, "1");
const info = (i: number, slot = i): ConfirmedSignatureInfo => ({ signature: sig(i), slot, err: null, memo: null, blockTime: null });

describe("M-4 finalizer: no rollback on a single miss", () => {
  function setup(rows: { signature: string; slot: string; age: number }[], status: () => unknown, tx: () => unknown) {
    const deleted: string[][] = [];
    const db = {
      async query(sql: string, params: unknown[]) {
        if (sql.includes("FROM transactions") && sql.includes("commitment <> 'finalized'")) {
          const after = params[2] as string | null;
          const r = rows.filter((x) => after === null || BigInt(x.slot) > BigInt(after) || (x.slot === after && x.signature > (params[3] as string)));
          return { rows: r.slice(0, params[1] as number) };
        }
        if (sql.startsWith("DELETE FROM transactions")) deleted.push(params[0] as string[]);
        return { rows: [] };
      },
    };
    let statusCalls = 0;
    const conn = {
      getSignatureStatuses: async (s: string[]) => (statusCalls++, { value: s.map(() => status()) }),
      getTransaction: async () => tx(),
    };
    const fin = new Finalizer(conn as never, db as never, () => DEFAULT_PARAMS, log, { dropMisses: 3, dropAfterSecs: 180, batch: 2, maxBatches: 10 });
    return { fin, deleted, calls: () => statusCalls };
  }

  it("an old row unknown to ONE status call is not deleted (the old code deleted it)", async () => {
    const { fin, deleted } = setup([{ signature: "a", slot: "1", age: 999 }], () => null, () => null);
    expect(await fin.runOnce()).toEqual({ finalized: 0, rolledBack: 0 });
    expect(await fin.runOnce()).toEqual({ finalized: 0, rolledBack: 0 });
    expect(deleted).toEqual([]);
    // Third consecutive miss + age + getTransaction also null → rolled back.
    expect((await fin.runOnce()).rolledBack).toBe(1);
    expect(deleted).toEqual([["a"]]);
  });

  it("getTransaction cross-check vetoes the rollback", async () => {
    const { fin, deleted } = setup([{ signature: "a", slot: "1", age: 999 }], () => null, () => ({ slot: 1 }));
    for (let i = 0; i < 5; i++) await fin.runOnce();
    expect(deleted).toEqual([]);
    expect(fin.stats.savedByCrossCheck).toBeGreaterThan(0);
  });

  it("young rows are never dropped; a row seen again resets its miss count", async () => {
    let seen = false;
    const { fin, deleted } = setup([{ signature: "a", slot: "1", age: 10 }], () => (seen ? { confirmationStatus: "confirmed", err: null } : null), () => null);
    for (let i = 0; i < 5; i++) await fin.runOnce();
    expect(deleted).toEqual([]);
    seen = true;
    await fin.runOnce();
    expect(fin.stats.pendingMisses).toBe(0);
  });

  it("pages past the first batch (keyset) so rows beyond it are processed", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ signature: `s${i}`, slot: String(i + 1), age: 20 }));
    const { fin, calls } = setup(rows, () => ({ confirmationStatus: "finalized", err: null }), () => null);
    expect((await fin.runOnce()).finalized).toBe(5);
    expect(calls()).toBe(3);
  });
});

describe("M-5 poller: the cursor never passes an unfetched transaction", () => {
  it("cursorTarget stops before the oldest still-missing signature", () => {
    const sigs = [info(1), info(2), info(3), info(4)];
    expect(cursorTarget(sigs, [], () => true)?.signature).toBe(sig(4));
    expect(cursorTarget(sigs, [sig(3)], () => true)?.signature).toBe(sig(2));
    expect(cursorTarget(sigs, [sig(1)], () => true)).toBeNull();
    // Given up on (dropped fork past giveUpMs): no longer blocks.
    expect(cursorTarget(sigs, [sig(3)], () => false)?.signature).toBe(sig(4));
  });

  it("RpcSource holds the cursor on a fetch miss, retries, then advances once fetched", async () => {
    const addr = FUMPAD_PROGRAM_ID.toBase58();
    const cursors = new Map<string, string | null>([[addr, null]]);
    const known = new Set<string>();
    let available = false;
    const listed = [info(3), info(2), info(1)]; // newest first, as RPC returns
    const db = {
      async query(sql: string, params: unknown[]) {
        if (sql.startsWith("INSERT INTO cursors")) return { rows: [] };
        if (sql.startsWith("SELECT address, last_signature")) return { rows: [...cursors].map(([address, last]) => ({ address, last_signature: last, last_slot: "0", backfill_done: true })) };
        if (sql.startsWith("SELECT signature FROM transactions")) return { rows: (params[0] as string[]).filter((s) => known.has(s)).map((signature) => ({ signature })) };
        if (sql.startsWith("UPDATE cursors SET last_signature")) cursors.set(params[0] as string, params[1] as string);
        return { rows: [] };
      },
    };
    const conn = {
      getSignaturesForAddress: async (_a: unknown, o: { until?: string }) => {
        if (_a && (_a as { toBase58(): string }).toBase58() !== addr) return [];
        const until = o.until ? listed.findIndex((s) => s.signature === o.until) : listed.length;
        return listed.slice(0, until);
      },
      getTransaction: async (s: string) =>
        s === sig(2) && !available ? null : ({ slot: 1, blockTime: 1, transaction: { signatures: [s], message: { accountKeys: [], instructions: [] } }, meta: { err: null } } as TxLike),
    };
    const ingestor = { ingest: async (tx: TxLike) => (known.add(tx.transaction.signatures[0]), { status: "applied" }), watchedPools: () => new Map() };
    const src = new RpcSource(conn as never, db as never, ingestor as never, { commitment: "confirmed", pageSize: 1000, backfillFromSlot: 0, reconcileDepth: 10, fetchAttempts: 1 }, log);
    await src.pollOnce();
    expect(cursors.get(addr)).toBe(sig(1)); // NOT sig(3): the old code jumped past sig(2)
    expect(src.missingSignatures).toEqual([sig(2)]);
    expect(known.has(sig(3))).toBe(true); // later txs still ingested (idempotent)
    await src.pollOnce();
    expect(cursors.get(addr)).toBe(sig(1)); // still missing → still held
    available = true;
    await src.pollOnce();
    expect(known.has(sig(2))).toBe(true);
    expect(src.missingSignatures).toEqual([]);
    expect(cursors.get(addr)).toBe(sig(3));
    void Keypair;
  });
});
