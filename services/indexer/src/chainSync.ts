/**
 * Chain snapshot of touched coins: after events touch a mint, re-read the Coin account,
 * reward vault and (graduated) pool reserves, so values that events don't carry exactly
 * (reward-vault balance, buyback_lamports, unclaimed fees, D10 reference, AMM reserves
 * incl. virtual_quote_reserves) are exact. Debounced per mint; also fetches the coin's
 * off-chain metadata JSON once.
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { coinAddresses, decodeCoin, decodePumpPool, decodeTokenAccount, priceQ64 } from "@fumpad/sdk";

import type { Db } from "./db.js";
import type { Logger } from "./log.js";

export class ChainSync {
  private queue = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  stats = { synced: 0, errors: 0 };

  constructor(private conn: Connection, private db: Db, private log: Logger, private opts: { debounceMs: number; fetchMetadata: boolean }) {}

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
          price_q64 = COALESCE($14, price_q64), chain_synced_at = now()
        WHERE mint = $1`,
      [
        mint, c.status, c.virtualSolReserves.toString(), c.virtualTokenReserves.toString(), c.realSolReserves.toString(), c.realTokenReserves.toString(),
        vault?.toString() ?? null, c.buybackLamports.toString(), c.platformFeesUnclaimed.toString(), c.creatorFeesUnclaimed.toString(),
        c.reference.avgQ64.toString(), ammBase?.toString() ?? null, ammQuote?.toString() ?? null, spot?.toString() ?? null,
      ],
    );
    if (this.opts.fetchMetadata) await this.fetchMetadata(mint);
  }

  private async fetchMetadata(mint: string) {
    const r = await this.db.query<{ uri: string; metadata: unknown }>("SELECT uri, metadata FROM coins WHERE mint = $1", [mint]);
    const row = r.rows[0];
    if (!row || row.metadata || !/^https?:\/\//.test(row.uri)) return;
    let meta: Record<string, unknown> = { fetchedAt: Date.now() };
    try {
      const res = await fetch(row.uri, { signal: AbortSignal.timeout(3_000), redirect: "follow" });
      const text = (await res.text()).slice(0, 64 * 1024);
      const j = JSON.parse(text) as Record<string, unknown>;
      const pickStr = (k: string) => (typeof j[k] === "string" ? (j[k] as string).slice(0, 500) : undefined);
      meta = { ...meta, description: pickStr("description"), image: pickStr("image"), website: pickStr("website"), twitter: pickStr("twitter"), telegram: pickStr("telegram") };
    } catch (e) {
      meta.error = String(e).slice(0, 200);
    }
    await this.db.query("UPDATE coins SET metadata = $2 WHERE mint = $1", [mint, JSON.stringify(meta)]);
  }
}
