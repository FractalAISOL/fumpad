# FUMPAD — Technical Spec v0.1

Status: draft for review · 2026-10-11 · Source concept: `concept-overview.pdf`

## 0. Locked decisions

| # | Decision |
|---|---|
| D1 | Only **graduated** coins are claimable. Sells made on the curve still create tickets. Early curve sells that are already ≥10x at graduation qualify (accepted). |
| D2 | 10x is measured **in SOL** against the seller's execution price. The $50 minimum is in **USD** (Pyth SOL/USD at sell time). |
| D3 | Claims that can't be paid in full **wait in the queue** (no partial payouts). |
| D4 | Queue is **skip-ahead**: processed in sell-time order, but an entry that doesn't fit is skipped so smaller ones behind it can pay. |
| D5 | Queued claims **do not expire** (the 90-day clock stops at queue entry). *(assumed — confirm)* |
| D6 | 10x check = **own on-chain sampler** (Option A): keeper-signed price samples, median over 30 min. |
| D7 | **Own bonding curve**; graduation creates a **PumpSwap** pool (permissionless, verified). |

## 1. Verified facts (Phase 0 check)

- PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, same ID on mainnet + devnet. `create_pool` is permissionless; pool PDA = `["pool", index, creator, base_mint, quote_mint]`.
- Non-canonical pools (not created by pump's migrate) pay **0.20% LP + 0.05% protocol = 0.25%**; no creator fee; pump's market-cap fee tiers apply only to canonical pools.
- Supports Token-2022 base mints.
- **Risk:** PumpSwap has shipped several breaking account-list upgrades (e.g. Apr 28, Sep 1). Its admin can also change fees or disable instructions. → Router must be upgrade-tolerant (§5.2), and the design keeps a venue abstraction (Raydium CPMM / Meteora fallback).
- Pump.fun reference curve: 1B supply, 6 decimals, virtual 30 SOL / 1,073M tokens, 793.1M sold on curve, ~85 SOL raised at completion, LP burned.

## 2. Architecture

```
            ┌──────────────── Next.js app (feed, coin, My Fumbles, launch, leaderboards)
            │                         │ REST + WebSocket
            │                 ┌───────▼────────┐
 wallet ────┤                 │ API + indexer  │◄── Helius stream (program events)
 (Phantom…) │                 │ Postgres       │
            │                 └───────▲────────┘
            ▼                         │ events
   ┌──────────────────── fumpad program (Anchor, single program) ─────────────────────┐
   │ curve  │ router (post-grad) │ rewards (tickets, claims, queue) │ oracle (samples) │
   └────┬───────────────┬──────────────────────────────────────────────────▲──────────┘
        │ CPI           │ CPI                                             │ signed samples
   Token-2022       PumpSwap AMM                Pyth SOL/USD          keeper service
```

One program, four modules. A single program keeps trust boundaries simple (no cross-program auth) and gives auditors one surface. Modules share state definitions fixed in Phase 0 so agents can build them in parallel.

## 3. Token & curve

- **Mint:** Token-2022 with metadata-pointer + token-metadata extensions only (no transfer hooks, no transfer fees). 1,000,000,000 supply, 6 decimals. Mint authority revoked after mint; no freeze authority.
- **Allocation at launch:** 50M (5%) → coin's reward pool vault · ~753.4M → curve · ~196.6M → reserved for PumpSwap LP.
- **Curve:** constant product on virtual reserves (pump.fun style). Initial virtual SOL 30, initial virtual tokens **~1,019.4M** (re-derived so the graduation price equals the LP price with 950M non-pool supply). Start→graduation price ratio ≈ 14.7x. All parameters live in `Global` so the simulation can tune them.
- **Graduation:** the buy that crosses the threshold (default 85 SOL real) is capped to finish the curve; `complete = true`. Anyone can then call `graduate`, which creates the PumpSwap pool (index 0, creator = program PDA, coin_creator = default) with the LP tokens + raised SOL minus a graduation fee, and **burns the LP tokens**.
- Math in u128, rounding always in the protocol's favor. Property tests: k never decreases, no free tokens, sum of balances conserved.

## 4. Fees (1% of SOL side, every FUMPAD trade, pre- and post-graduation)

| Share | Destination |
|---|---|
| 50% | Pool buyback → coin's reward pool vault |
| 30% | Platform fee vault |
| 20% | Creator fee vault (claimable by creator at any time, unconditional) |

- **Pre-graduation buyback:** inline. The program buys from its own curve into the pool vault within the same instruction.
- **Post-graduation buyback:** SOL accrues in the coin's buyback vault; a permissionless `execute_buyback` crank swaps it on PumpSwap only when spot is within ±3% of the 30-min median (blocks sandwich setups), in slices ≤ 0.5% of pool depth.
- Fee bps and split are global params (admin, timelocked).

## 5. Modules

### 5.1 Curve
`create_coin(name, symbol, uri)` · `buy(sol_in, min_tokens_out)` · `sell(tokens_in, min_sol_out)` · `graduate()`.

### 5.2 Router (post-graduation)
`swap_buy(sol_in, min_out)` / `swap_sell(tokens_in, min_out)` CPI into PumpSwap.
- **Upgrade tolerance:** PumpSwap accounts are passed through `remaining_accounts`; the router validates only what matters (program ID, pool == `coin.amm_pool`, user token accounts, mints) and measures **balance deltas** before/after rather than trusting any return layout. A PumpSwap account-list change then needs a client update, not a program upgrade.
- WSOL wrap/unwrap is handled in the client transaction.

### 5.3 Rewards

**Position** `(wallet, mint)`: eligible balance + timestamp of last increase, list of open ticket keys (≤5), rebuy window.
- Increased by FUMPAD buys, or by `register_holdings` (snapshots the wallet's current balance; lets people who bought elsewhere become eligible). Either way the 10-min hold clock restarts for the added amount.

**Sell → ticket.** A sell creates a `Ticket` when all of these hold:
1. USD value of the sell ≥ $50 (Pyth SOL/USD, staleness ≤ 60s, confidence check).
2. The seller is not the coin creator.
3. The sold tokens have been eligible for ≥10 min. Ticket amount = min(sold, aged eligible balance).
4. The wallet has fewer than 5 open tickets on this coin.

If any check fails, the sell still goes through, just without a ticket.

Ticket fields: tokens, sell price (SOL/token, Q64 fixed point, execution average before FUMPAD fee), sell timestamp, status (`Open → Queued → Claimed | Expired | Voided`). The seller pays ~0.002 SOL rent, refunded when the ticket is closed.

**Rebuy rule.** A FUMPAD buy (or `register_holdings` increase) within 7 days of an open/queued ticket's sell debits that ticket's tokens by the amount rebought, newest ticket first, down to 0 (→ `Voided`). The client must pass every open ticket (≤5, listed in Position); the program enforces completeness.

**Claim.** `claim(ticket)` succeeds when:
- the coin has graduated
- now ≤ sell timestamp + 90 days
- oracle median ≥ 10 × sell price, with sample coverage met

Amount = 10% × ticket tokens. If amount ≤ 10% of the pool balance **and** no older fitting entry is waiting → paid in the same transaction. Otherwise → `Queued`.

**Queue (per coin, zero-copy, sorted by sell timestamp, capacity 512).** `process_queue` is a permissionless crank: it walks in order and pays every entry whose amount ≤ 10% of the current pool, skipping the rest (D4). Queued entries never expire (D5). If the queue is full, the claim reverts with "queue full" and the ticket stays `Open`.

### 5.4 Oracle (10x check)

- **Observations (per graduated coin, zero-copy ring, 256 slots):** `(ts, price_q64)` computed from PumpSwap reserves (effective quote = vault + `virtual_quote_reserves`).
- `record_samples(coins[])` is signed by one of ≤3 registered keeper keys. Multiple coins per transaction: one signature covers ~8 coins.
- **Rules:**
  - ≥10s between samples.
  - The sampling transaction must contain no other non-compute-budget instructions (instruction-sysvar check).
  - Claim requires ≥70% coverage: at least 84 of 120 expected samples in the last 30 min.
  - The **median** of those samples must be ≥ trigger.
- **Cost control:** the keeper only samples coins whose spot price is ≥50% of their lowest open trigger, so it doesn't pay to sample coins nowhere near 10x.
- **Liveness fallback:** if a coin has no keeper sample for >10 min, `record_samples` becomes permissionless for that coin. The same rules apply, and fallback samples are flagged in the event log.

## 6. Admin & safety
- `Global.admin` = Squads multisig. Program upgrade authority = the same multisig.
- 48h timelock on fee/param changes.
- Pause flags: `pause_launch`, `pause_trade`, `pause_claims`. Pausing never blocks sells on graduated coins via PumpSwap directly.
- Every state change emits an Anchor event (`emit_cpi!`) — the indexer's sole source of truth.

## 7. Off-chain
- **Keeper (TS):** observation sampling, `process_queue`, `execute_buyback`, `graduate` cranks. Runs on Railway, health alarms to Telegram.
- **Indexer/API (TS, Postgres):** Helius stream → events → tables (coins, trades, tickets, claims, queue, samples, users). REST + WebSocket feed.
  - Off-chain flagging: rebuys made elsewhere, linked-wallet clusters (funding-graph heuristics). Flagged wallets are shown publicly and excluded from leaderboards; their claims are not blocked.
  - Game layer: levels, achievements, leaderboards (off-chain, derived from events).
- **App:** Next.js, Solana wallet adapter, design system from the chosen direction.

## 8. Testing & quality gates
- Rust unit tests and property tests (curve math, fee split, queue ordering).
- LiteSVM integration tests with the **real PumpSwap program** dumped from devnet. One test per abuse rule in concept §07, plus:
  - oracle manipulation scenarios (spike, sustained push, keeper outage)
  - queue fairness with skip-ahead
  - rent and close paths
  - graduation price continuity
- Devnet end-to-end: launch → curve trades → graduate → post-grad trades → sampling → claim / queue → expiry.
- An independent red-team agent reviews each module before it's marked done.
- **Simulation (Python):** agent-based model of pool solvency across volume and price paths and attacker mixes. Outputs: % of claims paid, time in queue, pool depletion, sensitivity to the 10x / 10% / 5% / fee parameters. No revenue projections.

## 9. Open questions
1. D5 confirm: queued claims don't expire.
2. Graduation fee (platform) amount — default 0 for beta?
3. Creator exclusion is wallet-based only; alt wallets are handled by flagging. OK?
4. Sells through other venues (Jupiter, etc.) never create tickets — intended, per concept.
