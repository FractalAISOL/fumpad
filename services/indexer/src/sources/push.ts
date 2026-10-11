/**
 * Push sources — lower latency, never the source of truth for completeness (the RPC
 * poller + reconciler are):
 *
 * - Helius **raw** webhooks (`POST /helius`, Authorization = HELIUS_WEBHOOK_SECRET):
 *   payload is an array of transactions in `getTransaction` JSON shape → ingested
 *   directly at `confirmed`. Configure the webhook with accountAddresses = [fumpad,
 *   locker, …graduated pools] (pools: see README).
 * - `logsSubscribe` (any RPC websocket, incl. Helius): a log notification for a watched
 *   program just pokes the poller (cheaper than fetching each tx twice).
 *
 * LaserStream/Yellowstone gRPC can replace the websocket for very high volume; it would
 * plug in the same way (call `ingest` with each transaction).
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Connection, PublicKey } from "@solana/web3.js";

import { FUMPAD_PROGRAM_ID, LP_LOCKER_PROGRAM_ID, type TxLike } from "@fumpad/sdk";

import type { Ingestor } from "../ingest.js";
import type { Logger } from "../log.js";

export function heliusWebhookHandler(ingestor: Ingestor, log: Logger, secret?: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (secret && req.headers.authorization !== secret) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 20 * 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(c as Buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const txs = (Array.isArray(body) ? body : [body]) as TxLike[];
    // Ack fast (Helius retries on slow/failed responses); ingest in order afterwards.
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: txs.length }));
    for (const tx of txs) {
      if (!tx?.transaction?.signatures?.length || typeof tx.slot !== "number") continue;
      try {
        await ingestor.ingest(tx, "webhook", "confirmed");
      } catch (e) {
        log.warn({ err: String(e), signature: tx.transaction.signatures[0] }, "webhook ingest failed (poller will catch up)");
      }
    }
  };
}

/** Subscribe to program logs; each notification pokes the poller. Returns an unsubscribe fn. */
export function subscribeLogs(conn: Connection, poke: () => void, log: Logger): () => void {
  const ids: number[] = [];
  for (const p of [FUMPAD_PROGRAM_ID, LP_LOCKER_PROGRAM_ID]) {
    try {
      ids.push(conn.onLogs(new PublicKey(p), () => poke(), "confirmed"));
    } catch (e) {
      log.warn({ err: String(e) }, "logsSubscribe unavailable; polling only");
    }
  }
  return () => {
    for (const id of ids) void conn.removeOnLogsListener(id).catch(() => {});
  };
}
