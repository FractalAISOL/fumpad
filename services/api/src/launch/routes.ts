/**
 * `POST /v1/launch/prepare` (D18): reserve a pooled `…fmbL` mint and return a server-built
 * launch transaction (compute budget + create_coin [+ the creator's first buy]) that is
 * already signed by the mint. The creator's wallet is fee payer and the only other signer;
 * it signs and sends. The mint secret never leaves the server: the response carries only
 * the public key and a signature over this exact message.
 *
 * Why server-built (prepare) rather than co-signing a client-built tx: the server signs
 * only bytes it assembled itself, so there is no transaction parser to get wrong (no
 * smuggled instructions, lookup tables, extra writable accounts, or another fee payer
 * riding on the mint signature), and the client needs no SDK. The message can't be
 * altered afterwards without invalidating the mint signature.
 */
import { ComputeBudgetProgram, type Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";

import { type FumpadClient, isFumpadVanityMint, launchMetadataError } from "@fumpad/sdk";

import type { ApiConfig } from "../config.js";
import { LaunchError, type MintPool } from "./pool.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface PrepareBody {
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  /** Optional first buy, lamports as a decimal string (or safe integer). */
  initialBuyLamports?: string | number;
  slippageBps?: number;
  priorityMicroLamports?: number;
}

export interface PrepareResponse {
  mint: string;
  /** base64 v0 transaction, signed by the mint; the creator signs as fee payer. */
  transaction: string;
  lastValidBlockHeight: number;
  /** Reservation expiry (unix ms). Prepare again after the blockhash expires: the same mint comes back. */
  expiresAt: number;
  suffix: string;
  firstBuy?: { solIn: string; tokensOut: string; minTokensOut: string };
}

const bad = (msg: string) => new LaunchError(400, msg);

export function parsePrepareBody(body: unknown, cfg: Pick<ApiConfig, "launchMaxInitialBuyLamports" | "launchMaxPriorityMicroLamports">) {
  if (!body || typeof body !== "object") throw bad("JSON body required");
  const b = body as Record<string, unknown>;
  if (typeof b.creator !== "string" || !BASE58.test(b.creator)) throw bad("invalid creator");
  let creator: PublicKey;
  try {
    creator = new PublicKey(b.creator);
  } catch {
    throw bad("invalid creator");
  }
  // The creator signs in a wallet, so it must be a real ed25519 key, not a PDA.
  if (!PublicKey.isOnCurve(creator.toBytes())) throw bad("creator must be a wallet address");
  const metaErr = launchMetadataError({ name: b.name, symbol: b.symbol, uri: b.uri });
  if (metaErr) throw bad(metaErr);
  let initialBuyLamports = 0n;
  if (b.initialBuyLamports !== undefined && b.initialBuyLamports !== null && b.initialBuyLamports !== "") {
    const v = b.initialBuyLamports;
    if (!((typeof v === "string" && /^\d{1,20}$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0))) throw bad("invalid initialBuyLamports");
    initialBuyLamports = BigInt(v);
    if (initialBuyLamports > cfg.launchMaxInitialBuyLamports) throw bad("initialBuyLamports too large");
  }
  const slippageBps = b.slippageBps === undefined ? 100 : Number(b.slippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) throw bad("invalid slippageBps");
  const priority = b.priorityMicroLamports === undefined ? 0 : Number(b.priorityMicroLamports);
  if (!Number.isInteger(priority) || priority < 0 || priority > cfg.launchMaxPriorityMicroLamports) throw bad("invalid priorityMicroLamports");
  return { creator, name: b.name as string, symbol: b.symbol as string, uri: b.uri as string, initialBuyLamports, slippageBps, priority };
}

/** Sliding one-minute window per key (per API instance; the DB caps hold across instances). */
export class WindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs = 60_000) {}
  take(key: string, now = Date.now()): boolean {
    const xs = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (xs.length >= this.max) {
      this.hits.set(key, xs);
      return false;
    }
    xs.push(now);
    this.hits.set(key, xs);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

export function registerLaunchRoutes(app: FastifyInstance, cfg: ApiConfig, deps: { conn: Connection; client: FumpadClient; pool: MintPool | null }) {
  const perWallet = new WindowLimiter(cfg.launchWalletLimitPerMin);

  app.post(
    "/v1/launch/prepare",
    { config: { rateLimit: { max: cfg.launchRateLimitPerMin, timeWindow: "1 minute" } } },
    async (req, reply): Promise<PrepareResponse> => {
      if (!deps.pool) throw new LaunchError(503, "launches are not enabled on this server");
      const pool = deps.pool;
      const p = parsePrepareBody(req.body, cfg);
      const creator = p.creator.toBase58();
      if (!perWallet.take(creator)) throw new LaunchError(429, "too many launch attempts for this wallet, wait a minute", 60);
      let firstBuy: PrepareResponse["firstBuy"];
      const prepared = await pool.prepare(creator, req.ip, async (mint) => {
        if (!isFumpadVanityMint(mint, pool.cfg.suffix)) throw new Error("pooled mint has the wrong suffix");
        const built = await deps.client.buildLaunch({
          creator: p.creator,
          mint,
          name: p.name,
          symbol: p.symbol,
          uri: p.uri,
          initialBuyLamports: p.initialBuyLamports,
          slippageBps: p.slippageBps,
        });
        if (p.priority > 0) built.instructions.splice(1, 0, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priority }));
        if (built.quote) {
          firstBuy = {
            solIn: built.quote.solIn.toString(),
            tokensOut: built.quote.tokensOut.toString(),
            minTokensOut: (built.quote.tokensOut - (built.quote.tokensOut * BigInt(p.slippageBps)) / 10_000n).toString(),
          };
        }
        const { blockhash, lastValidBlockHeight } = await deps.conn.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({ payerKey: p.creator, recentBlockhash: blockhash, instructions: built.instructions }).compileToV0Message();
        return { tx: new VersionedTransaction(msg), lastValidBlockHeight };
      });
      req.log.info({ creator, mint: prepared.mint, reused: prepared.reusedReservation }, "launch prepared");
      reply.header("cache-control", "no-store");
      return {
        mint: prepared.mint,
        transaction: Buffer.from(prepared.tx.serialize()).toString("base64"),
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        expiresAt: prepared.expiresAt,
        suffix: pool.cfg.suffix,
        firstBuy,
      };
    },
  );
}
