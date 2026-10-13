/**
 * Event → table updates. Runs inside the ingest DB transaction, one call per chain
 * transaction (handlers sometimes need sibling events: a TicketCreated's execution price
 * lives in the Trade emitted by the same sell).
 *
 * Every write is idempotent (ON CONFLICT DO NOTHING on event tables) and the whole
 * current-state layer can be rebuilt per mint from `events` (replay.ts), which is how
 * rollbacks of dropped transactions are handled.
 */
import { PublicKey } from "@solana/web3.js";

import {
  baseToTokens,
  BPS_DENOM,
  type FumpadEvent,
  lamportsToSol,
  medianPriceQ64,
  type Params,
  priceQ64,
  q64ToSolPerToken,
  TICKET_STATUS_NAMES,
} from "@fumpad/sdk/v06";

import { NOTIFY_CHANNEL, type Tx } from "./db.js";

export interface TxCtx {
  c: Tx;
  signature: string;
  slot: number;
  blockTime: number | null;
  params: Params;
  /** Mints whose current state changed (for chain sync + API cache invalidation). */
  touched: Set<string>;
  /** Wallets whose tickets/positions/balances changed (live updates to their views). */
  wallets?: Set<string>;
  /** A Params* event was seen: reload Global. */
  paramsChanged?: boolean;
}

const s = (v: bigint | number) => v.toString();
const touchWallet = (ctx: TxCtx, w: string | undefined | null) => {
  if (w) ctx.wallets?.add(w);
};
const b58 = (k: PublicKey) => k.toBase58();

/** JSON-safe copy of an event payload (bigint → string, PublicKey → base58). */
export function jsonify(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map(jsonify);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonify(x)]));
  return v;
}

/** Mint an event refers to (TicketDebited/TicketClosed resolve through the tickets table). */
export async function eventMint(c: Tx, e: FumpadEvent): Promise<string | null> {
  const d = e.data as unknown as Record<string, unknown>;
  if (d.mint instanceof PublicKey) return d.mint.toBase58();
  if (d.ticket instanceof PublicKey) {
    const r = await c.query<{ mint: string }>("SELECT mint FROM tickets WHERE ticket = $1", [d.ticket.toBase58()]);
    return r.rows[0]?.mint ?? null;
  }
  return null;
}

export const multipleOf = (priceQ64v: bigint, ticketPriceQ64: bigint) =>
  ticketPriceQ64 === 0n ? 0 : Number((priceQ64v * 1_000_000n) / ticketPriceQ64) / 1_000_000;

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

/** Recompute the coin's oracle median from indexed samples (same rule as the program). */
async function refreshMedian(ctx: TxCtx, mint: string, now: bigint): Promise<bigint | null> {
  const p = ctx.params;
  const r = await ctx.c.query<{ price_q64: string; ts: string; fallback: boolean }>(
    "SELECT price_q64, ts, fallback FROM samples WHERE mint = $1 AND ts > $2 AND ts <= $3",
    [mint, s(now - p.oracleWindowSecs), s(now)],
  );
  const samples = r.rows.map((x) => ({ ts: BigInt(x.ts), priceQ64: BigInt(x.price_q64), fallback: x.fallback }));
  // v0.3: keeper-only samples, ≥ min count AND ≥ 5 of 6 time buckets (same as the program).
  const med = medianPriceQ64(samples, now, p.oracleWindowSecs, p.oracleMinSamples);
  const keeper = samples.filter((x) => !x.fallback).length;
  await ctx.c.query("UPDATE coins SET median_q64 = $2, median_samples = $3 WHERE mint = $1", [mint, med === null ? null : s(med), keeper]);
  return med;
}

/** Update multiples/peaks for the coin's open tickets at `priceQ64`; emit `cross` feed items. */
async function trackMultiples(ctx: TxCtx, mint: string, priceQ64v: bigint, ts: bigint, crossable: boolean) {
  const p = ctx.params;
  const rows = await ctx.c.query<{ ticket: string; owner: string; tokens: string; sell_price_q64: string; crossed_at: string | null; peak_multiple: number }>(
    "SELECT ticket, owner, tokens, sell_price_q64, crossed_at, peak_multiple FROM tickets WHERE mint = $1 AND status IN ('open','queued')",
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

/** Apply all events of one transaction (in order). */
export async function applyEvents(ctx: TxCtx, events: FumpadEvent[]): Promise<void> {
  const { c, params: p } = ctx;
  for (const e of events) {
    const id = `${ctx.signature}:${e.index}`;
    switch (e.name) {
      case "CoinCreated": {
        const d = e.data;
        const mint = b58(d.mint);
        const realTokens = p.curveSupply;
        await c.query(
          `INSERT INTO coins (mint, creator, name, symbol, uri, created_at, created_sig, status, virtual_sol, virtual_tokens, real_sol, real_tokens,
             price_q64, price_slot, reference_q64, pool_seeded, pool_tokens)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'curve',$8,$9,0,$10,$11,$12,$11,$13,$13) ON CONFLICT (mint) DO NOTHING`,
          [mint, b58(d.creator), d.name, d.symbol, d.uri, s(d.ts), ctx.signature, s(p.initialVirtualSol), s(p.initialVirtualToken), s(realTokens), s(priceQ64(p.initialVirtualSol, p.initialVirtualToken)!), ctx.slot, s(p.rewardPoolSupply)],
        );
        // D18: a pooled vanity mint is spent for good — mark it used and wipe its secret.
        await c.query(
          `UPDATE vanity_mints SET status = 'used', used_tx = $2, used_at = now(), secret_enc = NULL WHERE pubkey = $1 AND status <> 'used'`,
          [mint, ctx.signature],
        );
        await upsertUser(ctx, b58(d.creator), d.ts);
        touchWallet(ctx, b58(d.creator));
        await feed(ctx, `${id}:launch`, "launch", d.ts, mint, b58(d.creator), { poolTokens: baseToTokens(p.rewardPoolSupply) });
        ctx.touched.add(mint);
        break;
      }
      case "Trade": {
        const d = e.data;
        const mint = b58(d.mint);
        const wallet = b58(d.user);
        // D19 (v0.5): 0 outside the launch window and for v0.4 events (decoded with the fields zeroed).
        const snipeTax = d.snipeTax ?? 0n;
        const snipeBps = d.snipeTaxBps ?? 0;
        const ins = await c.query(
          `INSERT INTO trades (signature, idx, slot, ts, mint, wallet, is_buy, on_amm, token_amount, sol_amount, fee_pool, fee_platform, fee_creator,
             pool_tokens_bought, price_q64, virtual_sol, virtual_tokens, snipe_tax, snipe_tax_bps)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT DO NOTHING`,
          [ctx.signature, e.index, ctx.slot, s(d.ts), mint, wallet, d.isBuy, d.onAmm, s(d.tokenAmount), s(d.solAmount), s(d.feePool), s(d.feePlatform), s(d.feeCreator), s(d.poolTokensBought), s(d.priceQ64), s(d.virtualSolReserves), s(d.virtualTokenReserves), s(snipeTax), snipeBps],
        );
        if (!ins.rowCount) break;
        const spot = priceQ64(d.virtualSolReserves, d.virtualTokenReserves) ?? 0n;
        if (!d.onAmm) {
          const realSol = d.virtualSolReserves - p.initialVirtualSol;
          const realTokens = d.virtualTokenReserves - (p.initialVirtualToken - p.curveSupply);
          await c.query(
            `UPDATE coins SET virtual_sol = $2, virtual_tokens = $3, real_sol = $4, real_tokens = $5, price_q64 = $6, price_slot = $7
             WHERE mint = $1 AND price_slot <= $7`,
            [mint, s(d.virtualSolReserves), s(d.virtualTokenReserves), s(realSol), s(realTokens), s(spot), ctx.slot],
          );
        } else {
          await c.query(
            `UPDATE coins SET amm_quote = $2, amm_base = $3, price_q64 = $4, price_slot = $5 WHERE mint = $1 AND price_slot <= $5`,
            [mint, s(d.virtualSolReserves), s(d.virtualTokenReserves), s(spot), ctx.slot],
          );
        }
        await c.query(
          `UPDATE coins SET volume_lamports = volume_lamports + $2, trade_count = trade_count + 1, last_trade_at = GREATEST(COALESCE(last_trade_at,0), $3),
             pool_tokens = pool_tokens + $4, pool_bought = pool_bought + $4,
             pool_inflow_lamports = pool_inflow_lamports + $5 + $6,
             snipe_tax_lamports = snipe_tax_lamports + $6, snipe_taxed_buys = snipe_taxed_buys + (CASE WHEN $6::numeric > 0 THEN 1 ELSE 0 END),
             updated_at = now() WHERE mint = $1`,
          [mint, s(d.solAmount), s(d.ts), s(d.poolTokensBought), s(d.feePool), s(snipeTax)],
        );
        // Cost basis: a buy costs sol + fees + snipe tax (the tax is charged to the buyer).
        await position(ctx, mint, wallet, d.ts, d.isBuy
          ? { balance: d.tokenAmount, bought: d.tokenAmount, solIn: d.solAmount + d.feePool + d.feePlatform + d.feeCreator + snipeTax, buys: 1 }
          : { balance: -d.tokenAmount, sold: d.tokenAmount, solOut: d.solAmount - d.feePool - d.feePlatform - d.feeCreator, sells: 1 });
        await upsertUser(ctx, wallet, d.ts);
        if (d.onAmm) await trackMultiples(ctx, mint, spot, d.ts, false);
        touchWallet(ctx, wallet);
        ctx.touched.add(mint);
        break;
      }
      case "CurveCompleted": {
        await c.query("UPDATE coins SET status = 'complete', completed_at = $2 WHERE mint = $1 AND status = 'curve'", [b58(e.data.mint), s(e.data.ts)]);
        ctx.touched.add(b58(e.data.mint));
        break;
      }
      case "Graduated": {
        const d = e.data;
        const mint = b58(d.mint);
        const spot = priceQ64(d.solDeposited, d.tokensDeposited) ?? 0n;
        await c.query(
          `UPDATE coins SET status = 'graduated', graduated_at = $2, amm_pool = $3, raised_lamports = $4, tokens_to_lp = $5, lp_locked = $6,
             amm_quote = $4, amm_base = $5, price_q64 = $7, price_slot = $8, real_sol = 0,
             graduation_caller_refund = $9, graduation_setup_prefunded = $10, graduation_platform_fee = $11 WHERE mint = $1`,
          [
            mint, s(d.ts), b58(d.pool), s(d.solDeposited), s(d.tokensDeposited), s(d.lpLocked), s(spot), ctx.slot,
            // D20 (v0.5) fee split; NULL for a v0.4 Graduated (no split recorded).
            ...(e.legacy ? [null, null, null] : [s(d.callerRefund), s(d.setupPrefunded), s(d.platformFee)]),
          ],
        );
        // Tickets already ≥ trigger at the graduation price become claimable once sampled (D1).
        const r = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM tickets WHERE mint = $1 AND status = 'open' AND $2::numeric * 10000 >= sell_price_q64 * $3`,
          [mint, s(spot), p.triggerMultipleBps],
        );
        const coin = await c.query<{ creator: string }>("SELECT creator FROM coins WHERE mint = $1", [mint]);
        await feed(ctx, `${id}:graduation`, "graduation", d.ts, mint, coin.rows[0]?.creator ?? "", {
          raisedSol: lamportsToSol(d.solDeposited),
          ticketsUnlocked: Number(r.rows[0].n),
          pool: b58(d.pool),
        });
        await trackMultiples(ctx, mint, spot, d.ts, false);
        ctx.touched.add(mint);
        break;
      }
      case "Locked": {
        const d = e.data;
        await c.query(
          "INSERT INTO lp_locks (signature, idx, pool, mint, lp_locked, lp_supply, sqrt_k) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [ctx.signature, e.index, b58(d.pool), b58(d.mint), s(d.lpLocked), s(d.lpSupply), s(d.sqrtK)],
        );
        break;
      }
      case "TicketCreated": {
        const d = e.data;
        const mint = b58(d.mint);
        const owner = b58(d.owner);
        // The sell's Trade (same tx, same mint+user) carries the execution price and SOL.
        const trade = events.find((x) => x.name === "Trade" && x.data.mint.equals(d.mint) && x.data.user.equals(d.owner) && !x.data.isBuy);
        const tr = trade?.name === "Trade" ? trade.data : null;
        const exec = tr ? tr.priceQ64 : d.sellPriceQ64;
        const sellLamports = tr && tr.tokenAmount > 0n ? (tr.solAmount * d.tokens) / tr.tokenAmount : (d.tokens * d.sellPriceQ64) >> 64n;
        const seq = await c.query<{ n: string }>("SELECT count(*) AS n FROM tickets WHERE mint = $1 AND owner = $2", [mint, owner]);
        const ins = await c.query(
          `INSERT INTO tickets (ticket, mint, owner, seq, tokens, original_tokens, sell_price_q64, exec_price_q64, sell_usd_cents, sell_lamports, sell_ts, created_sig, created_slot)
           VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (ticket) DO NOTHING`,
          [b58(d.ticket), mint, owner, seq.rows[0].n, s(d.tokens), s(d.sellPriceQ64), s(exec), s(d.sellUsdCents), s(sellLamports), s(d.ts), ctx.signature, ctx.slot],
        );
        if (!ins.rowCount) break;
        await c.query("UPDATE coins SET tickets_created = tickets_created + 1, tickets_open = tickets_open + 1 WHERE mint = $1", [mint]);
        touchWallet(ctx, owner);
        await feed(ctx, `${id}:fumble`, "fumble", d.ts, mint, owner, {
          ticket: b58(d.ticket),
          tokens: baseToTokens(d.tokens),
          sol: lamportsToSol(sellLamports),
          ticketPrice: q64ToSolPerToken(d.sellPriceQ64),
        });
        ctx.touched.add(mint);
        break;
      }
      case "TicketDebited": {
        const d = e.data;
        const ticket = b58(d.ticket);
        const t = await c.query<{ mint: string; status: string; owner: string }>("SELECT mint, status, owner FROM tickets WHERE ticket = $1", [ticket]);
        const mint = t.rows[0]?.mint ?? null;
        touchWallet(ctx, t.rows[0]?.owner);
        await c.query(
          "INSERT INTO ticket_debits (signature, idx, ticket, mint, debited, remaining, voided, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
          [ctx.signature, e.index, ticket, mint, s(d.debited), s(d.remaining), d.voided, s(d.ts)],
        );
        if (!mint) break;
        const claimAmt = (d.remaining * BigInt(p.claimBps)) / BPS_DENOM;
        await c.query(
          `UPDATE tickets SET tokens = $2, debited = debited + $3, status = CASE WHEN $4 THEN 'voided' ELSE status END,
             claim_amount = CASE WHEN status = 'queued' THEN $5 ELSE claim_amount END WHERE ticket = $1`,
          [ticket, s(d.remaining), s(d.debited), d.voided, s(claimAmt)],
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
      case "ClaimQueued": {
        const d = e.data;
        const mint = b58(d.mint);
        const ticket = b58(d.ticket);
        const t = await c.query<{ sell_ts: string }>("SELECT sell_ts FROM tickets WHERE ticket = $1", [ticket]);
        const by = b58(d.triggeredBy);
        const auto = by !== b58(d.owner);
        touchWallet(ctx, b58(d.owner));
        await c.query("UPDATE tickets SET status = 'queued', queued_at = $2, claim_amount = $3, auto_claimed = $4, crossed_at = COALESCE(crossed_at, $2) WHERE ticket = $1", [ticket, s(d.ts), s(d.amount), auto]);
        const ins = await c.query(
          "INSERT INTO queue_entries (ticket, mint, owner, amount, sell_ts, queued_at, triggered_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ticket) DO NOTHING",
          [ticket, mint, b58(d.owner), s(d.amount), t.rows[0]?.sell_ts ?? s(d.ts), s(d.ts), by],
        );
        if (ins.rowCount) await c.query("UPDATE coins SET queue_owed = queue_owed + $2 WHERE mint = $1", [mint, s(d.amount)]);
        ctx.touched.add(mint);
        break;
      }
      case "ClaimPaid": {
        const d = e.data;
        const mint = b58(d.mint);
        const ticket = b58(d.ticket);
        const owner = b58(d.owner);
        const t = await c.query<{ sell_price_q64: string; sell_ts: string; status: string }>("SELECT sell_price_q64, sell_ts, status FROM tickets WHERE ticket = $1", [ticket]);
        const tr = t.rows[0];
        // Skip-ahead (D4): paid from the queue while an OLDER entry is still waiting.
        const older = d.fromQueue && tr
          ? await c.query("SELECT 1 FROM queue_entries WHERE mint = $1 AND ticket <> $2 AND (sell_ts < $3 OR (sell_ts = $3 AND ticket < $2)) LIMIT 1", [mint, ticket, tr.sell_ts])
          : { rowCount: 0 };
        const skipped = !!older.rowCount;
        const by = b58(d.triggeredBy);
        // v0.4: a keeper's claim_for paid it directly (queue payouts are always cranked).
        const auto = by !== owner && !d.fromQueue;
        const ins = await c.query(
          `INSERT INTO claims (signature, idx, mint, ticket, owner, amount, from_queue, skipped_ahead, median_q64, sell_price_q64, ts, triggered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
          [ctx.signature, e.index, mint, ticket, owner, s(d.amount), d.fromQueue, skipped, s(d.medianPriceQ64), tr?.sell_price_q64 ?? null, s(d.ts), by],
        );
        if (!ins.rowCount) break;
        await c.query(
          // A claim proves the covered median held the trigger (coverage can complete by time alone,
          // between samples, so the sample-driven cross detection may not have fired yet).
          "UPDATE tickets SET status = 'claimed', claimed_at = $2, claim_sig = $3, claim_amount = $4, claim_median_q64 = $5, auto_claimed = auto_claimed OR $6, crossed_at = COALESCE(crossed_at, $2) WHERE ticket = $1",
          [ticket, s(d.ts), ctx.signature, s(d.amount), s(d.medianPriceQ64), auto],
        );
        await removeFromQueue(ctx, ticket, mint);
        await c.query(
          `UPDATE coins SET pool_tokens = GREATEST(pool_tokens - $2::numeric, 0), pool_paid_out = pool_paid_out + $2,
             tickets_open = CASE WHEN $3 THEN GREATEST(tickets_open - 1, 0) ELSE tickets_open END WHERE mint = $1`,
          [mint, s(d.amount), tr ? tr.status === "open" || tr.status === "queued" : false],
        );
        await position(ctx, mint, owner, d.ts, { balance: d.amount, claimed: d.amount });
        const multiple = tr ? multipleOf(d.medianPriceQ64, BigInt(tr.sell_price_q64)) : 0;
        await feed(ctx, `${id}:claim`, "claim", d.ts, mint, owner, {
          ticket,
          multiple,
          tokens: baseToTokens(d.amount),
          sol: baseToTokens(d.amount) * q64ToSolPerToken(d.medianPriceQ64),
          fromQueue: d.fromQueue,
          skippedAhead: skipped,
          auto,
        });
        await upsertUser(ctx, owner, d.ts);
        touchWallet(ctx, owner);
        ctx.touched.add(mint);
        break;
      }
      case "TicketClosed": {
        const d = e.data;
        const ticket = b58(d.ticket);
        const t = await c.query<{ mint: string; status: string; owner: string }>("SELECT mint, status, owner FROM tickets WHERE ticket = $1", [ticket]);
        if (!t.rows[0]) break;
        touchWallet(ctx, t.rows[0].owner);
        const status = TICKET_STATUS_NAMES[d.finalStatus] ?? "expired";
        await c.query("UPDATE tickets SET status = $2, closed_at = $3 WHERE ticket = $1", [ticket, status, s(d.ts)]);
        await removeFromQueue(ctx, ticket, t.rows[0].mint);
        if (t.rows[0].status === "open" || t.rows[0].status === "queued") {
          await c.query("UPDATE coins SET tickets_open = GREATEST(tickets_open - 1, 0) WHERE mint = $1", [t.rows[0].mint]);
        }
        ctx.touched.add(t.rows[0].mint);
        break;
      }
      case "SampleRecorded": {
        const d = e.data;
        const mint = b58(d.mint);
        const ins = await c.query(
          "INSERT INTO samples (signature, idx, mint, price_q64, fallback, ts) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [ctx.signature, e.index, mint, s(d.priceQ64), d.fallback, s(d.ts)],
        );
        if (!ins.rowCount) break;
        await c.query("UPDATE coins SET price_q64 = $2, price_slot = $3 WHERE mint = $1 AND price_slot <= $3", [mint, s(d.priceQ64), ctx.slot]);
        const med = await refreshMedian(ctx, mint, d.ts);
        if (med !== null) await trackMultiples(ctx, mint, med, d.ts, true);
        ctx.touched.add(mint);
        break;
      }
      case "BuybackExecuted": {
        const d = e.data;
        const mint = b58(d.mint);
        const ins = await c.query(
          "INSERT INTO buybacks (signature, idx, mint, lamports_in, tokens_out, ts) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [ctx.signature, e.index, mint, s(d.lamportsIn), s(d.tokensOut), s(d.ts)],
        );
        if (ins.rowCount) await c.query("UPDATE coins SET pool_tokens = pool_tokens + $2, pool_bought = pool_bought + $2 WHERE mint = $1", [mint, s(d.tokensOut)]);
        ctx.touched.add(mint);
        break;
      }
      case "FeesWithdrawn": {
        const d = e.data;
        await c.query(
          "INSERT INTO fee_withdrawals (signature, idx, mint, recipient, lamports, is_creator, ts) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [ctx.signature, e.index, b58(d.mint), b58(d.recipient), s(d.lamports), d.creator, s(d.ts)],
        );
        touchWallet(ctx, b58(d.recipient));
        ctx.touched.add(b58(d.mint));
        break;
      }
      case "HoldingsRegistered": {
        const d = e.data;
        await c.query(
          "INSERT INTO holdings_registered (signature, idx, mint, wallet, added, ts) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
          [ctx.signature, e.index, b58(d.mint), b58(d.wallet), s(d.added), s(d.ts)],
        );
        await upsertUser(ctx, b58(d.wallet), d.ts);
        break;
      }
      case "LpFeesSettled": {
        const d = e.data;
        await c.query(
          "INSERT INTO lp_settlements (signature, idx, mint, lamports, platform, creator, ts) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [ctx.signature, e.index, b58(d.mint), s(d.lamports), s(d.platform), s(d.creator), s(d.ts)],
        );
        ctx.touched.add(b58(d.mint));
        break;
      }
      case "CurveReopened": {
        // D13 escape hatch: a coin stuck Complete for 7 days reopened curve sells.
        await c.query("UPDATE coins SET status = 'curve', completed_at = NULL WHERE mint = $1", [b58(e.data.mint)]);
        ctx.touched.add(b58(e.data.mint));
        break;
      }
      case "ClaimEscrowed": {
        // D16: queued payout to an owner whose ATA refused it → per-ticket escrow.
        const d = e.data;
        const mint = b58(d.mint);
        const ticket = b58(d.ticket);
        const owner = b58(d.owner);
        touchWallet(ctx, owner);
        const t = await c.query<{ sell_price_q64: string; status: string }>("SELECT sell_price_q64, status FROM tickets WHERE ticket = $1", [ticket]);
        const ins = await c.query(
          `INSERT INTO claims (signature, idx, mint, ticket, owner, amount, from_queue, escrowed, median_q64, sell_price_q64, ts, triggered_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true,0,$8,$9,$10) ON CONFLICT DO NOTHING`,
          // v0.4: claim_for can escrow directly (owner ATA refused), not only process_queue.
          [ctx.signature, e.index, mint, ticket, owner, s(d.amount), t.rows[0]?.status === "queued", t.rows[0]?.sell_price_q64 ?? null, s(d.ts), b58(d.triggeredBy)],
        );
        if (!ins.rowCount) break;
        await c.query("UPDATE tickets SET status = 'escrowed', claim_amount = $2, claimed_at = $3, claim_sig = $4, escrow = $5 WHERE ticket = $1", [ticket, s(d.amount), s(d.ts), ctx.signature, b58(d.escrow)]);
        await removeFromQueue(ctx, ticket, mint);
        await c.query(
          `UPDATE coins SET pool_tokens = GREATEST(pool_tokens - $2::numeric, 0), pool_paid_out = pool_paid_out + $2,
             tickets_open = CASE WHEN $3 THEN GREATEST(tickets_open - 1, 0) ELSE tickets_open END WHERE mint = $1`,
          [mint, s(d.amount), t.rows[0] ? t.rows[0].status === "open" || t.rows[0].status === "queued" : false],
        );
        ctx.touched.add(mint);
        break;
      }
      case "AutoClaimSet": {
        const d = e.data;
        const mint = b58(d.mint);
        await c.query(
          `INSERT INTO positions (mint, wallet, auto_claim_opt_out, first_ts, last_ts) VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (mint, wallet) DO UPDATE SET auto_claim_opt_out = EXCLUDED.auto_claim_opt_out`,
          [mint, b58(d.wallet), !d.enabled, s(d.ts)],
        );
        touchWallet(ctx, b58(d.wallet));
        ctx.touched.add(mint);
        break;
      }
      case "EscrowWithdrawn": {
        const d = e.data;
        const mint = b58(d.mint);
        await c.query("UPDATE tickets SET status = 'claimed' WHERE ticket = $1", [b58(d.ticket)]);
        await position(ctx, mint, b58(d.owner), d.ts, { balance: d.amount, claimed: d.amount });
        touchWallet(ctx, b58(d.owner));
        ctx.touched.add(mint);
        break;
      }
      case "ParamsQueued":
      case "ParamsUpdated":
      case "ParamsCancelled": {
        // Global params changed or a change is pending: the indexer reloads Global (main.ts).
        await c.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, JSON.stringify({ type: "params", event: e.name })]);
        ctx.paramsChanged = true;
        break;
      }
      case "Skimmed": {
        const d = e.data;
        const mint = b58(d.mint);
        const ins = await c.query(
          "INSERT INTO lp_skims (signature, idx, pool, mint, lp_withdrawn, base_out, quote_out, lp_held, ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
          [ctx.signature, e.index, b58(d.pool), mint, s(d.lpWithdrawn), s(d.baseOut), s(d.quoteOut), s(d.lpHeld), ctx.blockTime],
        );
        if (ins.rowCount) await c.query("UPDATE coins SET pool_tokens = pool_tokens + $2 WHERE mint = $1", [mint, s(d.baseOut)]);
        ctx.touched.add(mint);
        break;
      }
    }
  }
}

async function removeFromQueue(ctx: TxCtx, ticket: string, mint: string) {
  const r = await ctx.c.query<{ amount: string }>("DELETE FROM queue_entries WHERE ticket = $1 RETURNING amount", [ticket]);
  if (r.rows[0]) await ctx.c.query("UPDATE coins SET queue_owed = GREATEST(queue_owed - $2::numeric, 0) WHERE mint = $1", [mint, r.rows[0].amount]);
}
