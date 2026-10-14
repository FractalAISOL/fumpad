/**
 * Live devnet 2026-10-14 regression: the Meteora bridge stored the first-coin launch tx (its first-buy swap) in
 * `transactions` before the fumpad poller saw it, and the poller treated any row there as "already ingested" — so
 * the tx's CoinRegistered was never applied (no `coins` row, API 404 for the coin). A row the bridge wrote
 * (kind 'meteora') must still reach the fumpad ingestor; a fumpad-ingested row must not.
 */
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { KNOWN_FUMPAD_TXS, RpcSource } from "../src/sources/rpc.js";

const log = { warn() {}, info() {}, debug() {}, error() {} } as never;

/** transactions rows: signature → kind. The fake db evaluates exactly the two "known" filters. */
function source(rows: Record<string, string>) {
  const ingested: string[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      const sigs = params[0] as string[];
      if (sql === KNOWN_FUMPAD_TXS) return { rows: sigs.filter((s) => rows[s] !== undefined && rows[s] !== "meteora").map((signature) => ({ signature })) };
      if (sql === "SELECT signature FROM transactions WHERE signature = ANY($1)") return { rows: sigs.filter((s) => rows[s] !== undefined).map((signature) => ({ signature })) };
      throw new Error(`unexpected sql ${sql}`);
    },
  } as never;
  const conn = { getTransaction: async (s: string) => ({ slot: 1, blockTime: 1, transaction: { signatures: [s], message: { accountKeys: [], instructions: [] } }, meta: { err: null } }) } as never;
  const ingestor = { ingest: async (tx: { transaction: { signatures: string[] } }) => (ingested.push(tx.transaction.signatures[0]), { status: "applied" }) } as never;
  const rpc = new RpcSource(conn, db, ingestor, { commitment: "confirmed", pageSize: 1000, backfillFromSlot: 0, reconcileDepth: 10, fetchAttempts: 1 }, log);
  return { rpc, ingested };
}

const sig = (s: string) => ({ signature: s, slot: 1 }) as ConfirmedSignatureInfo;

describe("fumpad poller vs Meteora bridge rows", () => {
  it("a tx the bridge stored first still gets its fumpad events; fumpad-ingested ones are skipped", async () => {
    const { rpc, ingested } = source({ launch: "meteora", done: "fumpad", noEvents: "none" });
    const r = await rpc.applySignatures([sig("launch"), sig("done"), sig("noEvents"), sig("fresh")], "rpc");
    expect(ingested).toEqual(["launch", "fresh"]);
    expect(r.applied).toBe(2);
  });
});
