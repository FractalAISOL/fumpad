/**
 * Push sources — lower latency, never the source of truth for completeness (the RPC
 * poller + reconciler are):
 *
 * - Helius webhooks (`POST /helius`, Authorization = HELIUS_WEBHOOK_SECRET, compared in
 *   constant time; body ≤ WEBHOOK_MAX_BODY_BYTES). The body is treated as a HINT only
 *   (H-1): we take the signatures out of it (raw or enhanced shape) and re-fetch each one
 *   from our own RPC before ingesting (`RpcSource.hint`). A forged body can at most make us
 *   look at a real signature early. Configure the webhook with accountAddresses = [fumpad,
 *   locker, …graduated pools] (pools: see README).
 * - `logsSubscribe` (any RPC websocket, incl. Helius): a log notification for a watched
 *   program just pokes the poller (cheaper than fetching each tx twice).
 *
 * LaserStream/Yellowstone gRPC can replace the websocket for very high volume; it would
 * plug in the same way (call `ingest` with each transaction).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Connection, PublicKey } from "@solana/web3.js";

import { FUMPAD_PROGRAM_ID } from "@fumpad/sdk";

import type { Logger } from "../log.js";

const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export interface WebhookOptions {
  /** Required: the handler refuses to exist without it. */
  secret: string;
  maxBodyBytes?: number;
  /** Signatures taken from one request (the rest are dropped; the poller still sees them). */
  maxSignatures?: number;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time comparison of the Authorization header with the shared secret. */
export function webhookAuthorized(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== "string" || !secret) return false;
  // Equal-length digests: no length leak, no early exit.
  return timingSafeEqual(digest(header), digest(secret));
}

/** Signatures named in a Helius payload (raw `getTransaction` shape or enhanced `{signature}`). */
export function webhookSignatures(body: unknown, max = 100): string[] {
  const items = Array.isArray(body) ? body : [body];
  const out = new Set<string>();
  for (const it of items) {
    if (out.size >= max) break;
    const o = it as { signature?: unknown; transaction?: { signatures?: unknown[] } } | null;
    const sig = typeof o?.signature === "string" ? o.signature : o?.transaction?.signatures?.[0];
    if (typeof sig === "string" && SIG.test(sig)) out.add(sig);
  }
  return [...out];
}

/**
 * `POST /helius`. `onSignatures` receives only validated signature strings (the caller
 * re-fetches them from RPC); nothing from the body reaches the database.
 */
export function heliusWebhookHandler(onSignatures: (sigs: string[]) => void, log: Logger, opts: WebhookOptions) {
  if (!opts?.secret) throw new Error("heliusWebhookHandler: a secret is required");
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (!webhookAuthorized(req.headers.authorization, opts.secret)) {
      res.writeHead(401).end();
      req.resume();
      return;
    }
    if (Number(req.headers["content-length"] ?? 0) > maxBody) {
      res.writeHead(413, { connection: "close" }).end();
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > maxBody) {
          res.writeHead(413, { connection: "close" }).end();
          req.destroy();
          return;
        }
        chunks.push(c as Buffer);
      }
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const sigs = webhookSignatures(body, opts.maxSignatures ?? 100);
    // Ack fast (Helius retries on slow/failed responses); verification happens off the request.
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: sigs.length }));
    if (sigs.length) {
      try {
        onSignatures(sigs);
      } catch (e) {
        log.warn({ err: String(e) }, "webhook hint failed (poller will catch up)");
      }
    }
  };
}

/** Subscribe to program logs; each notification pokes the poller. Returns an unsubscribe fn. */
export function subscribeLogs(conn: Connection, poke: () => void, log: Logger): () => void {
  const ids: number[] = [];
  for (const p of [FUMPAD_PROGRAM_ID]) {
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
