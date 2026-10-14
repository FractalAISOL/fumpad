/**
 * Event → table updates (v0.7). Runs inside the ingest DB transaction, one call per chain transaction.
 *
 * Three event sources share the `events` table and this code path (so `replay.ts` rebuilds a mint from
 * them uniformly):
 *   - program 'fumpad':  the program's own emit_cpi events (decoded with @fumpad/sdk);
 *   - program 'meteora': `Swap` — one @fumpad/meteora trade record on the coin's DBC / DAMM v2 pool,
 *     from any app (stored as JSON, see meteora/ingest.ts);
 *   - program 'meta':    `CoinMetadata` — name/symbol/uri read from the launch tx's DBC init instruction.
 *
 * Every write is idempotent (ON CONFLICT DO NOTHING on event tables).
 */
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import {
  baseToTokens,
  BPS_DENOM,
  lamportsToSol,
  medianPriceQ64,
  type Params,
  q64ToSolPerToken,
  REWARD_POOL_BASE,
  TICKET_STATUS_NAMES,
} from "@fumpad/sdk";

import { getMeta, NOTIFY_CHANNEL, type Tx } from "./db.js";
import type { ConfigFees } from "./params.js";

/** One event as handled here: name + normalized payload. */
export interface IndexedEvent {
  name: string;
  program: "fumpad" | "meteora" | "meta";
  index: number;
  data: Record<string, unknown>;
  raw: string;
}

export interface TxCtx {
  c: Tx;
  signature: string;
  slot: number;
  blockTime: number | null;
  params: Params;
  /** Mints whose current state changed (for chain sync + API cache invalidation). */
  touched: Set<string>;
  /** Wallets whose tickets/positions/balances changed. */
  wallets?: Set<string>;
  /** A governance event was seen: reload Global. */
  paramsChanged?: boolean;
}

const s = (v: bigint | number | string) => v.toString();
const touchWallet = (ctx: TxCtx, w: string | undefined | null) => {
  if (w) ctx.wallets?.add(w);
};
const b58 = (k: unknown) => (k instanceof PublicKey ? k.toBase58() : String(k));
const big = (v: unknown) => (typeof v === "bigint" ? v : BigInt(v as string | number));
/** `TicketAttested.effective_at` as a column value: 0 / absent (events from before INTERFACE §8.4) → NULL. */
const effectiveAt = (v: unknown) => (v === undefined || v === null || big(v) <= 0n ? null : s(big(v)));

/** JSON-safe copy of an event payload (bigint → string, PublicKey → base58). */
export function jsonify(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map(jsonify);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonify(x)]));
  return v;
}

/** Mint an event refers to (ticket-keyed events resolve through the tickets table). */
export async function eventMint(c: Tx, e: IndexedEvent): Promise<string | null> {
  const d = e.data;
  if (e.program === "meteora") return String(d.baseMint);
  if (d.mint !== undefined && d.mint !== null) return b58(d.mint);
  if (d.ticket !== undefined) {
    const r = await c.query<{ mint: string }>("SELECT mint FROM tickets WHERE ticket = $1", [b58(d.ticket)]);
    return r.rows[0]?.mint ?? null;
  }
  return null;
}

export const multipleOf = (priceQ64v: bigint, ticketPriceQ64: bigint) => (ticketPriceQ64 === 0n ? 0 : Number((priceQ64v * 1_000_000n) / ticketPriceQ64) / 1_000_000);

async function feed(ctx: TxCtx, id: string, kind: string, ts: bigint, mint: string, actor: string, payload: Record<string, unknown>) {
  const r = await ctx.c.query(
    `INSERT INTO feed_events (id, kind, ts, mint, actor, signature, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING RETURNING seq`,
    [id, kind, s(ts), mint, actor, ctx.signature, JSON.stringify(payload)],
  );
  if (r.rowCount) await ctx.c.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, JSON.stringify({ type: "feed", id })]);
}

async function upsertUser(ctx: TxCtx, address: string, ts: bigint) {
  await ctx.c.query(
    `INSERT INTO users (address, first_seen, last_seen) VALUES ($1, $2, $2)
     ON CONFLICT (address) DO UPDATE SET last_seen = GREATEST(users.last_seen, EXCLUDED.last_seen),
       first_seen = LEAST(users.first_seen, EXCLUDED.first_seen)`,
    [address, s(ts)],
  );
}

/** Recompute the coin's oracle median from indexed DAMM v2 keeper samples (same rule as the program). */
async function refreshMedian(ctx: TxCtx, mint: string, now: bigint): Promise<bigint | null> {
  const p = ctx.params;
  const r = await ctx.c.query<{ price_q64: string; ts: string; fallback: boolean }>(
    "SELECT price_q64, ts, fallback FROM samples WHERE mint = $1 AND venue = 1 AND ts > $2 AND ts <= $3",
    [mint, s(now - p.oracleWindowSecs), s(now)],
  );
  const samples = r.rows.map((x) => ({ ts: BigInt(x.ts), priceQ64: BigInt(x.price_q64), fallback: x.fallback }));
  const med = medianPriceQ64({ samples }, now, p.oracleWindowSecs, p.oracleMinSamples);
  const keeper = samples.filter((x) => !x.fallback).length;
  await ctx.c.query("UPDATE coins SET median_q64 = $2, median_samples = $3 WHERE mint = $1", [mint, med === null ? null : s(med), keeper]);
  return med;
}

/** Update multiples/peaks for the coin's open tickets at `priceQ64`; emit `cross` feed items. */
async function trackMultiples(ctx: TxCtx, mint: string, priceQ64v: bigint, ts: bigint, crossable: boolean) {
  const p = ctx.params;
  const rows = await ctx.c.query<{ ticket: string; owner: string; tokens: string; sell_price_q64: string; crossed_at: string | null }>(
    "SELECT ticket, owner, tokens, sell_price_q64, crossed_at FROM tickets WHERE mint = $1 AND status IN ('open','queued')",
    [mint],
  );
  const trigger = p.triggerMultipleBps / Number(BPS_DENOM);
  for (const t of rows.rows) {
    const m = multipleOf(priceQ64v, BigInt(t.sell_price_q64));
    const crossNow = crossable && t.crossed_at === null && priceQ64v * BPS_DENOM >= BigInt(t.sell_price_q64) * BigInt(p.triggerMultipleBps);
    await ctx.c.query(
      `UPDATE tickets SET last_multiple = $2, peak_multiple = GREATEST(peak_multiple, $2), crossed_at = CASE WHEN $3 THEN $4::bigint ELSE crossed_at END,
         crossed_multiple = CASE WHEN $3 THEN $2 ELSE crossed_multiple END WHERE ticket = $1`,
      [t.ticket, m, crossNow, s(ts)],
    );
    if (crossNow) {
      const claimTokens = (BigInt(t.tokens) * BigInt(p.claimBps)) / BPS_DENOM;
      await feed(ctx, `${t.ticket}:cross`, "cross", ts, mint, t.owner, {
        ticket: t.ticket,
        multiple: Math.max(m, trigger),
        claimTokens: baseToTokens(claimTokens),
        claimSol: baseToTokens(claimTokens) * q64ToSolPerToken(priceQ64v),
      });
    }
  }
}

async function position(ctx: TxCtx, mint: string, wallet: string, ts: bigint, delta: { balance: bigint; bought?: bigint; sold?: bigint; claimed?: bigint; solIn?: bigint; solOut?: bigint; buys?: number; sells?: number }) {
  await ctx.c.query(
    `INSERT INTO positions (mint, wallet, balance, bought, sold, claimed, sol_in, sol_out, buys, sells, first_ts, last_ts)
     VALUES ($1,$2,GREATEST($3::numeric,0),$4,$5,$6,$7,$8,$9,$10,$11,$11)
     ON CONFLICT (mint, wallet) DO UPDATE SET
       balance = GREATEST(positions.balance + $3::numeric, 0), bought = positions.bought + $4, sold = positions.sold + $5,
       claimed = positions.claimed + $6, sol_in = positions.sol_in + $7, sol_out = positions.sol_out + $8,
       buys = positions.buys + $9, sells = positions.sells + $10, last_ts = GREATEST(positions.last_ts, $11)`,
    [mint, wallet, s(delta.balance), s(delta.bought ?? 0n), s(delta.sold ?? 0n), s(delta.claimed ?? 0n), s(delta.solIn ?? 0n), s(delta.solOut ?? 0n), delta.buys ?? 0, delta.sells ?? 0, s(ts)],
  );
}

/** Standard normal trading fee (D32, 1.25%), for coins whose own fee isn't known yet. */
const STANDARD_FEE_BPS = 125n;
/**
 * The coin's per-trade fee facts: its normal fee (its config's: 1.25% standard, 3% on the first-coin config; the
 * DAMM v2 fee after graduation) and its fee policy (INTERFACE §5.9).
 */
interface CoinFeeRow {
  fee_policy_kind: number | null;
  fee_buyback_share: number | null;
  fee_wallet_share: number | null;
  fee_bps: number | null;
  migrated_fee_bps: number | null;
}
/**
 * Meteora's protocol share is 20% of the fee; FUMPAD splits the remaining 80% (`trading`) 50 / 30 / 20 (standard),
 * or buyback : wallet by the coin's wallet-split policy — the wallet's part is stored as `fee_platform` (FUMPAD's
 * designated wallet, not the pool, not the creator), so pool + platform + creator stays = trading.
 */
function feeSplit(trading: bigint, p: Params, coin?: CoinFeeRow) {
  if (coin?.fee_policy_kind && coin.fee_wallet_share) {
    const den = BigInt((coin.fee_buyback_share ?? 0) + coin.fee_wallet_share);
    const wallet = (trading * BigInt(coin.fee_wallet_share)) / den;
    return { pool: trading - wallet, platform: wallet, creator: 0n };
  }
  const platform = (trading * BigInt(p.feePlatformShareBps)) / BPS_DENOM;
  const creator = (trading * BigInt(p.feeCreatorShareBps)) / BPS_DENOM;
  return { pool: trading - platform - creator, platform, creator };
}

/** Q64 spot from a Meteora sqrt price; virtual reserves need the liquidity (chain sync keeps coins.liquidity). */
const spotOf = (sqrt: bigint) => (sqrt * sqrt) >> 64n;

/** Apply all events of one transaction (in order). */
export async function applyEvents(ctx: TxCtx, events: IndexedEvent[]): Promise<void> {
  const { c, params: p } = ctx;
  for (const e of events) {
    const id = `${ctx.signature}:${e.index}`;
    const d = e.data;
    const ts = d.ts !== undefined ? big(d.ts) : BigInt(ctx.blockTime ?? 0);
    switch (e.name) {
      // ── launch ────────────────────────────────────────────────────────
      case "CoinRegistered": {
        const mint = b58(d.mint);
        const creator = b58(d.creator);
        // The snapshotted fee policy (events from before 2026-10-14 have none = standard) and the config's fee
        // schedule as cached by loadParams (chain sync fills it later when the config wasn't cached yet).
        const fp = (d.feePolicy ?? null) as { kind: number; buybackShare: number; walletShare: number; wallet: unknown } | null;
        const kind = fp ? Number(fp.kind) : 0;
        const cached = await getMeta<{ configCurves?: Record<string, ConfigFees> }>(c, "global");
        const cf = cached?.configCurves?.[b58(d.dbcConfig)];
        const ins = await c.query(
          `INSERT INTO coins (mint, creator, name, symbol, uri, created_at, created_sig, status, virtual_sol, virtual_tokens, real_sol, real_tokens,
             price_q64, price_slot, reference_q64, pool_seeded, pool_tokens, dbc_pool, dbc_config, launch_slot, launch_window_slots,
             fee_policy_kind, fee_wallet, fee_buyback_share, fee_wallet_share, fee_bps, snipe_start_bps, snipe_window_slots, migrated_fee_bps)
           VALUES ($1,$2,'','','',$3,$4,'curve',0,0,0,0,0,0,NULL,0,0,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (mint) DO NOTHING`,
          [
            mint, creator, s(ts), ctx.signature, b58(d.dbcPool), b58(d.dbcConfig), s(big(d.launchSlot)), s(big(d.launchWindowSlots)),
            kind, kind ? b58(fp!.wallet) : null, kind ? Number(fp!.buybackShare) : null, kind ? Number(fp!.walletShare) : null,
            cf?.feeBps ?? null, cf?.snipeStartBps ?? null, cf?.snipeWindowSlots ?? null, cf?.migratedPoolFeeBps ?? null,
          ],
        );
        if (!ins.rowCount) break;
        // Trades the Meteora pipeline stored before the coin row existed (same launch tx).
        await c.query(
          `UPDATE coins SET volume_lamports = x.v, trade_count = x.n, last_trade_at = x.last,
             snipe_tax_lamports = x.snipe, snipe_taxed_buys = x.snipes
           FROM (SELECT COALESCE(sum(sol_amount),0) v, count(*) n, max(ts) last, COALESCE(sum(snipe_tax),0) snipe,
                        count(*) FILTER (WHERE snipe_tax > 0) snipes FROM trades WHERE mint = $1) x WHERE mint = $1`,
          [mint],
        );
        await c.query(`UPDATE vanity_mints SET status = 'used', used_tx = $2, used_at = now(), secret_enc = NULL WHERE pubkey = $1 AND status <> 'used'`, [mint, ctx.signature]);
        // The coin's DBC pool + mint join the Meteora pool set / cursors.
        await c.query(
          `INSERT INTO meteora_pools (pool, venue, base_mint, quote_mint, config, source, created_sig, created_slot)
           VALUES ($1, 'dbc', $2, 'So11111111111111111111111111111111111111112', $3, 'pool_init', $4, $5) ON CONFLICT (pool) DO NOTHING`,
          [b58(d.dbcPool), mint, b58(d.dbcConfig), ctx.signature, ctx.slot],
        );
        await c.query("INSERT INTO meteora_cursors (address, kind) VALUES ($1, 'mint') ON CONFLICT DO NOTHING", [mint]);
        await upsertUser(ctx, creator, ts);
        touchWallet(ctx, creator);
        await feed(ctx, `${id}:launch`, "launch", ts, mint, creator, { poolTokens: baseToTokens(REWARD_POOL_BASE) });
        ctx.touched.add(mint);
        break;
      }
      case "CoinMetadata": {
        await c.query("UPDATE coins SET name = $2, symbol = $3, uri = $4 WHERE mint = $1", [String(d.mint), String(d.name), String(d.symbol), String(d.uri)]);
        ctx.touched.add(String(d.mint));
        break;
      }
      // ── trades (any app, on the coin's own pools) ─────────────────────
      case "Swap": {
        const mint = String(d.baseMint);
        const wallet = d.trader ? String(d.trader) : null;
        if (!wallet) break;
        const isBuy = d.side === "buy";
        const base = big(d.baseAmount);
        const quoteGross = big(d.quoteGross);
        const quoteNet = big(d.quoteNet);
        const fee = d.fee as Record<string, string>;
        const trading = big(fee.trading);
        const protocol = big(fee.protocol);
        const total = big(fee.total);
        const sqrt = big(d.nextSqrtPrice);
        const spot = spotOf(sqrt);
        const onAmm = d.venue === "damm_v2";
        const coin = await c.query<{ liquidity: string | null } & CoinFeeRow>(
          "SELECT liquidity, fee_policy_kind, fee_buyback_share, fee_wallet_share, fee_bps, migrated_fee_bps FROM coins WHERE mint = $1",
          [mint],
        );
        const cf = coin.rows[0];
        const split = feeSplit(trading, p, cf);
        const feeBase = isBuy ? quoteGross + total : quoteGross;
        // The coin's own normal fee (its config's curve fee, or its DAMM v2 fee after graduation): anything above it
        // is the D33 launch-window fee.
        const normalBps = BigInt((onAmm ? (cf?.migrated_fee_bps ?? cf?.fee_bps) : cf?.fee_bps) ?? Number(STANDARD_FEE_BPS));
        const normal = (feeBase * normalBps) / BPS_DENOM;
        const snipe = total > normal + 1n ? total - normal : 0n;
        const snipeBps = feeBase > 0n && snipe > 0n ? Number((total * BPS_DENOM) / feeBase) : 0;
        const L = cf?.liquidity ? BigInt(cf.liquidity) : 0n;
        const vSol = L > 0n ? (L * sqrt) >> 128n : spot;
        const vTok = L > 0n && sqrt > 0n ? L / sqrt : 1n << 64n;
        const ins = await c.query(
          `INSERT INTO trades (signature, idx, slot, ts, mint, wallet, is_buy, on_amm, token_amount, sol_amount, fee_pool, fee_platform, fee_creator,
             pool_tokens_bought, price_q64, virtual_sol, virtual_tokens, snipe_tax, snipe_tax_bps, venue, routed, app, trader_source, fee_total, fee_protocol, quote_net)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) ON CONFLICT DO NOTHING`,
          [
            ctx.signature, Number(d.ixKey), ctx.slot, s(ts), mint, wallet, isBuy, onAmm, s(base), s(quoteGross), s(split.pool), s(split.platform), s(split.creator),
            s(spot), s(vSol), s(vTok), s(snipe), snipeBps, String(d.venue), Boolean(d.routed), d.app ? String(d.app) : null, String(d.traderSource), s(total), s(protocol), s(quoteNet),
          ],
        );
        if (!ins.rowCount) break;
        await c.query(
          `UPDATE coins SET price_q64 = $2, price_slot = $3, sqrt_price = $4,
             virtual_sol = CASE WHEN liquidity IS NULL THEN virtual_sol ELSE $5 END, virtual_tokens = CASE WHEN liquidity IS NULL THEN virtual_tokens ELSE $6 END
           WHERE mint = $1 AND price_slot <= $3`,
          [mint, s(spot), ctx.slot, s(sqrt), s(vSol), s(vTok)],
        );
        await c.query(
          `UPDATE coins SET volume_lamports = volume_lamports + $2, trade_count = trade_count + 1, last_trade_at = GREATEST(COALESCE(last_trade_at,0), $3),
             snipe_tax_lamports = snipe_tax_lamports + $4, snipe_taxed_buys = snipe_taxed_buys + (CASE WHEN $4::numeric > 0 THEN 1 ELSE 0 END),
             status = CASE WHEN $5 AND status = 'curve' THEN 'complete' ELSE status END,
             completed_at = CASE WHEN $5 AND completed_at IS NULL THEN $3::bigint ELSE completed_at END,
             updated_at = now() WHERE mint = $1`,
          [mint, s(quoteGross), s(ts), s(snipe), Boolean(d.curveComplete)],
        );
        await position(ctx, mint, wallet, ts, isBuy ? { balance: base, bought: base, solIn: quoteNet, buys: 1 } : { balance: -base, sold: base, solOut: quoteNet, sells: 1 });
        await upsertUser(ctx, wallet, ts);
        if (onAmm) await trackMultiples(ctx, mint, spot, ts, false);
        touchWallet(ctx, wallet);
        ctx.touched.add(mint);
        break;
      }
      case "RoutedTrade":
        break; // the Swap record (from the Meteora pipeline) carries the trade; this event marks `routed`
      case "CurveCompleted": {
        await c.query("UPDATE coins SET status = 'complete', completed_at = COALESCE(completed_at, $2) WHERE mint = $1 AND status = 'curve'", [b58(d.mint), s(ts)]);
        ctx.touched.add(b58(d.mint));
        break;
      }
      // ── fees / buybacks ───────────────────────────────────────────────
      case "FeesClaimed": {
        const mint = b58(d.mint);
        const ins = await c.query(
          `INSERT INTO fee_claims (signature, idx, mint, venue, claimed, to_buyback, to_platform, to_creator, launch_window, ts, to_wallet, fee_wallet)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
          [
            ctx.signature, e.index, mint, Number(d.venue), s(big(d.claimed)), s(big(d.toBuyback)), s(big(d.toPlatform)), s(big(d.toCreator)), Boolean(d.launchWindow), s(ts),
            s(big(d.toWallet ?? 0n)), d.toWallet !== undefined && big(d.toWallet) > 0n ? b58(d.feeWallet) : null,
          ],
        );
        if (ins.rowCount)
          await c.query(
            `UPDATE coins SET buyback_pending = buyback_pending + $2, pool_inflow_lamports = pool_inflow_lamports + $2,
               platform_fees_unclaimed = platform_fees_unclaimed + $3, creator_fees_unclaimed = creator_fees_unclaimed + $4,
               wallet_fees_paid = wallet_fees_paid + $5 WHERE mint = $1`,
            [mint, s(big(d.toBuyback)), s(big(d.toPlatform)), s(big(d.toCreator)), s(big(d.toWallet ?? 0n))],
          );
        ctx.touched.add(mint);
        break;
      }
      case "FeesWithdrawn": {
        const mint = b58(d.mint);
        const ins = await c.query(
          "INSERT INTO fee_withdrawals (signature, idx, mint, recipient, lamports, is_creator, ts) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [ctx.signature, e.index, mint, b58(d.recipient), s(big(d.lamports)), Boolean(d.creator), s(ts)],
        );
        if (ins.rowCount)
          await c.query(
            `UPDATE coins SET creator_fees_unclaimed = CASE WHEN $3 THEN GREATEST(creator_fees_unclaimed - $2::numeric, 0) ELSE creator_fees_unclaimed END,
               platform_fees_unclaimed = CASE WHEN $3 THEN platform_fees_unclaimed ELSE GREATEST(platform_fees_unclaimed - $2::numeric, 0) END WHERE mint = $1`,
            [mint, s(big(d.lamports)), Boolean(d.creator)],
          );
        touchWallet(ctx, b58(d.recipient));
        ctx.touched.add(mint);
        break;
      }
      case "BuybackExecuted": {
        const mint = b58(d.mint);
        const ins = await c.query("INSERT INTO buybacks (signature, idx, mint, lamports_in, tokens_out, ts) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [
          ctx.signature,
          e.index,
          mint,
          s(big(d.lamportsIn)),
          s(big(d.tokensOut)),
          s(ts),
        ]);
        if (ins.rowCount)
          await c.query("UPDATE coins SET pool_tokens = pool_tokens + $2, pool_bought = pool_bought + $2, buyback_pending = GREATEST(buyback_pending - $3::numeric, 0) WHERE mint = $1", [
            mint,
            s(big(d.tokensOut)),
            s(big(d.lamportsIn)),
          ]);
        ctx.touched.add(mint);
        break;
      }
      // ── graduation ────────────────────────────────────────────────────
      case "PoolMigrated": {
        await c.query("UPDATE coins SET damm_pool = COALESCE(damm_pool, $2) WHERE mint = $1", [b58(d.mint), b58(d.dammPool)]);
        ctx.touched.add(b58(d.mint));
        break;
      }
      case "Graduated": {
        const mint = b58(d.mint);
        const leftover = big(d.leftoverTokens);
        await c.query(
          `UPDATE coins SET status = 'graduated', graduated_at = $2, damm_pool = $3, damm_position = $4, completed_at = COALESCE(completed_at, $2),
             pool_seeded = GREATEST(pool_seeded, $5::numeric), pool_tokens = pool_tokens + $5, leftover_tokens = $5, migration_fee_lamports = $6,
             graduation_caller_refund = $7, graduation_setup_prefunded = $8, graduation_platform_fee = $9, raised_lamports = COALESCE(migration_threshold, raised_lamports)
           WHERE mint = $1`,
          [mint, s(ts), b58(d.dammPool), b58(d.dammPosition), s(leftover), s(big(d.migrationFee)), s(big(d.callerRefund) + big(d.migratorRefund)), s(big(d.setupPrefunded)), s(big(d.platformFee))],
        );
        await c.query(
          `INSERT INTO meteora_pools (pool, venue, base_mint, quote_mint, source, created_sig, created_slot)
           VALUES ($1, 'damm_v2', $2, 'So11111111111111111111111111111111111111112', 'migration', $3, $4) ON CONFLICT (pool) DO NOTHING`,
          [b58(d.dammPool), mint, ctx.signature, ctx.slot],
        );
        await c.query("INSERT INTO meteora_cursors (address, kind) VALUES ($1, 'pool') ON CONFLICT DO NOTHING", [b58(d.dammPool)]);
        const coin = await c.query<{ creator: string; price_q64: string; migration_threshold: string | null }>("SELECT creator, price_q64, migration_threshold FROM coins WHERE mint = $1", [mint]);
        const spot = BigInt(coin.rows[0]?.price_q64 ?? "0");
        const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM tickets WHERE mint = $1 AND status = 'open' AND $2::numeric * 10000 >= sell_price_q64 * $3`, [mint, s(spot), p.triggerMultipleBps]);
        await feed(ctx, `${id}:graduation`, "graduation", ts, mint, coin.rows[0]?.creator ?? "", {
          raisedSol: coin.rows[0]?.migration_threshold ? lamportsToSol(BigInt(coin.rows[0].migration_threshold)) : 0,
          ticketsUnlocked: Number(r.rows[0].n),
          pool: b58(d.dammPool),
        });
        if (spot > 0n) await trackMultiples(ctx, mint, spot, ts, false);
        ctx.touched.add(mint);
        break;
      }
      // ── oracle ────────────────────────────────────────────────────────
      case "SampleRecorded": {
        const mint = b58(d.mint);
        const venue = Number(d.venue);
        const ins = await c.query("INSERT INTO samples (signature, idx, mint, price_q64, fallback, ts, venue) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [
          ctx.signature,
          e.index,
          mint,
          s(big(d.priceQ64)),
          Boolean(d.fallback),
          s(ts),
          venue,
        ]);
        if (!ins.rowCount || venue !== 1) break;
        await c.query("UPDATE coins SET price_q64 = $2, price_slot = $3 WHERE mint = $1 AND price_slot <= $3", [mint, s(big(d.priceQ64)), ctx.slot]);
        const med = await refreshMedian(ctx, mint, ts);
        if (med !== null) await trackMultiples(ctx, mint, med, ts, true);
        ctx.touched.add(mint);
        break;
      }
      // ── tickets (D31) ─────────────────────────────────────────────────
      case "TicketAttested": {
        const mint = b58(d.mint);
        const owner = b58(d.owner);
        const ticket = b58(d.ticket);
        const base = big(d.baseAmount);
        const quote = big(d.quoteGross);
        const tokens = big(d.tokens);
        const exec = base > 0n ? (quote << 64n) / base : big(d.sellPriceQ64);
        const sellLamports = base > 0n ? (quote * tokens) / base : 0n;
        const sig = Array.isArray(d.signature) ? bs58.encode(Uint8Array.from(d.signature as number[])) : String(d.signature);
        const app = await c.query<{ app: string | null }>("SELECT app FROM trades WHERE signature = $1 AND idx = $2", [sig, Number(d.ixKey)]);
        const source = Number(d.source) === 1 ? "router" : "outside";
        const ins = await c.query(
          `INSERT INTO tickets (ticket, mint, owner, seq, tokens, original_tokens, sell_price_q64, exec_price_q64, sell_usd_cents, sell_lamports, sell_ts, created_sig, created_slot,
             source, venue, sell_signature, sell_ix_key, attested_at, effective_at, keepers, app)
           VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (ticket) DO NOTHING`,
          [
            ticket, mint, owner, s(big(d.seq)), s(tokens), s(big(d.sellPriceQ64)), s(exec), s(big(d.sellUsdCents)), s(sellLamports), s(big(d.sellTs)), ctx.signature, ctx.slot,
            // attested_at = when the attestation landed; effective_at = when the ticket takes effect (rate-cap
            // deferral, INTERFACE §8.4): the challenge window runs from it (NULL → readers fall back to attested_at)
            source, Number(d.venue) === 1 ? "damm_v2" : "dbc", sig, Number(d.ixKey), s(ts), effectiveAt(d.effectiveAt), (d.keepers as unknown[]).map(b58), app.rows[0]?.app ?? null,
          ],
        );
        if (!ins.rowCount) break;
        await c.query("UPDATE coins SET tickets_created = tickets_created + 1, tickets_open = tickets_open + 1 WHERE mint = $1", [mint]);
        touchWallet(ctx, owner);
        await feed(ctx, `${id}:fumble`, "fumble", ts, mint, owner, {
          ticket,
          tokens: baseToTokens(tokens),
          sol: lamportsToSol(sellLamports),
          ticketPrice: q64ToSolPerToken(big(d.sellPriceQ64)),
          source,
          app: app.rows[0]?.app ?? undefined,
        });
        const coin = await c.query<{ status: string; price_q64: string; median_q64: string | null }>("SELECT status, price_q64, median_q64 FROM coins WHERE mint = $1", [mint]);
        const cur = coin.rows[0];
        if (cur?.status === "graduated") await trackMultiples(ctx, mint, BigInt(cur.median_q64 ?? cur.price_q64), ts, false);
        ctx.touched.add(mint);
        break;
      }
      case "TicketDebited": {
        const ticket = b58(d.ticket);
        const t = await c.query<{ mint: string; status: string; owner: string }>("SELECT mint, status, owner FROM tickets WHERE ticket = $1", [ticket]);
        const mint = t.rows[0]?.mint ?? b58(d.mint);
        touchWallet(ctx, t.rows[0]?.owner);
        const debited = big(d.debited);
        const remaining = big(d.remaining);
        await c.query("INSERT INTO ticket_debits (signature, idx, ticket, mint, debited, remaining, voided, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", [
          ctx.signature,
          e.index,
          ticket,
          mint,
          s(debited),
          s(remaining),
          Boolean(d.voided),
          s(ts),
        ]);
        if (!t.rows[0]) break;
        const claimAmt = (remaining * BigInt(p.claimBps)) / BPS_DENOM;
        await c.query(
          `UPDATE tickets SET tokens = $2, debited = debited + $3, status = CASE WHEN $4 THEN 'voided' ELSE status END,
             void_reason = CASE WHEN $4 THEN 'rebuy' ELSE void_reason END,
             claim_amount = CASE WHEN status = 'queued' THEN $5 ELSE claim_amount END WHERE ticket = $1`,
          [ticket, s(remaining), s(debited), Boolean(d.voided), s(claimAmt)],
        );
        if (d.voided) {
          await removeFromQueue(ctx, ticket, mint);
          if (t.rows[0].status === "open" || t.rows[0].status === "queued") await c.query("UPDATE coins SET tickets_open = GREATEST(tickets_open - 1, 0) WHERE mint = $1", [mint]);
        } else if (t.rows[0].status === "queued") {
          const q = await c.query<{ amount: string }>("SELECT amount FROM queue_entries WHERE ticket = $1", [ticket]);
          if (q.rows[0]) {
            await c.query("UPDATE queue_entries SET amount = $2 WHERE ticket = $1", [ticket, s(claimAmt)]);
            await c.query("UPDATE coins SET queue_owed = GREATEST(queue_owed - $2::numeric + $3::numeric, 0) WHERE mint = $1", [mint, q.rows[0].amount, s(claimAmt)]);
          }
        }
        ctx.touched.add(mint);
        break;
      }
      case "TicketVoided": {
        const ticket = b58(d.ticket);
        const t = await c.query<{ mint: string; status: string; owner: string }>("SELECT mint, status, owner FROM tickets WHERE ticket = $1", [ticket]);
        if (!t.rows[0]) break;
        await c.query("UPDATE tickets SET status = 'voided', void_reason = 'guardian', closed_at = NULL WHERE ticket = $1", [ticket]);
        await removeFromQueue(ctx, ticket, t.rows[0].mint);
        if (t.rows[0].status === "open" || t.rows[0].status === "queued") await c.query("UPDATE coins SET tickets_open = GREATEST(tickets_open - 1, 0) WHERE mint = $1", [t.rows[0].mint]);
        touchWallet(ctx, t.rows[0].owner);
        ctx.touched.add(t.rows[0].mint);
        break;
      }
      case "ClaimQueued": {
        const mint = b58(d.mint);
        const ticket = b58(d.ticket);
        const t = await c.query<{ sell_ts: string }>("SELECT sell_ts FROM tickets WHERE ticket = $1", [ticket]);
        const by = b58(d.triggeredBy);
        const auto = by !== b58(d.owner);
        touchWallet(ctx, b58(d.owner));
        await c.query("UPDATE tickets SET status = 'queued', queued_at = $2, claim_amount = $3, auto_claimed = $4, crossed_at = COALESCE(crossed_at, $2) WHERE ticket = $1", [ticket, s(ts), s(big(d.amount)), auto]);
        const ins = await c.query("INSERT INTO queue_entries (ticket, mint, owner, amount, sell_ts, queued_at, triggered_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ticket) DO NOTHING", [
          ticket,
          mint,
          b58(d.owner),
          s(big(d.amount)),
          t.rows[0]?.sell_ts ?? s(ts),
          s(ts),
          by,
        ]);
        if (ins.rowCount) await c.query("UPDATE coins SET queue_owed = queue_owed + $2 WHERE mint = $1", [mint, s(big(d.amount))]);
        ctx.touched.add(mint);
        break;
      }
      case "ClaimPaid": {
        const mint = b58(d.mint);
        const ticket = b58(d.ticket);
        const owner = b58(d.owner);
        const amount = big(d.amount);
        const median = big(d.medianPriceQ64);
        const t = await c.query<{ sell_price_q64: string; sell_ts: string; status: string }>("SELECT sell_price_q64, sell_ts, status FROM tickets WHERE ticket = $1", [ticket]);
        const tr = t.rows[0];
        const older =
          d.fromQueue && tr
            ? await c.query("SELECT 1 FROM queue_entries WHERE mint = $1 AND ticket <> $2 AND (sell_ts < $3 OR (sell_ts = $3 AND ticket < $2)) LIMIT 1", [mint, ticket, tr.sell_ts])
            : { rowCount: 0 };
        const skipped = !!older.rowCount;
        const by = b58(d.triggeredBy);
        const auto = by !== owner && !d.fromQueue;
        const ins = await c.query(
          `INSERT INTO claims (signature, idx, mint, ticket, owner, amount, from_queue, skipped_ahead, median_q64, sell_price_q64, ts, triggered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
          [ctx.signature, e.index, mint, ticket, owner, s(amount), Boolean(d.fromQueue), skipped, s(median), tr?.sell_price_q64 ?? null, s(ts), by],
        );
        if (!ins.rowCount) break;
        await c.query(
          "UPDATE tickets SET status = 'claimed', claimed_at = $2, claim_sig = $3, claim_amount = $4, claim_median_q64 = $5, auto_claimed = auto_claimed OR $6, crossed_at = COALESCE(crossed_at, $2) WHERE ticket = $1",
          [ticket, s(ts), ctx.signature, s(amount), s(median), auto],
        );
        await removeFromQueue(ctx, ticket, mint);
        await c.query(
          `UPDATE coins SET pool_tokens = GREATEST(pool_tokens - $2::numeric, 0), pool_paid_out = pool_paid_out + $2,
             tickets_open = CASE WHEN $3 THEN GREATEST(tickets_open - 1, 0) ELSE tickets_open END WHERE mint = $1`,
          [mint, s(amount), tr ? tr.status === "open" || tr.status === "queued" : false],
        );
        await position(ctx, mint, owner, ts, { balance: amount, claimed: amount });
        const multiple = tr ? multipleOf(median, BigInt(tr.sell_price_q64)) : 0;
        await feed(ctx, `${id}:claim`, "claim", ts, mint, owner, {
          ticket,
          multiple,
          tokens: baseToTokens(amount),
          sol: baseToTokens(amount) * q64ToSolPerToken(median),
          fromQueue: Boolean(d.fromQueue),
          skippedAhead: skipped,
          auto,
        });
        await upsertUser(ctx, owner, ts);
        touchWallet(ctx, owner);
        ctx.touched.add(mint);
        break;
      }
      case "ClaimEscrowed": {
        const mint = b58(d.mint);
        const ticket = b58(d.ticket);
        const owner = b58(d.owner);
        const amount = big(d.amount);
        touchWallet(ctx, owner);
        const t = await c.query<{ sell_price_q64: string; status: string }>("SELECT sell_price_q64, status FROM tickets WHERE ticket = $1", [ticket]);
        const ins = await c.query(
          `INSERT INTO claims (signature, idx, mint, ticket, owner, amount, from_queue, escrowed, median_q64, sell_price_q64, ts, triggered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true,0,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [ctx.signature, e.index, mint, ticket, owner, s(amount), t.rows[0]?.status === "queued", t.rows[0]?.sell_price_q64 ?? null, s(ts), b58(d.triggeredBy)],
        );
        if (!ins.rowCount) break;
        await c.query("UPDATE tickets SET status = 'escrowed', claim_amount = $2, claimed_at = $3, claim_sig = $4, escrow = $5 WHERE ticket = $1", [ticket, s(amount), s(ts), ctx.signature, b58(d.escrow)]);
        await removeFromQueue(ctx, ticket, mint);
        await c.query(
          `UPDATE coins SET pool_tokens = GREATEST(pool_tokens - $2::numeric, 0), pool_paid_out = pool_paid_out + $2,
             tickets_open = CASE WHEN $3 THEN GREATEST(tickets_open - 1, 0) ELSE tickets_open END WHERE mint = $1`,
          [mint, s(amount), t.rows[0] ? t.rows[0].status === "open" || t.rows[0].status === "queued" : false],
        );
        ctx.touched.add(mint);
        break;
      }
      case "EscrowWithdrawn": {
        const mint = b58(d.mint);
        await c.query("UPDATE tickets SET status = 'claimed' WHERE ticket = $1", [b58(d.ticket)]);
        await position(ctx, mint, b58(d.owner), ts, { balance: big(d.amount), claimed: big(d.amount) });
        touchWallet(ctx, b58(d.owner));
        ctx.touched.add(mint);
        break;
      }
      case "TicketClosed": {
        const ticket = b58(d.ticket);
        const t = await c.query<{ mint: string; status: string; owner: string }>("SELECT mint, status, owner FROM tickets WHERE ticket = $1", [ticket]);
        if (!t.rows[0]) break;
        touchWallet(ctx, t.rows[0].owner);
        const status = TICKET_STATUS_NAMES[Number(d.finalStatus)] ?? "expired";
        await c.query("UPDATE tickets SET status = $2, closed_at = $3 WHERE ticket = $1", [ticket, status, s(ts)]);
        await removeFromQueue(ctx, ticket, t.rows[0].mint);
        if (t.rows[0].status === "open" || t.rows[0].status === "queued") await c.query("UPDATE coins SET tickets_open = GREATEST(tickets_open - 1, 0) WHERE mint = $1", [t.rows[0].mint]);
        ctx.touched.add(t.rows[0].mint);
        break;
      }
      case "AutoClaimSet": {
        const mint = b58(d.mint);
        await c.query(
          `INSERT INTO positions (mint, wallet, auto_claim_opt_out, first_ts, last_ts) VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (mint, wallet) DO UPDATE SET auto_claim_opt_out = EXCLUDED.auto_claim_opt_out`,
          [mint, b58(d.wallet), !d.enabled, s(ts)],
        );
        touchWallet(ctx, b58(d.wallet));
        ctx.touched.add(mint);
        break;
      }
      // DAMM v2 farming rewards claimed for the coin's locked position: coin-mint rewards joined the reward vault.
      case "PositionRewardClaimed": {
        ctx.touched.add(b58(d.mint));
        break;
      }
      // ── governance ────────────────────────────────────────────────────
      case "ParamsQueued":
      case "ParamsUpdated":
      case "ParamsCancelled":
      case "PauseSet":
      case "KeepersSet":
      case "OperatorsSet":
      case "ConfigQueued":
      case "ConfigUpdated":
      case "ConfigCancelled":
      case "AdminAccepted":
      case "GlobalInitialized": {
        await c.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, JSON.stringify({ type: "params", event: e.name })]);
        ctx.paramsChanged = true;
        break;
      }
    }
  }
}

async function removeFromQueue(ctx: TxCtx, ticket: string, mint: string) {
  const r = await ctx.c.query<{ amount: string }>("DELETE FROM queue_entries WHERE ticket = $1 RETURNING amount", [ticket]);
  if (r.rows[0]) await ctx.c.query("UPDATE coins SET queue_owed = GREATEST(queue_owed - $2::numeric, 0) WHERE mint = $1", [mint, r.rows[0].amount]);
}
