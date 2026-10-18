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
 *
 * The message is v0 through the FUMPAD launch lookup table (LAUNCH_ALT, ./alt.ts): its address, verified on chain
 * (exact contents, frozen), is the only table a launch uses; inline only on localnet without LAUNCH_ALT.
 */
import { type Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";

import { decodeDbcConfig, type DbcVirtualPool, FEE_POLICY, type FeePolicy, type GlobalAccount, isFumpadVanityMint, LAUNCH_TX_MAX_BYTES, launchInstructions, launchMetadataError, quoteDbcBuy } from "@fumpad/sdk";

import type { ChainReader } from "../chain.js";

import type { Db } from "@fumpad/indexer";

import type { ApiConfig } from "../config.js";
import { LaunchAltCache } from "./alt.js";
import { checkLaunchAuth, NonceStore } from "./auth.js";
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

/** What the app launched with before metadata uploads existed; still the devnet fallback without PINATA_JWT (./metadata.ts). */
export const PLACEHOLDER_URI = "ipfs://pending";

/** 403 code + message when standard launches are closed (LAUNCHES_OPEN=false); the app shows a "launches open soon" state. */
export const LAUNCHES_CLOSED_CODE = "launches_closed";
export const LAUNCHES_CLOSED_MESSAGE = "Launches open soon";

/** 403 code when a wallet other than FIRST_COIN_CREATOR asks for the first-coin config (audit S-2 / H-3). */
export const FIRST_COIN_NOT_ALLOWED_CODE = "first_coin_not_allowed";

/** Who may use the first-coin config: null = disabled (LAUNCH_FIRST_COIN unset), else the one allow-listed wallet. */
export type FirstCoinGate = { allowedCreator: string } | null;

export const firstCoinGate = (cfg: Pick<ApiConfig, "launchFirstCoin" | "firstCoinCreator">): FirstCoinGate =>
  cfg.launchFirstCoin && cfg.firstCoinCreator ? { allowedCreator: cfg.firstCoinCreator } : null;

/**
 * The launch gates, before anything is signed, reserved or pinned:
 * - LAUNCHES_OPEN: a standard launch is refused while launches are closed;
 * - first coin (audit S-2 / H-3): only with LAUNCH_FIRST_COIN=true AND only for FIRST_COIN_CREATOR. It bypasses
 *   LAUNCHES_OPEN and our launch key co-signs it, so it must never be "any wallet". `pickLaunchConfig` checks again.
 */
export function assertLaunchAllowed(kind: LaunchConfigKind, launchesOpen: boolean, firstCoin: FirstCoinGate, creator: string): void {
  if (kind === "standard") {
    if (!launchesOpen) throw new LaunchError(403, LAUNCHES_CLOSED_MESSAGE, undefined, LAUNCHES_CLOSED_CODE);
    return;
  }
  if (!firstCoin) throw new LaunchError(403, "the first-coin launch config is not enabled on this server");
  if (creator !== firstCoin.allowedCreator) throw new LaunchError(403, "the first-coin launch config is reserved for the FUMPAD team wallet", undefined, FIRST_COIN_NOT_ALLOWED_CODE);
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
  /**
   * The launch lookup table the transaction uses (LAUNCH_ALT), absent for an inline launch (localnet). Informational:
   * the app resolves and verifies its OWN configured table (NEXT_PUBLIC_LAUNCH_ALT) and refuses any other.
   */
  lookupTable?: string;
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
 * (`max_coins` 0 = unlimited) — refused unless the server enables it (LAUNCH_FIRST_COIN=true) and `creator` is the
 * allow-listed FIRST_COIN_CREATOR (S-2 / H-3).
 */
export function pickLaunchConfig(
  g: Pick<GlobalAccount, "configs" | "configPolicies" | "configCoins">,
  kind: LaunchConfigKind,
  firstCoin: FirstCoinGate,
  creator: string,
): { dbcConfig: PublicKey; policy: FeePolicy; coins: number } {
  const slots = g.configs.map((k, i) => ({ dbcConfig: k, policy: g.configPolicies[i], coins: g.configCoins[i] })).filter((s) => !s.dbcConfig.equals(PublicKey.default));
  if (kind === "standard") {
    const s = slots.find((x) => x.policy.kind === FEE_POLICY.standard);
    if (!s) throw new LaunchError(503, "no FUMPAD DBC config is allow-listed yet");
    return s;
  }
  assertLaunchAllowed(kind, false, firstCoin, creator);
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

/** The signed-message policy both launch routes apply (M-2 + L-3). */
export const launchAuthPolicy = (cfg: ApiConfig) => ({
  maxAgeSecs: cfg.launchSignatureMaxAgeSecs,
  domains: cfg.launchAuthDomains,
  cluster: cfg.launchAuthCluster,
  allowLegacy: cfg.launchAuthAllowLegacy,
});

export function registerLaunchRoutes(
  app: FastifyInstance,
  cfg: ApiConfig,
  deps: { conn: Connection; chain: ChainReader; pool: MintPool | null; db: Db; alt?: LaunchAltCache; nonces?: NonceStore },
) {
  const perWallet = new WindowLimiter(cfg.launchWalletLimitPerMin);
  const firstCoin = firstCoinGate(cfg);
  const nonces = deps.nonces ?? new NonceStore();
  const alts = deps.alt ?? new LaunchAltCache(deps.conn, cfg);
  if (alts.disabledReason) app.log.error({ reason: alts.disabledReason }, "launches DISABLED: POST /v1/launch/prepare answers 503");
  const launchKey = parseLaunchSignerKey(cfg.launchSignerKey);
  const t = cfg.launchRpcTimeoutMs;

  app.post(
    "/v1/launch/prepare",
    { config: { rateLimit: { max: cfg.launchRateLimitPerMin, timeWindow: "1 minute" } } },
    async (req, reply): Promise<PrepareResponse> => {
      const p = parsePrepareBody(req.body, cfg);
      const creator = p.creator.toBase58();
      // LAUNCHES_OPEN: no standard launch before the public opening; first coin: FIRST_COIN_CREATOR only (S-2).
      // Nothing reserved, nothing signed.
      assertLaunchAllowed(p.launchConfig, cfg.launchesOpen, firstCoin, creator);
      // Mainnet: a coin's metadata is permanent, so never launch one with the placeholder (no logo, no socials).
      if (cfg.metadataRequired && p.uri.trim() === PLACEHOLDER_URI) throw new LaunchError(400, "the coin's metadata wasn't uploaded, try again");
      if (!deps.pool) throw new LaunchError(503, "launches are not enabled on this server");
      const pool = deps.pool;
      // M-2: proof of wallet control before anything is reserved; L-3: domain + cluster bound, nonce single use.
      let releaseNonce = () => {};
      if (cfg.launchRequireSignature) {
        const a = checkLaunchAuth(nonces, "prepare", p.auth, { creator: p.creator, symbol: p.symbol }, launchAuthPolicy(cfg));
        if (!a.ok) throw new LaunchError(401, a.error);
        releaseNonce = a.release;
      }
      try {
        return await prepareChecked();
      } catch (e) {
        // Nothing new was signed for this request: the app may retry with the same signature.
        releaseNonce();
        throw e;
      }
      async function prepareChecked(): Promise<PrepareResponse> {
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
        const slot = pickLaunchConfig(g, p.launchConfig, firstCoin, creator);
        const dbcConfig = slot.dbcConfig;
        const cfgAcc = await withTimeout(deps.conn.getAccountInfo(dbcConfig, "confirmed"), t, "config lookup");
        if (!cfgAcc) throw new LaunchError(503, "the FUMPAD DBC config is missing");
        const config = decodeDbcConfig(new Uint8Array(cfgAcc.data));
        // The launch lookup table, verified (fail closed: 503 before anything is reserved).
        const alt = await withTimeout(alts.get(), t, "lookup table lookup").catch((e: unknown) => {
          if (alts.lastError) req.log.error({ alt: cfg.launchAlt, err: alts.lastError }, "launch lookup table check failed");
          throw e;
        });
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
          const msg = new TransactionMessage({ payerKey: p.creator, recentBlockhash: blockhash, instructions }).compileToV0Message(alt ? [alt] : []);
          const tx = new VersionedTransaction(msg);
          // 1,232-byte packet limit: refuse before reserving a signature on it
          if (tx.serialize().length > LAUNCH_TX_MAX_BYTES) throw new LaunchError(400, "name, symbol and uri are too long to fit in one launch transaction; shorten the uri");
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
          ...(alt ? { lookupTable: alt.key.toBase58() } : {}),
        };
      }
    },
  );

  // Whether standard launches are open (LAUNCHES_OPEN) and whether this server offers the first-coin launch config
  // right now (the app shows a "launches open soon" state / the first-coin option accordingly). S-2: the first-coin
  // option is shown only to `?creator=<FIRST_COIN_CREATOR>` (the app asks with the connected wallet); every other
  // caller gets `firstCoin: null`, exactly as when it is off.
  app.get("/v1/launch/options", { schema: { querystring: { type: "object", properties: { creator: { type: "string", maxLength: 64 } } } } }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const launchesOpen = cfg.launchesOpen;
    const asked = (req.query as { creator?: string }).creator;
    if (!firstCoin || !deps.pool || asked !== firstCoin.allowedCreator) return { launchesOpen, firstCoin: null };
    const g = await withTimeout(deps.chain.global(), t, "global lookup");
    try {
      const s = pickLaunchConfig(g, "first_coin", firstCoin, asked);
      return { launchesOpen, firstCoin: { dbcConfig: s.dbcConfig.toBase58(), wallet: s.policy.wallet.toBase58(), buybackShareBps: s.policy.buybackShare, walletShareBps: s.policy.walletShare, launchesLeft: s.policy.maxCoins === 0 ? null : s.policy.maxCoins - s.coins } };
    } catch {
      return { launchesOpen, firstCoin: null };
    }
  });
}
