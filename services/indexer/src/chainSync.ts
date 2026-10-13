/**
 * Chain snapshot of touched coins: after events touch a mint, re-read the Coin account,
 * reward vault and (graduated) pool reserves, so values that events don't carry exactly
 * (reward-vault balance, buyback_lamports, unclaimed fees, D10 reference, AMM reserves
 * incl. virtual_quote_reserves) are exact. Debounced per mint; also fetches the coin's
 * off-chain metadata JSON once.
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { coinAddresses, decodeCoin, decodePumpPool, decodeTokenAccount, priceQ64 } from "@fumpad/sdk/v06";

import type { Db } from "./db.js";
import type { Logger } from "./log.js";
import { safeFetch, SafeFetchError, type SafeFetchOptions } from "./safeFetch.js";

export class ChainSync {
  private queue = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
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
    const a = coinAddresses(new PublicKey(mint));
    const [coinAcc, vaultAcc, poolAcc, baseAcc, quoteAcc] = await this.conn.getMultipleAccountsInfo(
      [a.coin, a.rewardVault, a.pool, a.poolBase, a.poolQuote],
      "confirmed",
    );
    if (!coinAcc) return;
    const c = decodeCoin(new Uint8Array(coinAcc.data));
    const graduated = c.status === "graduated" && !c.ammPool.equals(PublicKey.default);
    const vault = vaultAcc ? decodeTokenAccount(new Uint8Array(vaultAcc.data)).amount : null;
    let ammBase: bigint | null = null;
    let ammQuote: bigint | null = null;
    if (c.status === "graduated" && poolAcc && baseAcc && quoteAcc) {
      const p = decodePumpPool(new Uint8Array(poolAcc.data));
      ammBase = decodeTokenAccount(new Uint8Array(baseAcc.data)).amount;
      ammQuote = decodeTokenAccount(new Uint8Array(quoteAcc.data)).amount + p.virtualQuoteReserves;
    }
    const spot = c.status === "graduated" ? (ammBase && ammQuote ? priceQ64(ammQuote, ammBase) : null) : priceQ64(c.virtualSolReserves, c.virtualTokenReserves);
    await this.db.query(
      `UPDATE coins SET status = $2, virtual_sol = $3, virtual_tokens = $4, real_sol = $5, real_tokens = $6,
          pool_tokens = COALESCE($7, pool_tokens), buyback_pending = $8, platform_fees_unclaimed = $9, creator_fees_unclaimed = $10,
          reference_q64 = $11, amm_base = COALESCE($12, amm_base), amm_quote = COALESCE($13, amm_quote),
          price_q64 = COALESCE($14, price_q64),
          completed_at = COALESCE(completed_at, $15), graduated_at = COALESCE(graduated_at, $16), amm_pool = COALESCE(amm_pool, $17),
          chain_synced_at = now()
        WHERE mint = $1`,
      [
        mint, c.status, c.virtualSolReserves.toString(), c.virtualTokenReserves.toString(), c.realSolReserves.toString(), c.realTokenReserves.toString(),
        vault?.toString() ?? null, c.buybackLamports.toString(), c.platformFeesUnclaimed.toString(), c.creatorFeesUnclaimed.toString(),
        c.reference.avgQ64.toString(), ammBase?.toString() ?? null, ammQuote?.toString() ?? null, spot?.toString() ?? null,
        // Heal what a missed/out-of-order CurveCompleted/Graduated event would have written
        // (seen on devnet: Graduated applied before the coin row existed → no graduated_at,
        // no amm_pool, so the pool was never watched and the API showed "Bonding curve").
        c.completedAt ? c.completedAt.toString() : null,
        c.graduatedAt ? c.graduatedAt.toString() : null,
        graduated ? c.ammPool.toBase58() : null,
      ],
    );
    if (graduated) {
      await this.db.query("INSERT INTO cursors (address, kind, mint) VALUES ($1, 'pool', $2) ON CONFLICT DO NOTHING", [c.ammPool.toBase58(), mint]);
    }
    if (this.opts.fetchMetadata) await this.fetchMetadata(mint);
  }

  /**
   * Off-chain metadata JSON (M-3): any coin can carry any `uri`, so it is fetched under the
   * SSRF policy (safeFetch: https/ipfs/ar only, public addresses only incl. every redirect
   * hop, 64 KiB, 5 s). Only short strings are kept; failures store a coarse error code
   * (never the network error text, which would map internal hosts/ports).
   */
  private async fetchMetadata(mint: string) {
    const r = await this.db.query<{ uri: string; metadata: unknown }>("SELECT uri, metadata FROM coins WHERE mint = $1", [mint]);
    const row = r.rows[0];
    if (!row || row.metadata || !row.uri || !/^(https?|ipfs|ar):\/\//i.test(row.uri)) return;
    let meta: Record<string, unknown> = { fetchedAt: Date.now() };
    try {
      const res = await safeFetch(row.uri, { timeoutMs: 5_000, maxBytes: 64 * 1024, maxRedirects: 3, ...this.opts.metadataFetch });
      if (res.status !== 200) throw new SafeFetchError("http", "status");
      const j = JSON.parse(res.body.toString("utf8")) as Record<string, unknown>;
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new SafeFetchError("http", "not an object");
      const pickStr = (k: string) => (typeof j[k] === "string" ? (j[k] as string).slice(0, 500) : undefined);
      meta = { ...meta, description: pickStr("description"), image: pickStr("image"), website: pickStr("website"), twitter: pickStr("twitter"), telegram: pickStr("telegram") };
    } catch (e) {
      meta.error = e instanceof SafeFetchError ? e.code : e instanceof SyntaxError ? "invalid_json" : "failed";
    }
    await this.db.query("UPDATE coins SET metadata = $2 WHERE mint = $1", [mint, JSON.stringify(meta)]);
  }
}
