/**
 * `POST /v1/launch/prepare` (D18, SPEC v0.7 §2): reserve a pooled `…fmbL` mint and return a server-built
 * launch transaction — DBC `initialize_virtual_pool_with_token2022` on the FUMPAD config (the first
 * config in `Global.configs`) → [the creator's top-level DBC swap2, which gets the min fee] →
 * fumpad `register_coin` — already signed by the mint. The creator's wallet is fee payer and the only other signer;
 * it signs and sends. The mint secret never leaves the server: the response carries only
 * the public key and a signature over this exact message.
 *
 * Why server-built (prepare) rather than co-signing a client-built tx: the server signs
 * only bytes it assembled itself, so there is no transaction parser to get wrong (no
 * smuggled instructions, lookup tables, extra writable accounts, or another fee payer
 * riding on the mint signature), and the client needs no SDK. The message can't be
 * altered afterwards without invalidating the mint signature.
 */
import { type Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";

import { decodeDbcConfig, type DbcVirtualPool, FEE_POLICY, type FeePolicy, type GlobalAccount, isFumpadVanityMint, launchInstructions, launchMetadataError, quoteDbcBuy } from "@fumpad/sdk";

import type { ChainReader } from "../chain.js";

import type { Db } from "@fumpad/indexer";

import type { ApiConfig } from "../config.js";
import { launchAuthError } from "./auth.js";
import { LaunchError, type MintPool, withTimeout } from "./pool.js";
import { launchSignerFor, parseLaunchSignerKey } from "./signer.js";

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
  /** M-2: `{ message, signature }`, see launch/auth.ts (required unless LAUNCH_REQUIRE_SIGNATURE=false). */
  auth?: { message: string; signature: string };
  /**
   * "standard" (default): the first allow-listed config with the standard fee policy. "first_coin": the one-off
   * first-coin config (3% fee, wallet-split policy) — only when the server runs with LAUNCH_FIRST_COIN=true and the
   * config is allow-listed with launches left (`max_coins`).
   */
  launchConfig?: LaunchConfigKind;
}

export type LaunchConfigKind = "standard" | "first_coin";

/** 403 code + message when standard launches are closed (LAUNCHES_OPEN=false); the app shows a "launches open soon" state. */
export const LAUNCHES_CLOSED_CODE = "launches_closed";
export const LAUNCHES_CLOSED_MESSAGE = "Launches open soon";

/**
 * The LAUNCHES_OPEN gate: refuses a standard launch while launches are closed. The first-coin path is never gated
 * here (it has its own switch, LAUNCH_FIRST_COIN, checked in `pickLaunchConfig`).
 */
export function assertLaunchAllowed(kind: LaunchConfigKind, launchesOpen: boolean): void {
  if (kind === "standard" && !launchesOpen) throw new LaunchError(403, LAUNCHES_CLOSED_MESSAGE, undefined, LAUNCHES_CLOSED_CODE);
}

/** The config a prepared launch uses, with its real fees (the app shows these; it re-checks them on chain). */
export interface LaunchConfigInfo {
  kind: LaunchConfigKind;
  dbcConfig: string;
  /** Normal curve fee (bps), launch-window start fee (bps) over `snipeWindowSlots`, DAMM v2 fee after graduation (bps). */
  feeBps: number;
  snipeStartBps: number;
  snipeWindowSlots: number;
  migratedPoolFeeBps: number;
  feePolicy: { kind: number; buybackShareBps: number; walletShareBps: number; wallet: string | null; maxCoins: number; coinsRegistered: number };
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
  /** The DBC config + fee policy this launch uses (always present; `kind` "first_coin" only when asked for). */
  config: LaunchConfigInfo;
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
  const launchConfig = b.launchConfig === undefined || b.launchConfig === null ? "standard" : b.launchConfig;
  if (launchConfig !== "standard" && launchConfig !== "first_coin") throw bad("invalid launchConfig");
  return { creator, name: b.name as string, symbol: b.symbol as string, uri: b.uri as string, initialBuyLamports, slippageBps, priority, auth: b.auth, launchConfig: launchConfig as LaunchConfigKind };
}

/**
 * The allow-list slot a launch uses. "standard": the first slot with the standard fee policy (never the first-coin
 * config, whatever its position). "first_coin": the first wallet-split slot that still has launches left
 * (`max_coins` 0 = unlimited) — refused unless the server enables it (LAUNCH_FIRST_COIN=true).
 */
export function pickLaunchConfig(g: Pick<GlobalAccount, "configs" | "configPolicies" | "configCoins">, kind: LaunchConfigKind, firstCoinEnabled: boolean): { dbcConfig: PublicKey; policy: FeePolicy; coins: number } {
  const slots = g.configs.map((k, i) => ({ dbcConfig: k, policy: g.configPolicies[i], coins: g.configCoins[i] })).filter((s) => !s.dbcConfig.equals(PublicKey.default));
  if (kind === "standard") {
    const s = slots.find((x) => x.policy.kind === FEE_POLICY.standard);
    if (!s) throw new LaunchError(503, "no FUMPAD DBC config is allow-listed yet");
    return s;
  }
  if (!firstCoinEnabled) throw new LaunchError(403, "the first-coin launch config is not enabled on this server");
  const s = slots.find((x) => x.policy.kind === FEE_POLICY.walletSplit && (x.policy.maxCoins === 0 || x.coins < x.policy.maxCoins));
  if (!s) throw new LaunchError(409, "the first-coin launch config is not available (not allow-listed, or its launch was used)");
  return s;
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

export function registerLaunchRoutes(app: FastifyInstance, cfg: ApiConfig, deps: { conn: Connection; chain: ChainReader; pool: MintPool | null; db: Db }) {
  const perWallet = new WindowLimiter(cfg.launchWalletLimitPerMin);
  const launchKey = parseLaunchSignerKey(cfg.launchSignerKey);
  const t = cfg.launchRpcTimeoutMs;

  app.post(
    "/v1/launch/prepare",
    { config: { rateLimit: { max: cfg.launchRateLimitPerMin, timeWindow: "1 minute" } } },
    async (req, reply): Promise<PrepareResponse> => {
      const p = parsePrepareBody(req.body, cfg);
      // LAUNCHES_OPEN: no standard launch before the public opening (nothing reserved, nothing signed).
      assertLaunchAllowed(p.launchConfig, cfg.launchesOpen);
      if (!deps.pool) throw new LaunchError(503, "launches are not enabled on this server");
      const pool = deps.pool;
      const creator = p.creator.toBase58();
      // M-2: proof of wallet control before anything is reserved.
      if (cfg.launchRequireSignature) {
        const err = launchAuthError(p.auth, { creator: p.creator, symbol: p.symbol }, { maxAgeSecs: cfg.launchSignatureMaxAgeSecs });
        if (err) throw new LaunchError(401, err);
      }
      if (!perWallet.take(creator)) throw new LaunchError(429, "too many launch attempts for this wallet, wait a minute", 60);
      // Funded wallets only (RPC outside any DB transaction, bounded).
      if (cfg.launchMinBalanceLamports > 0n) {
        const bal = BigInt(await withTimeout(deps.conn.getBalance(p.creator, "confirmed"), t, "balance lookup"));
        if (bal < cfg.launchMinBalanceLamports) throw new LaunchError(400, `wallet needs at least ${Number(cfg.launchMinBalanceLamports) / 1e9} SOL to launch`);
      }
      const established = (await deps.db.query("SELECT 1 FROM users WHERE address = $1", [creator])).rowCount! > 0;
      let firstBuy: PrepareResponse["firstBuy"];
      const g = await withTimeout(deps.chain.global(), t, "global lookup");
      // L1: when the program requires the launch co-signature, this API's key signs register_coin
      const launchSigner = launchSignerFor(g.params.launchSigner, launchKey);
      const slot = pickLaunchConfig(g, p.launchConfig, cfg.launchFirstCoin);
      const dbcConfig = slot.dbcConfig;
      const cfgAcc = await withTimeout(deps.conn.getAccountInfo(dbcConfig, "confirmed"), t, "config lookup");
      if (!cfgAcc) throw new LaunchError(503, "the FUMPAD DBC config is missing");
      const config = decodeDbcConfig(new Uint8Array(cfgAcc.data));
      const bf = config.baseFee;
      const configInfo: LaunchConfigInfo = {
        kind: p.launchConfig,
        dbcConfig: dbcConfig.toBase58(),
        feeBps: Number((bf.cliffFeeNumerator - bf.reductionFactor * BigInt(bf.numberOfPeriod)) / 100_000n),
        snipeStartBps: Number(bf.cliffFeeNumerator / 100_000n),
        snipeWindowSlots: bf.numberOfPeriod * Number(bf.periodFrequency),
        migratedPoolFeeBps: config.migratedPoolFeeBps,
        feePolicy: {
          kind: slot.policy.kind,
          buybackShareBps: slot.policy.buybackShare,
          walletShareBps: slot.policy.walletShare,
          wallet: slot.policy.kind === FEE_POLICY.standard ? null : slot.policy.wallet.toBase58(),
          maxCoins: slot.policy.maxCoins,
          coinsRegistered: slot.coins,
        },
      };
      const prepared = await pool.prepare(creator, req.ip, async (mint) => {
        if (!isFumpadVanityMint(mint, pool.cfg.suffix)) throw new Error("pooled mint has the wrong suffix");
        let minTokensOut = 0n;
        if (p.initialBuyLamports > 0n) {
          // The pool's first swap in the creation tx pays the scheduler's minimum fee (1.25%; 3% on the first-coin config), from the start price.
          const fresh = { sqrtPrice: config.sqrtStartPrice, activationPoint: 0n, quoteReserve: 0n } as DbcVirtualPool;
          const q = quoteDbcBuy(config, fresh, p.initialBuyLamports, 0n, { firstSwapMinFee: true });
          minTokensOut = q.amountOut - (q.amountOut * BigInt(p.slippageBps)) / 10_000n;
          firstBuy = { solIn: p.initialBuyLamports.toString(), tokensOut: q.amountOut.toString(), minTokensOut: minTokensOut.toString() };
        }
        const instructions = launchInstructions({
          creator: p.creator,
          mint,
          dbcConfig,
          name: p.name,
          symbol: p.symbol,
          uri: p.uri,
          buyLamports: p.initialBuyLamports,
          minTokensOut,
          priorityMicroLamports: p.priority > 0 ? p.priority : undefined,
          launchSigner: launchSigner?.publicKey,
        });
        const { blockhash, lastValidBlockHeight } = await deps.conn.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({ payerKey: p.creator, recentBlockhash: blockhash, instructions }).compileToV0Message();
        const tx = new VersionedTransaction(msg);
        // 1,232-byte packet limit (no lookup tables in a launch tx): refuse before reserving a signature on it
        if (tx.serialize().length > 1_232) throw new LaunchError(400, "name, symbol and uri are too long to fit in one launch transaction; shorten the uri");
        if (launchSigner) tx.sign([launchSigner]); // the mint signs next (pool.prepare), the creator last
        return { tx, lastValidBlockHeight };
      }, { established });
      req.log.info({ creator, mint: prepared.mint, reused: prepared.reusedReservation, launchConfig: p.launchConfig }, "launch prepared");
      reply.header("cache-control", "no-store");
      return {
        mint: prepared.mint,
        transaction: Buffer.from(prepared.tx.serialize()).toString("base64"),
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        expiresAt: prepared.expiresAt,
        suffix: pool.cfg.suffix,
        firstBuy,
        config: configInfo,
      };
    },
  );

  // Whether standard launches are open (LAUNCHES_OPEN) and whether this server offers the first-coin launch config
  // right now (the app shows a "launches open soon" state / the first-coin option accordingly).
  app.get("/v1/launch/options", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    const launchesOpen = cfg.launchesOpen;
    if (!cfg.launchFirstCoin || !deps.pool) return { launchesOpen, firstCoin: null };
    const g = await withTimeout(deps.chain.global(), t, "global lookup");
    try {
      const s = pickLaunchConfig(g, "first_coin", true);
      return { launchesOpen, firstCoin: { dbcConfig: s.dbcConfig.toBase58(), wallet: s.policy.wallet.toBase58(), buybackShareBps: s.policy.buybackShare, walletShareBps: s.policy.walletShare, launchesLeft: s.policy.maxCoins === 0 ? null : s.policy.maxCoins - s.coins } };
    } catch {
      return { launchesOpen, firstCoin: null };
    }
  });
}
