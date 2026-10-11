/**
 * Derived, off-chain game + safety layer (SPEC §7), recomputed periodically from the
 * event tables (so it is always consistent with whatever replay/rollback did):
 *
 * - user_stats: XP, level, achievements, worst fumble, fumble rank.
 * - wallet_funding: first SOL funder of each relevant wallet (ticket owners, creators).
 * - wallet_clusters: wallets linked through the funding graph (shared non-hub funder, or
 *   one funded the other).
 * - wallet_flags: `creator_linked` (in a cluster with the coin's creator and holding a
 *   ticket on that coin — D9 suspected creator alt), `linked_wallets` (≥2 wallets of one
 *   cluster holding tickets on the same coin). `rebuy_elsewhere` is flagged at ingest.
 * Flags are public and exclude the wallet from leaderboards; they never block claims.
 */
import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

import { accountKeys, type TxLike } from "@fumpad/sdk";

import type { Db } from "./db.js";
import type { Logger } from "./log.js";

export const LEVEL_TITLES = ["fresh exit", "early leaver", "certified early exit", "paper-handed professional", "regret connoisseur"];

/** XP → level: level n needs 250·(n−1)² XP. */
export function levelFor(xp: number): { level: number; xpNext: number; title: string } {
  const level = Math.floor(Math.sqrt(xp / 250)) + 1;
  return { level, xpNext: 250 * level * level, title: LEVEL_TITLES[Math.min(LEVEL_TITLES.length - 1, Math.floor(level / 4.5))] };
}

export function xpFor(s: { tickets: number; crossed: number; claims: number; claimedSol: number }): number {
  return s.tickets * 25 + s.crossed * 150 + s.claims * 300 + Math.floor(s.claimedSol * 40);
}

/** Wallets that funded more than this many indexed wallets are hubs (exchanges, faucets) — not links. */
export const HUB_FUNDER_THRESHOLD = 25;

export class Deriver {
  stats = { runs: 0, fundingLookups: 0, flags: 0 };
  constructor(private conn: Connection, private db: Db, private log: Logger, private opts: { fundingLookupsPerCycle: number; claimWindowSecs: () => bigint }) {}

  async runOnce(): Promise<void> {
    await this.userStats();
    await this.fundingLookups();
    await this.clustersAndFlags();
    this.stats.runs++;
  }

  async userStats(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const window = Number(this.opts.claimWindowSecs());
    await this.db.query(`
      WITH t AS (
        SELECT owner AS address, count(*)::int AS tickets,
               count(*) FILTER (WHERE crossed_at IS NOT NULL)::int AS crossed,
               max(peak_multiple) AS worst_multiple
          FROM tickets GROUP BY owner),
      worst AS (
        SELECT DISTINCT ON (owner) owner, mint FROM tickets ORDER BY owner, peak_multiple DESC),
      c AS (
        SELECT owner AS address, count(*)::int AS claims,
               COALESCE(sum((amount * median_q64) / 18446744073709551616), 0) AS claimed_lamports,
               bool_or(skipped_ahead) AS jumped,
               max(CASE WHEN sell_price_q64 > 0 THEN median_q64 / sell_price_q64 ELSE 0 END) AS best_claim_multiple
          FROM claims GROUP BY owner),
      fv AS (
        SELECT t.owner AS address,
               sum((t.original_tokens * COALESCE(co.median_q64, co.price_q64)) / 18446744073709551616) AS value
          FROM tickets t JOIN coins co USING (mint) GROUP BY t.owner),
      expired_low AS (
        SELECT DISTINCT owner AS address FROM tickets
         WHERE (status = 'expired' OR (status = 'open' AND sell_ts + $2 < $1)) AND peak_multiple < 1),
      fl AS (SELECT DISTINCT wallet AS address FROM wallet_flags),
      base AS (
        SELECT u.address, COALESCE(t.tickets,0) tickets, COALESCE(t.crossed,0) crossed, COALESCE(c.claims,0) claims,
               COALESCE(c.claimed_lamports,0) claimed_lamports, t.worst_multiple, w.mint AS worst_mint,
               COALESCE(c.jumped,false) jumped, COALESCE(c.best_claim_multiple,0) best_claim_multiple,
               COALESCE(fv.value,0) fumble_value, (el.address IS NOT NULL) sold_top, (fl.address IS NOT NULL) flagged,
               u.first_seen
          FROM users u
          LEFT JOIN t ON t.address = u.address LEFT JOIN c ON c.address = u.address
          LEFT JOIN worst w ON w.owner = u.address LEFT JOIN fv ON fv.address = u.address
          LEFT JOIN expired_low el ON el.address = u.address LEFT JOIN fl ON fl.address = u.address)
      INSERT INTO user_stats (address, xp, level, tickets_filed, crossed, claims, claimed_lamports, worst_mint, worst_multiple,
                              fumble_value_lamports, fumble_rank, achievements, flagged, updated_at)
      SELECT address,
             (tickets*25 + crossed*150 + claims*300 + floor(claimed_lamports / 1e9 * 40))::bigint,
             floor(sqrt((tickets*25 + crossed*150 + claims*300 + floor(claimed_lamports / 1e9 * 40)) / 250.0))::int + 1,
             tickets, crossed, claims, claimed_lamports, worst_mint, worst_multiple, fumble_value,
             CASE WHEN tickets > 0 AND NOT flagged THEN rank() OVER (ORDER BY (tickets > 0 AND NOT flagged) DESC, fumble_value DESC) END,
             jsonb_build_object(
               'first', tickets > 0, 'tenbagger', crossed > 0, 'thirty', best_claim_multiple >= 30, 'jumper', jumped,
               'clean', NOT flagged AND first_seen IS NOT NULL AND first_seen < $1 - 90*86400, 'top', sold_top),
             flagged, now()
        FROM base
      ON CONFLICT (address) DO UPDATE SET xp = EXCLUDED.xp, level = EXCLUDED.level, tickets_filed = EXCLUDED.tickets_filed,
        crossed = EXCLUDED.crossed, claims = EXCLUDED.claims, claimed_lamports = EXCLUDED.claimed_lamports,
        worst_mint = EXCLUDED.worst_mint, worst_multiple = EXCLUDED.worst_multiple, fumble_value_lamports = EXCLUDED.fumble_value_lamports,
        fumble_rank = EXCLUDED.fumble_rank, achievements = EXCLUDED.achievements, flagged = EXCLUDED.flagged, updated_at = now()`,
      [now, window],
    );
  }

  /** First funder = fee payer of the wallet's oldest transaction that credited it SOL. */
  async fundingLookups(): Promise<void> {
    const todo = await this.db.query<{ wallet: string }>(
      `SELECT w FROM (SELECT DISTINCT owner AS w FROM tickets UNION SELECT DISTINCT creator FROM coins) x(w)
        WHERE NOT EXISTS (SELECT 1 FROM wallet_funding f WHERE f.wallet = x.w) LIMIT $1`,
      [this.opts.fundingLookupsPerCycle],
    );
    for (const { wallet } of todo.rows.map((r) => ({ wallet: (r as unknown as { w: string }).w }))) {
      let funder: string | null = null;
      let lamports: bigint | null = null;
      let sig: string | null = null;
      let ts: number | null = null;
      try {
        let before: string | undefined;
        let oldest: { signature: string; blockTime?: number | null } | undefined;
        for (let page = 0; page < 5; page++) {
          const sigs = await this.conn.getSignaturesForAddress(new PublicKey(wallet), { before, limit: 1000 }, "confirmed");
          if (!sigs.length) break;
          oldest = sigs[sigs.length - 1];
          if (sigs.length < 1000) break;
          before = oldest.signature;
        }
        if (oldest) {
          const tx = (await this.conn.getTransaction(oldest.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })) as unknown as TxLike | null;
          if (tx?.meta) {
            const keys = accountKeys(tx);
            const i = keys.indexOf(wallet);
            const pre = tx.meta.preBalances?.[i] ?? 0;
            const post = tx.meta.postBalances?.[i] ?? 0;
            if (keys[0] !== wallet && post > pre) {
              funder = keys[0];
              lamports = BigInt(post - pre);
            }
            sig = oldest.signature;
            ts = tx.blockTime ?? null;
          }
        }
      } catch (e) {
        this.log.debug({ wallet, err: String(e) }, "funding lookup failed");
      }
      await this.db.query(
        `INSERT INTO wallet_funding (wallet, funder, lamports, signature, ts) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (wallet) DO UPDATE SET funder = EXCLUDED.funder, lamports = EXCLUDED.lamports, signature = EXCLUDED.signature, ts = EXCLUDED.ts, checked_at = now()`,
        [wallet, funder, lamports?.toString() ?? null, sig, ts],
      );
      this.stats.fundingLookups++;
    }
  }

  /** Union-find over funding edges (excluding hub funders), then flags. */
  async clustersAndFlags(): Promise<void> {
    const edges = await this.db.query<{ wallet: string; funder: string }>(
      `SELECT wallet, funder FROM wallet_funding WHERE funder IS NOT NULL
         AND funder NOT IN (SELECT funder FROM wallet_funding WHERE funder IS NOT NULL GROUP BY funder HAVING count(*) > $1)`,
      [HUB_FUNDER_THRESHOLD],
    );
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let p = parent.get(x) ?? x;
      if (p !== x) {
        p = find(p);
        parent.set(x, p);
      }
      return p;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    for (const e of edges.rows) union(e.wallet, e.funder);
    const groups = new Map<string, string[]>();
    for (const w of new Set([...edges.rows.map((e) => e.wallet), ...edges.rows.map((e) => e.funder)])) {
      const r = find(w);
      groups.set(r, [...(groups.get(r) ?? []), w]);
    }
    const now = Math.floor(Date.now() / 1000);
    await this.db.query("DELETE FROM wallet_clusters");
    for (const [root, members] of groups) {
      if (members.length < 2) continue;
      for (const m of members) await this.db.query("INSERT INTO wallet_clusters (wallet, cluster_id, size) VALUES ($1,$2,$3)", [m, root, members.length]);
    }
    // creator_linked: ticket holder in the coin creator's cluster (D9).
    const cl = await this.db.query<{ owner: string; mint: string; creator: string }>(
      `SELECT DISTINCT t.owner, t.mint, co.creator FROM tickets t JOIN coins co USING (mint)
         JOIN wallet_clusters a ON a.wallet = t.owner JOIN wallet_clusters b ON b.wallet = co.creator AND b.cluster_id = a.cluster_id
        WHERE t.owner <> co.creator`,
    );
    for (const r of cl.rows) await this.flag(r.owner, "creator_linked", r.mint, { creator: r.creator }, now);
    // linked_wallets: ≥ 2 wallets of one cluster with tickets on the same coin.
    const lw = await this.db.query<{ owner: string; mint: string; cluster_id: string; n: string }>(
      `SELECT t.owner, t.mint, c.cluster_id, count(*) OVER (PARTITION BY t.mint, c.cluster_id) AS n
         FROM (SELECT DISTINCT owner, mint FROM tickets) t JOIN wallet_clusters c ON c.wallet = t.owner`,
    );
    for (const r of lw.rows) if (Number(r.n) >= 2) await this.flag(r.owner, "linked_wallets", r.mint, { cluster: r.cluster_id, wallets: Number(r.n) }, now);
  }

  private async flag(wallet: string, reason: string, mint: string, detail: Record<string, unknown>, ts: number) {
    const r = await this.db.query(
      `INSERT INTO wallet_flags (wallet, reason, mint, detail, ts) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (wallet, reason, mint) DO NOTHING`,
      [wallet, reason, mint, JSON.stringify(detail), ts],
    );
    if (r.rowCount) {
      this.stats.flags++;
      this.log.info({ wallet, reason, mint }, "wallet flagged");
    }
  }
}
