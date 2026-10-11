# FUMPAD — Technical Spec v0.1

Status: v0.2 — matches the merged contracts · 2026-10-11 · Source concept: `concept-overview.pdf`

## 0. Locked decisions

| # | Decision |
|---|---|
| D1 | Only **graduated** coins are claimable. Sells made on the curve still create tickets. Early curve sells that are already ≥10x at graduation qualify (accepted). |
| D2 | 10x is measured **in SOL** against the seller's execution price. The $50 minimum is in **USD** (Pyth SOL/USD at sell time). |
| D3 | Claims that can't be paid in full **wait in the queue** (no partial payouts). |
| D4 | Queue is **skip-ahead**: processed in sell-time order, but an entry that doesn't fit is skipped so smaller ones behind it can pay. |
| D5 | Queued claims **do not expire** (the 90-day clock stops at queue entry). |
| D6 | 10x check = **own on-chain sampler** (Option A): keeper-signed price samples, median over 30 min. |
| D7 | **Own bonding curve**; graduation creates a **PumpSwap** pool (permissionless, verified). |
| D8 | Graduation fee = **0 SOL** during beta (covers nothing but rent; param stays tunable). |
| D9 | Creator exclusion is **wallet-based**; suspected creator alt wallets are flagged publicly and excluded from leaderboards, not blocked from claiming. |
| D10 | **Ticket price = max(execution price, coin's 10-min reference average)**. FUMPAD keeps a per-coin time-weighted average updated on every FUMPAD trade and keeper sample, so a crash staged inside a bundle can't fake a low sell price (fix for the bundle dump→sell→rebuy exploit). Rule and analysis: §5.3. |
| D11 | **LP locked forever, fees skimmed.** At graduation the LP tokens go to a separate, **immutable** `fumpad_lp_locker` program (upgrade authority removed at deploy) instead of being burned. It can only skim fee growth (principal measured in √k per LP — `Pool.lp_supply` as denominator — stays constant, re-checked after every skim); skimmed base tokens go to the coin's reward pool and skimmed SOL is split 60/40 platform/creator, ≈50/30/20 by value. Earns PumpSwap's 0.20% LP fee on all post-graduation volume, including trades routed by other apps. Details §3.1. |
| D12 | **Slippage-fair floor, capped.** Refines D10: ticket price = max(execution price, ⌈reference × max(execution ÷ pre-trade spot, 0.90)⌉). Honest sellers get their real fill when their own price impact is ≤ 10%; a staged crash makes the ratio ≈ 1 so the floor stays at the reference; the 10% cap (`MAX_SELF_IMPACT_DISCOUNT_BPS`) limits the self-impact round trip to a 10% discount — §5.3. |

## 1. Verified facts (Phase 0 check)

- PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, same ID on mainnet + devnet. `create_pool` is permissionless; pool PDA = `["pool", index, creator, base_mint, quote_mint]`.
- Non-canonical pools (not created by pump's migrate) pay **0.20% LP + 0.05% protocol = 0.25%**; no creator fee; pump's market-cap fee tiers apply only to canonical pools.
- Supports Token-2022 base mints.
- **Risk:** PumpSwap has shipped several breaking account-list upgrades (e.g. Apr 28, Sep 1). Its admin can also change fees or disable instructions. → Router must be upgrade-tolerant (§5.2), and the design keeps a venue abstraction (Raydium CPMM / Meteora fallback).
- Pump.fun reference curve: 1B supply, 6 decimals, virtual 30 SOL / 1,073M tokens, 793.1M sold on curve, ~85 SOL raised at completion, LP burned. (FUMPAD locks its LP instead, D11.)
- PumpSwap LP (checked against the real program): `create_pool` mints `lp_supply` LP (9 decimals) to the creator minus a small permanently locked minimum; `withdraw` pays `lp_in × reserve ÷ Pool.lp_supply` and accepts destination token accounts the signer doesn't own; `Pool.lp_supply` ignores direct burns (stays at the minted total after every LP is burned); no fees on deposit/withdraw.

## 2. Architecture

```
            ┌──────────────── Next.js app (feed, coin, My Fumbles, launch, leaderboards)
            │                         │ REST + WebSocket
            │                 ┌───────▼────────┐
 wallet ────┤                 │ API + indexer  │◄── Helius stream (program events)
 (Phantom…) │                 │ Postgres       │
            │                 └───────▲────────┘
            ▼                         │ events
   ┌──────────────────── fumpad program (Anchor, upgradeable by multisig) ────────────┐
   │ curve  │ router (post-grad) │ rewards (tickets, claims, queue) │ oracle (samples) │
   └────┬───────────────┬─────────┬────────────────────────────────────────▲──────────┘
        │ CPI           │ CPI     │ CPI lock (graduate only)               │ signed samples
   Token-2022       PumpSwap AMM ◄┼─ withdraw ── fumpad_lp_locker          keeper service
                                  └────────────► (IMMUTABLE, ~200 lines)   Pyth SOL/USD
```

One main program, four modules, plus a tiny immutable satellite. The main program keeps trust boundaries simple and gives auditors one surface; modules share state definitions fixed in Phase 0 so agents can build them in parallel. `fumpad_lp_locker` (D11) is separate on purpose: it holds every pool's LP, so it must be *unchangeable* — no admin, no upgrade authority — while the main program stays upgradeable. Its only trust link is one-way and hard-coded: it accepts `lock` only from FUMPAD's pool-authority PDA and pays skims only to FUMPAD-derived accounts.

## 3. Token & curve

- **Mint:** Token-2022 with metadata-pointer + token-metadata extensions only (no transfer hooks, no transfer fees). 1,000,000,000 supply, 6 decimals. Mint authority revoked after mint; no freeze authority.
- **Allocation at launch:** 50M (5%) → coin's reward pool vault · ~753.4M → curve · ~196.6M → reserved for PumpSwap LP.
- **Curve:** constant product on virtual reserves (pump.fun style). Initial virtual SOL 30, initial virtual tokens **~1,019.4M** (re-derived so the graduation price equals the LP price with 950M non-pool supply). Start→graduation price ratio ≈ 14.7x. All parameters live in `Global` so the simulation can tune them.
- **Completion:** the curve completes when its **real tokens are exhausted**: the buy that would take more than what is left is partially filled (charged exactly the cost of the remaining tokens) and the coin becomes `Complete` (no trading). The parameters make that happen at ≈85 SOL raised (`graduation_lamports` is a sanity bound, not the trigger).
- **Graduation:** anyone calls `graduate`, which creates the PumpSwap pool (index 0, creator = program PDA, coin_creator = default) with the **whole curve vault** (= `lp_supply`) + raised SOL minus the graduation fee, and **locks every LP token** in the immutable `fumpad_lp_locker` (D11, CPI `lock`; replaces the burn): the LP lands in a vault owned by the locker's PDA and a `Lock` account ["lock", pool] records the principal. Afterwards LP mint supply == the locker's balance. The caller pays PumpSwap's account rent plus the Lock and LP-vault rent (~0.01 SOL net; 0.05 SOL is lent to the PDA and the unused part returned in the same instruction). ~300–310k CU; the transaction is 1011 bytes.

### 3.1 LP locker (D11)

`programs/fumpad_lp_locker` — two instructions, no admin, no config, nothing closable, upgrade authority removed at deploy (CONTRACTS.md).

- **Principal in √k units.** The value of one LP token, as PumpSwap's `withdraw` pays it, is `r = √(base × quote) ÷ Pool.lp_supply` (base = base-vault balance; quote = min(vault + `virtual_quote_reserves`, vault − waiting protocol/creator fees), i.e. never more than real liquidity). `Pool.lp_supply` — not the LP mint supply — is the right denominator: `withdraw` divides by it, and it ignores direct burns, so a burned LP's share stays in the pool unclaimed; dividing by the (smaller) mint supply would overstate `r` and let a skim take principal. (The code uses max(`lp_supply`, mint supply) — identical today, and a guard if a PumpSwap layout change ever broke the `lp_supply` read.) At lock: `P = held₀ × ⌈√k₀⌉ ÷ L₀`, fixed forever.
- **Why √k per LP only grows:** swaps add the 0.20% LP fee to k; proportional deposits and withdrawals by other LPs keep `r` (PumpSwap rounds both in the pool's favour); donations add to it; sweeping v2 waiting fees doesn't move effective reserves. It is price-independent (a swap without fee leaves √k unchanged), so moving the price can't fake growth, and a proportional withdraw can't be sandwiched.
- **`skim` (permissionless):** `keep = ⌈P × L ÷ ⌊√k⌋⌉ + keep/2²⁰ + 1` (errs toward skimming less); withdraws `held − keep` LP if ≥ 0.001 LP (dust threshold) via PumpSwap `withdraw` (accounts passed through like the router; pool, user = locker PDA, mints, LP vault, both destinations and both pool vaults validated; results measured by balance deltas; LP burned must equal exactly the amount asked). Then it re-measures and **reverts unless the LP left is still worth ≥ P** (exact 256-bit comparison). Base tokens go to the coin's reward vault `["reward_vault", mint]`, WSOL to `ATA(["coin", mint], WSOL)` — both derived from the hard-coded FUMPAD program id and stored in `Lock` at lock time; the caller prepends an idempotent create of the WSOL ATA. ~75k CU.
- **`settle_lp_fees` (FUMPAD, permissionless):** closes `ATA(coin, WSOL)` to the caller, who forwards exactly the unwrapped SOL to the Coin (keeping the ATA's rent reserve — the same caller paid it in the skim, so a keeper doing skim + settle in one transaction nets zero), credited **60% platform / 40% creator**. Coin lamport invariant preserved. Emits `LpFeesSettled`. ~16k CU.
- **Nothing releases principal.** The vault's owner is the locker PDA; the only code that signs for it is the `withdraw` CPI in `skim`, for `held − keep` LP, followed by the principal check. If PumpSwap changes or disables `withdraw`, skims fail and the LP simply stays locked.
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
- **LP fees (D11), on ALL post-graduation PumpSwap volume** — FUMPAD router, Jupiter, bots, anyone: the locked LP earns PumpSwap's 0.20% LP fee (≈100% of the pool's LP). `skim` withdraws the growth at the pool's ratio (≈ half the value in tokens, half in SOL): tokens → reward pool; SOL → `settle_lp_fees` → 60% platform / 40% creator. By value ≈ **50 / 30 / 20**, the same split as the trading fee. The 60/40 is a constant (`LP_FEE_PLATFORM_SHARE_BPS`), not a param.

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
1. USD value of the **ticket's tokens** (the matured part of the sell, at the execution price) ≥ $50 (Pyth SOL/USD, staleness ≤ 60s, confidence ≤ 2%, valued at price − conf).
2. The seller is not the coin creator.
3. The sold tokens have been eligible for ≥10 min. Ticket amount = min(sold, aged eligible balance).
4. The wallet has fewer than 5 open tickets on this coin.

If any check fails, the sell still goes through, just without a ticket. **Pyth problems (missing, stale, wrong feed, uncertain) never block a sell** — they mean "no ticket".

Ticket fields: tokens, sell price (SOL/token, Q64 fixed point, see D10/D12 below), sell timestamp, status (`Open → Queued → Claimed | Expired | Voided`). The seller pays ~0.002 SOL rent, refunded when the ticket is closed. `Coin.tickets_created` counts tickets.

**Ticket price (D10 + D12).** `sell_price = max(execution, ⌈reference × execution ÷ pre_trade_spot⌉)` (`math/reference.rs::ticket_price_q64`; 256-bit intermediate, rounded up = protocol-favoring). *Execution* is the sell's price before FUMPAD's fee (after PumpSwap's fee on the router). *pre_trade_spot* is the spot that stood right before the sell: curve virtual reserves (curve), effective PumpSwap reserves = vault + `virtual_quote_reserves` (router); if it is unknown (degenerate pool) the floor is the reference itself (D10). *Reference* is the D10 average below, after this sell's touch point. The ratio `execution ÷ pre_trade_spot` is the sell's own slippage, so the floor is the fill an honest seller of the same size would have got at the reference:
- *Flat market* (reference = pre-trade spot): ticket = execution price, exactly, at any size. (D10 alone priced a big honest sell at the pre-sale spot, above its real fill.)
- *Staged crash* (another wallet dumps on the curve, or a direct PumpSwap dump, then the FUMPAD sell): the sell executes near the crashed pre-trade spot, ratio ≈ 1, so the floor stays ≈ the reference. A crash also makes the pool *deeper* in base, which makes any given sale's slippage smaller — crashing first only moves the ratio toward 1.
- *Pumping first* only raises the execution price; the floor never binds below it.
- *Self-impact round trip (capped, user decision):* an attacker holding inventory can sell a LARGE amount through FUMPAD and buy it back elsewhere in the same bundle; at sell time this is indistinguishable from an honest big exit. Uncapped D12 would price the ticket at reference × x/(x+S) (≈ ½ for S = the pool's whole base reserve, costing ≈ 1.85% of the sale). The floor's slippage credit is therefore capped at 10% (`MAX_SELF_IMPACT_DISCOUNT_BPS = 1_000`): the trick gains at most a 10% discount, and honest sellers whose own impact exceeds 10% get a floor of 90% of the reference instead of their fill. Test: `d12_self_impact_round_trip_discount_is_capped`.

The **reference** (`math/reference.rs`, 40 bytes of `Coin`) is a time-weighted average of spot with a 10-minute window, updated at every FUMPAD touch point: curve buy/sell, router swap, keeper sample (initialised to the start price at `create_coin`, carried unchanged through graduation). At a touch point at time t: first **fold** the interval since the previous touch point into the average, `avg += (v − avg)·w/600`, then **record** the spot right after the touch point as `last`. A spot observed at t therefore has zero weight at t, so a crash staged and undone inside one bundle (A dumps → B sells → A rebuys; or dump on PumpSwap → `swap_sell` → rebuy) cannot lower the reference.
- *Curve* (exact): only FUMPAD moves the curve, so `last` is exactly the price that stood: `v = last`, `w = min(dt, 600)`. Leaving a crashed curve price standing means anyone can buy the dumped tokens at the discount — it is then a real price.
- *PumpSwap* (router, samples): trades elsewhere are invisible, so `last` may be a spot an attacker staged right before the coin goes quiet (with a plain `α = min(1, dt/600)` the next touch after 10 idle minutes would adopt it wholesale). Hence `v = max(last, pre-trade spot)` — a staged spot only gets weight if the touch that closes its interval is staged too; any honest trade or keeper sample zeroes it — and `w = min(dt, 150)`, so one interval moves the average at most ¼ of the way however long the coin sat idle. Dragging the reference to 1/10 with a 20x staged crash then takes ≥11 back-to-back staged intervals (~28 min) with no other FUMPAD touch on the coin, each a fresh dump of ~3.5x the pool's base reserve. The keeper heartbeat (§5.4) closes such windows.
- Costs to honest users: in a decline the reference lags ~10 min (≈+17% in a −50%/hour slide); after a long idle period on PumpSwap it catches up over ~10–30 min of activity. Both err toward a higher ticket price, never a lower one. Pumps can only raise it (griefing, bounded the same way).
- The reference is deliberately upward-biased and is used **only** as this floor — never as a price for anything else.

**Rebuy rule.** A FUMPAD buy (or `register_holdings` increase) within 7 days of an open/queued ticket's sell debits that ticket's tokens by the amount rebought, newest ticket first, down to 0 (→ `Voided`). The client must pass every open ticket (≤5, listed in Position); the program enforces completeness. **Queued tickets stay in `position.open_tickets`** (they are still debited by rebuys; `process_queue` re-syncs or drops their queue entry) until paid, voided or closed.

**Claim.** `claim(ticket)` succeeds when:
- the coin has graduated
- now ≤ sell timestamp + 90 days
- oracle median ≥ 10 × sell price, with sample coverage met

Amount = 10% × ticket tokens. If amount ≤ 10% of the pool balance **and** no older fitting entry is waiting → paid in the same transaction. Otherwise → `Queued`.

**Queue (per coin, zero-copy PDA `["claim_queue", mint]`, sorted by sell timestamp, capacity 256).** ~20 KB, more than one instruction may allocate, so the permissionless, repeatable `init_claim_queue` grows it by ≤10 KiB per call (3 calls, one transaction) and writes the header only at full size. `process_queue` is a permissionless crank: it walks in order and pays every entry whose amount ≤ 10% of the current pool, skipping the rest (D4); a crank can't reorder it (an unverified fitting entry halts payment). Queued entries never expire (D5). If the queue is full, the claim reverts with "queue full" and the ticket stays `Open`.

### 5.4 Oracle (10x check)

- **Observations (per graduated coin, zero-copy ring, 256 slots):** `(ts, price_q64)` computed from PumpSwap reserves (effective quote = vault + `virtual_quote_reserves`). Canonical PDA `["observations", mint]` created with `init` by the permissionless `init_observations` (payer funds ~0.058 SOL), so there is exactly one ring per coin.
- `record_samples(groups[])` is signed by one of ≤3 registered keeper keys. Group = `[coin (mut, D10 touch point), observations (mut), pool, base vault, quote vault]`, ≤10 coins per call. A legacy transaction fits 5 coins; 6–10 need a v0 transaction with an address lookup table.
- **Rules:**
  - ≥10s between samples.
  - The sampling transaction must contain no other non-compute-budget instructions (instruction-sysvar check).
  - Claim requires ≥70% coverage: at least 84 of 120 expected samples in the last 30 min.
  - The **median** of those samples must be ≥ trigger.
- **Keeper policy (off-chain, required for liveness and safety):**
  - full rate (every 15 s) for coins whose spot is ≥50% of their lowest open trigger (claims need 84 of 120 samples in 30 min);
  - a **heartbeat sample every <10 min for every graduated coin with open tickets**, so the permissionless fallback stays closed and the D10 reference keeps getting honest touch points;
  - full rate for every graduated coin whose `buyback_lamports` exceeds a small threshold (e.g. 0.05 SOL) — `execute_buyback` needs a median — and **crank `execute_buyback`** for those coins (in ≤0.5%-of-depth slices), otherwise the pool's 50% fee share sits unspent.
- **Liveness fallback:** if a coin has no keeper sample for >10 min, `record_samples` becomes permissionless for that coin. The same rules apply, and fallback samples are flagged in the event log.

## 6. Admin & safety
- `Global.admin` = Squads multisig. Program upgrade authority = the same multisig.
- `fumpad_lp_locker`: **no** upgrade authority (removed right after deploy, `solana program set-upgrade-authority <id> --final`), no admin, no instruction besides `lock`/`skim`. Upgrading `fumpad` can't touch locked LP: the locker only ever pays FUMPAD-derived accounts and only fee growth.
- 48h timelock on fee/param changes.
- Pause flags: `pause_launch`, `pause_trade`, `pause_claims`. Pausing never blocks sells on graduated coins via PumpSwap directly.
- Every state change emits an Anchor event (`emit_cpi!`) — the indexer's sole source of truth.

## 7. Off-chain
- **Keeper (TS):** observation sampling, `process_queue`, `execute_buyback`, `graduate` cranks, and per graduated coin a periodic **create-ATA + `skim` + `settle_lp_fees`** in one transaction (936 bytes; skip when `NothingToSkim`). Runs on Railway, health alarms to Telegram.
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
- LiteSVM end-to-end on one real coin (`tests/src/e2e_tests.rs`): launch → curve trades → graduate (LP locked) → post-grad trades → sampling → claim / queue / buyback / crank → outside (non-FUMPAD) PumpSwap volume → skim → settle → fees → expiry. D10/D12 exploit scenarios: `tests/src/d10_tests.rs`. LP locker (third-party deposits/withdrawals/burns, big swaps both ways, donations, repeated skims, account substitution, lock gating, tx sizes): `tests/src/locker_tests.rs`; √k accounting property tests in the locker crate.
- Devnet end-to-end: the same flow against live PumpSwap and Pyth.
- An independent red-team agent reviews each module before it's marked done.
- **Simulation (Python):** agent-based model of pool solvency across volume and price paths and attacker mixes. Outputs: % of claims paid, time in queue, pool depletion, sensitivity to the 10x / 10% / 5% / fee parameters. No revenue projections.

## 9. Open questions
None open. Sells through other venues (Jupiter, etc.) never create tickets, as intended by the concept.
