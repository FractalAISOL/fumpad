/**
 * Meteora ingestion: one confirmed transaction → `meteora_*` rows, in one DB transaction.
 *
 * Idempotent by signature (`meteora_transactions` PK) and by swap (`meteora_trades` PK
 * (signature, ix_key)): a tx delivered by the webhook AND the poller (or a reconcile re-scan) is
 * applied once; a later delivery at `finalized` only upgrades the commitment.
 *
 * The FUMPAD pool set grows only from verified chain facts:
 *   - DBC pools whose `config` (from the pool-init event or the swap event) is a FUMPAD config key,
 *     or whose base mint is a configured FUMPAD mint;
 *   - the DAMM v2 pool such a curve migrated into (DBC `migration_damm_v2` + DAMM v2
 *     `EvtInitializePool` in the same successful tx, both agreeing; see @fumpad/meteora pools.ts).
 * A DAMM v2 pool someone else creates for a FUMPAD mint is NOT in the set (policy: ATTESTATION.md).
 */
import { parseMeteoraTrades, parsePoolFacts, type ConfirmedTx, type MeteoraTrade, type ParseResult, type PoolFacts } from "@fumpad/meteora";

import { FUMPAD_PROGRAM_ID, type Params } from "@fumpad/sdk";

import { type Db, withTx } from "../db.js";
import type { IndexedEvent } from "../handlers.js";
import { jsonify } from "../handlers.js";
import { type Commit, storeAndApply } from "../ingest.js";
import type { Logger } from "../log.js";
import type { MeteoraIndexerConfig } from "./config.js";

export type MeteoraSource = "rpc" | "webhook" | "backfill" | "reconcile";

export interface PoolRow {
  pool: string;
  venue: "dbc" | "damm_v2";
  baseMint: string;
  quoteMint: string | null;
  config: string | null;
  dbcPool: string | null;
  source: "pool_init" | "swap" | "migration";
}

export interface MeteoraIngestResult {
  signature: string;
  status: "applied" | "duplicate" | "upgraded";
  trades: number;
  newPools: string[];
}

export class MeteoraIngestor {
  private pools = new Map<string, PoolRow>();
  private loadedAt = 0;
  readonly configs: Set<string>;
  readonly mints: Set<string>;
  stats = { applied: 0, duplicates: 0, trades: 0, issues: 0, poolsAdded: 0, lastSlot: 0 };

  constructor(
    private db: Db,
    private cfg: Pick<MeteoraIndexerConfig, "dbcConfigs" | "mints">,
    private log: Logger,
    private bridge?: { params: () => Params; onTouched?: (mints: string[]) => void },
  ) {
    this.configs = new Set(cfg.dbcConfigs);
    this.mints = new Set(cfg.mints);
  }

  async refreshPools(force = false) {
    if (!force && Date.now() - this.loadedAt < 10_000) return;
    const r = await this.db.query<{ pool: string; venue: "dbc" | "damm_v2"; base_mint: string; quote_mint: string | null; config: string | null; dbc_pool: string | null; source: PoolRow["source"] }>(
      "SELECT pool, venue, base_mint, quote_mint, config, dbc_pool, source FROM meteora_pools",
    );
    this.pools = new Map(r.rows.map((x) => [x.pool, { pool: x.pool, venue: x.venue, baseMint: x.base_mint, quoteMint: x.quote_mint, config: x.config, dbcPool: x.dbc_pool, source: x.source }]));
    this.loadedAt = Date.now();
  }

  watchedPools(): ReadonlyMap<string, PoolRow> {
    return this.pools;
  }

  /** FUMPAD base mints known so far (configured + those of registered pools). */
  baseMints(): Set<string> {
    const s = new Set(this.mints);
    for (const p of this.pools.values()) s.add(p.baseMint);
    return s;
  }

  /** Which pools this tx adds to the FUMPAD set (pure; exported for tests). */
  newPoolsFrom(res: ParseResult, facts: PoolFacts | null): PoolRow[] {
    const out = new Map<string, PoolRow>();
    const isFumpadDbc = (config: string | null, mint: string) => (config !== null && this.configs.has(config)) || this.mints.has(mint);
    for (const p of facts?.dbcPools ?? []) {
      if (!this.pools.has(p.pool) && isFumpadDbc(p.config, p.baseMint))
        out.set(p.pool, { pool: p.pool, venue: "dbc", baseMint: p.baseMint, quoteMint: null, config: p.config, dbcPool: null, source: "pool_init" });
    }
    for (const t of res.trades) {
      if (t.venue === "dbc" && !this.pools.has(t.pool) && !out.has(t.pool) && isFumpadDbc(t.config, t.baseMint))
        out.set(t.pool, { pool: t.pool, venue: "dbc", baseMint: t.baseMint, quoteMint: t.quoteMint, config: t.config, dbcPool: null, source: "swap" });
    }
    for (const m of facts?.migrations ?? []) {
      const curveIsOurs = this.pools.get(m.dbcPool)?.venue === "dbc" || out.has(m.dbcPool) || isFumpadDbc(m.config, m.baseMint);
      if (curveIsOurs && !this.pools.has(m.dammPool))
        out.set(m.dammPool, { pool: m.dammPool, venue: "damm_v2", baseMint: m.baseMint, quoteMint: m.quoteMint, config: m.config, dbcPool: m.dbcPool, source: "migration" });
    }
    return [...out.values()];
  }

  async ingest(tx: ConfirmedTx, source: MeteoraSource, commitment: Commit): Promise<MeteoraIngestResult> {
    await this.refreshPools();
    const res = parseMeteoraTrades(tx, { baseMints: this.baseMints() });
    let facts: PoolFacts | null = null;
    if (res.status === "ok") {
      try {
        facts = parsePoolFacts(tx);
      } catch {
        facts = null; // shape problems are already reported by parseMeteoraTrades
      }
    }
    const signature = res.signature;
    const newPools = this.newPoolsFrom(res, facts);
    const watched = new Set([...this.pools.keys(), ...newPools.map((p) => p.pool)]);
    const trades = res.trades.filter((t) => watched.has(t.pool));

    // Nothing of ours in this tx: don't record it (a pool registered later — e.g. by the coin's
    // CoinRegistered — makes its cursor backfill fetch the tx again).
    if (!trades.length && !newPools.length) {
      this.stats.lastSlot = Math.max(this.stats.lastSlot, res.slot);
      return { signature, status: "duplicate", trades: 0, newPools: [] };
    }
    const touched = new Set<string>();
    const status = await withTx(this.db, async (c) => {
      const ins = await c.query(
        `INSERT INTO meteora_transactions (signature, slot, block_time, commitment, source, status, version, trade_count, issue_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (signature) DO NOTHING RETURNING signature`,
        [signature, res.slot, res.blockTime, commitment, source, res.status, String(res.version), trades.length, res.issues.length],
      );
      if (!ins.rowCount) {
        if (commitment === "finalized") {
          const up = await c.query("UPDATE meteora_transactions SET commitment = 'finalized' WHERE signature = $1 AND commitment <> 'finalized'", [signature]);
          if (up.rowCount) return "upgraded" as const;
        }
        return "duplicate" as const;
      }
      for (const p of newPools) {
        await c.query(
          `INSERT INTO meteora_pools (pool, venue, base_mint, quote_mint, config, dbc_pool, source, created_sig, created_slot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (pool) DO NOTHING`,
          [p.pool, p.venue, p.baseMint, p.quoteMint, p.config, p.dbcPool, p.source, signature, res.slot],
        );
        // DAMM v2 pools need their own cursor (their swaps don't pass the DBC config account).
        if (p.venue === "damm_v2") await c.query("INSERT INTO meteora_cursors (address, kind) VALUES ($1, 'pool') ON CONFLICT DO NOTHING", [p.pool]);
      }
      for (const t of trades) await insertTrade(c, t);
      if (this.bridge && trades.length) {
        // The coin's trade feed / charts / positions: one `Swap` event per record, through the main
        // pipeline's tables and handlers (replayable like fumpad events).
        await c.query(
          `INSERT INTO transactions (signature, slot, block_time, commitment, source, kind, event_count)
           VALUES ($1,$2,$3,$4,$5,'meteora',$6) ON CONFLICT (signature) DO NOTHING`,
          [signature, res.slot, res.blockTime, commitment, source === "reconcile" ? "reconcile" : source, trades.length],
        );
        const events: IndexedEvent[] = [...trades]
          .sort((a, b) => a.ixKey - b.ixKey)
          .map((t, i) => {
            const data = {
              ...(jsonify(t) as Record<string, unknown>),
              app: t.app.app,
              routed: t.outerPrograms[t.outerPrograms.length - 1] === FUMPAD_PROGRAM_ID.toBase58(),
              ts: t.blockTime ?? Number(t.eventTimestamp),
            };
            return { name: "Swap", program: "meteora" as const, index: 100_000 + i, data, raw: JSON.stringify(data) };
          });
        await storeAndApply(c, { signature, slot: res.slot, blockTime: res.blockTime, params: this.bridge.params(), touched, wallets: new Set() }, events);
      }
      let n = 0;
      for (const i of res.issues) {
        await c.query("INSERT INTO meteora_parse_issues (signature, n, code, ix_key, pool, message) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [
          signature,
          n++,
          i.code,
          i.ixKey ?? null,
          i.pool ?? null,
          i.message.slice(0, 1000),
        ]);
      }
      return "applied" as const;
    });

    if (status === "applied") {
      if (touched.size) this.bridge?.onTouched?.([...touched]);
      this.stats.applied++;
      this.stats.trades += trades.length;
      this.stats.issues += res.issues.length;
      this.stats.poolsAdded += newPools.length;
      for (const p of newPools) this.pools.set(p.pool, p);
      if (res.issues.length) this.log.warn({ signature, issues: res.issues.slice(0, 5) }, "meteora: swaps rejected (fail closed)");
      if (newPools.length) this.log.info({ signature, pools: newPools.map((p) => `${p.venue}:${p.pool}`) }, "meteora: FUMPAD pools registered");
    } else this.stats.duplicates++;
    this.stats.lastSlot = Math.max(this.stats.lastSlot, res.slot);
    return { signature, status, trades: trades.length, newPools: newPools.map((p) => p.pool) };
  }
}

async function insertTrade(c: import("pg").PoolClient, t: MeteoraTrade) {
  const s = (v: bigint) => v.toString();
  await c.query(
    `INSERT INTO meteora_trades (
       signature, ix_key, top_ix, inner_ix, stack_height, slot, block_time, venue, pool, config, base_mint, quote_mint, side,
       trader, trader_source, swap_authority, fee_payer, signers, input_token_account, output_token_account, input_owner, output_owner,
       base_amount, quote_gross, quote_net, amount_in, amount_in_after_fee, amount_out, amount_in_incl_transfer_fee, amount_out_received,
       fee_token, fee_on_input, fee_total, fee_trading, fee_protocol, fee_referral, fee_compounding,
       has_referral, referral_token_account, referral_owner, swap_mode, instruction, next_sqrt_price, curve_complete,
       app, app_via, app_evidence, outer_programs, event_ts, event_raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
             $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50)
     ON CONFLICT (signature, ix_key) DO NOTHING`,
    [
      t.signature, t.ixKey, t.topIx, t.innerIx, t.stackHeight, t.slot, t.blockTime, t.venue, t.pool, t.config, t.baseMint, t.quoteMint, t.side,
      t.trader, t.traderSource, t.swapAuthority, t.feePayer, t.signers, t.inputTokenAccount, t.outputTokenAccount, t.inputOwner, t.outputOwner,
      s(t.baseAmount), s(t.quoteGross), s(t.quoteNet), s(t.amountIn), s(t.amountInAfterFee), s(t.amountOut), s(t.amountInIncludingTransferFee), s(t.amountOutReceived),
      t.fee.token, t.fee.onInput, s(t.fee.total), s(t.fee.trading), s(t.fee.protocol), s(t.fee.referral), s(t.fee.compounding),
      t.hasReferral, t.referralTokenAccount, t.referralOwner, t.swapMode, t.instruction, s(t.nextSqrtPrice), t.curveComplete !== null,
      t.app.app, t.app.via, t.app.evidence, t.outerPrograms, s(t.eventTimestamp), t.eventRaw,
    ],
  );
}
