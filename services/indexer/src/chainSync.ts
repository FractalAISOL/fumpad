/**
 * Chain snapshot of touched coins (v0.7): after events touch a mint, re-read the Coin account, the reward
 * vault, the DBC pool + config (curve) and, once graduated, the DAMM v2 pool, so values events don't carry
 * exactly (reward-vault balance, buyback balance, unclaimed fees, current sqrt price + liquidity → virtual
 * reserves for quotes, the curve's quote threshold) are exact. Debounced per mint; also fetches the coin's
 * off-chain metadata JSON once.
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { coinPda, dbcLiquidityAt, decodeCoin, decodeDammPool, decodeDbcConfig, decodeDbcPool, decodeTokenAccount, priceQ64FromSqrt, rewardVault, virtualReserves } from "@fumpad/sdk";

import type { Db } from "./db.js";
import { configFees, curveFromConfig } from "./params.js";
import type { Logger } from "./log.js";
import { safeFetch, SafeFetchError, type SafeFetchOptions } from "./safeFetch.js";

export class ChainSync {
  private queue = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private configs = new Map<string, ReturnType<typeof decodeDbcConfig>>();
  stats = { synced: 0, errors: 0 };

  constructor(private conn: Connection, private db: Db, private log: Logger, private opts: { debounceMs: number; fetchMetadata: boolean; metadataFetch?: SafeFetchOptions }) {}

  enqueue(mints: string[]) {
    for (const m of mints) this.queue.add(m);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.opts.debounceMs);
  }

  async flush(): Promise<void> {
    this.timer = null;
    const mints = [...this.queue];
    this.queue.clear();
    for (const m of mints) {
      try {
        await this.syncMint(m);
        this.stats.synced++;
      } catch (e) {
        this.stats.errors++;
        this.log.warn({ mint: m, err: String(e) }, "chain sync failed");
      }
    }
  }

  async syncMint(mint: string): Promise<void> {
    const m = new PublicKey(mint);
    const [coinAcc, vaultAcc] = await this.conn.getMultipleAccountsInfo([coinPda(m), rewardVault(m)], "confirmed");
    if (!coinAcc) return;
    const c = decodeCoin(new Uint8Array(coinAcc.data));
    const graduated = c.status === "graduated" && !c.dammPool.equals(PublicKey.default);
    const [poolAcc] = await this.conn.getMultipleAccountsInfo([graduated ? c.dammPool : c.dbcPool], "confirmed");
    const cfgKey = c.dbcConfig.toBase58();
    if (!this.configs.has(cfgKey)) {
      const a = await this.conn.getAccountInfo(c.dbcConfig, "confirmed");
      if (a) this.configs.set(cfgKey, decodeDbcConfig(new Uint8Array(a.data)));
    }
    const cfg = this.configs.get(cfgKey);
    const vault = vaultAcc ? decodeTokenAccount(new Uint8Array(vaultAcc.data)).amount : null;
    let sqrt: bigint | null = null;
    let liquidity: bigint | null = null;
    let ammBase: bigint | null = null;
    let ammQuote: bigint | null = null;
    let realSol: bigint | null = null;
    let tokensLeft: bigint | null = null;
    if (poolAcc && graduated) {
      const p = decodeDammPool(new Uint8Array(poolAcc.data));
      sqrt = p.sqrtPrice;
      liquidity = p.liquidity;
      ammBase = p.tokenAAmount;
      ammQuote = p.tokenBAmount;
    } else if (poolAcc && cfg) {
      const p = decodeDbcPool(new Uint8Array(poolAcc.data));
      sqrt = p.sqrtPrice;
      liquidity = dbcLiquidityAt(cfg, p.sqrtPrice);
      realSol = p.quoteReserve;
      // base still sellable before the migration price, on the current segment(s)
      tokensLeft = 0n;
      let cur = p.sqrtPrice;
      for (const seg of cfg.curve) {
        const top = seg.sqrtPrice < cfg.migrationSqrtPrice ? seg.sqrtPrice : cfg.migrationSqrtPrice;
        if (top <= cur) continue;
        tokensLeft += (seg.liquidity * (top - cur)) / (cur * top);
        cur = top;
        if (top === cfg.migrationSqrtPrice) break;
      }
    }
    const v = sqrt !== null && liquidity ? virtualReserves(sqrt, liquidity) : null;
    // The coin's own fee schedule (its config's; the first-coin config trades at 3%, INTERFACE §5.9).
    const fees = cfg ? configFees(curveFromConfig(cfg)) : null;
    await this.db.query(
      `UPDATE coins SET status = $2, pool_tokens = COALESCE($3, pool_tokens), buyback_pending = $4, platform_fees_unclaimed = $5, creator_fees_unclaimed = $6,
          sqrt_price = COALESCE($7, sqrt_price), liquidity = COALESCE($8, liquidity),
          virtual_sol = COALESCE($9, virtual_sol), virtual_tokens = COALESCE($10, virtual_tokens),
          price_q64 = COALESCE($11, price_q64), amm_base = COALESCE($12, amm_base), amm_quote = COALESCE($13, amm_quote),
          real_sol = COALESCE($14, real_sol), real_tokens = COALESCE($15, real_tokens), migration_threshold = COALESCE($16, migration_threshold),
          dbc_pool = COALESCE(dbc_pool, $17), dbc_config = COALESCE(dbc_config, $18),
          damm_pool = COALESCE($19, damm_pool), damm_position = COALESCE($20, damm_position),
          completed_at = COALESCE(completed_at, $21), graduated_at = COALESCE(graduated_at, $22),
          fee_bps = COALESCE(fee_bps, $23), snipe_start_bps = COALESCE(snipe_start_bps, $24), snipe_window_slots = COALESCE(snipe_window_slots, $25),
          migrated_fee_bps = COALESCE(migrated_fee_bps, $26), fee_policy_kind = $27,
          chain_synced_at = now()
        WHERE mint = $1`,
      [
        mint, c.status, vault?.toString() ?? null, c.buybackLamports.toString(), c.platformFeesUnclaimed.toString(), c.creatorFeesUnclaimed.toString(),
        sqrt?.toString() ?? null, liquidity?.toString() ?? null, v?.quote.toString() ?? null, v?.base.toString() ?? null,
        sqrt !== null ? priceQ64FromSqrt(sqrt).toString() : null, ammBase?.toString() ?? null, ammQuote?.toString() ?? null,
        realSol?.toString() ?? null, tokensLeft?.toString() ?? null, cfg?.migrationQuoteThreshold.toString() ?? null,
        c.dbcPool.toBase58(), cfgKey,
        graduated ? c.dammPool.toBase58() : null, graduated && !c.dammPosition.equals(PublicKey.default) ? c.dammPosition.toBase58() : null,
        c.completedAt ? c.completedAt.toString() : null, c.graduatedAt ? c.graduatedAt.toString() : null,
        fees?.feeBps ?? null, fees?.snipeStartBps ?? null, fees?.snipeWindowSlots ?? null, fees?.migratedPoolFeeBps ?? null, c.feePolicyKind ?? 0,
      ],
    );
    if (this.opts.fetchMetadata) await this.fetchMetadata(mint);
  }

  /**
   * Off-chain metadata JSON (M-3): any coin can carry any `uri`, so it is fetched under the
   * SSRF policy (safeFetch: https/ipfs/ar only, public addresses only incl. every redirect
   * hop, 64 KiB, 5 s; IPFS content through the configured gateways in order). Only short strings are kept;
   * failures store a coarse error code (never the network error text, which would map internal hosts/ports)
   * and are retried with backoff (`retryMetadata`, at most METADATA_MAX_ATTEMPTS fetches in all): a freshly pinned
   * IPFS file can take a while to reach a public gateway.
   */
  private async fetchMetadata(mint: string, force = false) {
    const r = await this.db.query<{ uri: string; metadata: unknown }>("SELECT uri, metadata FROM coins WHERE mint = $1", [mint]);
    const row = r.rows[0];
    if (!row || !row.uri || !/^(https?|ipfs|ar):\/\//i.test(row.uri)) return;
    const prev = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null;
    const attempts = prev && typeof prev.attempts === "number" ? prev.attempts : prev ? 1 : 0;
    if (prev && !(prev.error && (force || metadataRetryDue(prev, Date.now())))) return;
    if (attempts >= METADATA_MAX_ATTEMPTS) return;
    let meta: Record<string, unknown> = { fetchedAt: Date.now() };
    try {
      const res = await safeFetch(row.uri, { timeoutMs: 5_000, maxBytes: 64 * 1024, maxRedirects: 3, ...this.opts.metadataFetch });
      if (res.status !== 200) throw new SafeFetchError("http", "status");
      const j = JSON.parse(res.body.toString("utf8")) as Record<string, unknown>;
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new SafeFetchError("http", "not an object");
      meta = { ...meta, ...pickMetadata(j) };
    } catch (e) {
      meta.error = e instanceof SafeFetchError ? e.code : e instanceof SyntaxError ? "invalid_json" : "failed";
      meta.attempts = attempts + 1;
    }
    await this.db.query("UPDATE coins SET metadata = $2 WHERE mint = $1", [mint, JSON.stringify(meta)]);
  }

  /** Re-fetch metadata that failed, once its backoff is due (a few coins per run). */
  async retryMetadata(limit = 20): Promise<number> {
    if (!this.opts.fetchMetadata) return 0;
    const r = await this.db.query<{ mint: string; metadata: Record<string, unknown> }>(
      `SELECT mint, metadata FROM coins
        WHERE metadata ? 'error' AND COALESCE((metadata->>'attempts')::int, 1) < $1
        ORDER BY (metadata->>'fetchedAt')::bigint ASC LIMIT $2`,
      [METADATA_MAX_ATTEMPTS, limit * 4],
    );
    const now = Date.now();
    let n = 0;
    for (const row of r.rows) {
      if (n >= limit) break;
      if (!metadataRetryDue(row.metadata, now)) continue;
      n++;
      try {
        await this.fetchMetadata(row.mint, true);
      } catch (e) {
        this.log.warn({ mint: row.mint, err: String(e) }, "metadata retry failed");
      }
    }
    return n;
  }
}

/** Fetches per coin before a failing metadata URI is given up on (≈ 1 + 2 + 4 + 8 + 16 min of backoff). */
export const METADATA_MAX_ATTEMPTS = 6;

/** A failed fetch is retried after 1, 2, 4, 8, 16 min. */
export function metadataRetryDue(md: Record<string, unknown>, now: number): boolean {
  if (!md.error) return false;
  const attempts = typeof md.attempts === "number" ? md.attempts : 1;
  if (attempts >= METADATA_MAX_ATTEMPTS) return false;
  const at = typeof md.fetchedAt === "number" ? md.fetchedAt : 0;
  return now - at >= 60_000 * 2 ** Math.max(0, attempts - 1);
}

/**
 * The fields we keep from a coin's metadata JSON (strings only, ≤ 500 chars). Socials: top-level `website` /
 * `twitter` / `telegram` (pump.fun / FUMPAD), else `extensions.*` (older Solana token-list convention), else
 * Metaplex `external_url` for the website.
 */
export function pickMetadata(j: Record<string, unknown>): Record<string, string | undefined> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.slice(0, 500) : undefined);
  const ext = j.extensions && typeof j.extensions === "object" && !Array.isArray(j.extensions) ? (j.extensions as Record<string, unknown>) : {};
  return {
    description: str(j.description),
    image: str(j.image),
    website: str(j.website) ?? str(ext.website) ?? str(j.external_url),
    twitter: str(j.twitter) ?? str(ext.twitter) ?? str(j.x),
    telegram: str(j.telegram) ?? str(ext.telegram),
  };
}
