# FUMPAD — Technical Spec v0.3

Status: v0.3 — matches the merged contracts (pre-audit fixes, D13–D16 implemented) · 2026-10-11 · Source concept: `concept-overview.pdf`

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
| D13 | **Escape hatch.** A coin stuck in `Complete` for **7 days** (graduation impossible, e.g. PumpSwap blocks `create_pool`) reopens curve sells so holders can exit. Details §3.2. |
| D14 | **Graduation fee hard cap: 1 SOL**, snapshotted into each coin at `create_coin` (no retroactive changes). Fee params likewise snapshotted per coin (`Coin.fees`); `fee_bps` capped at 200. Beta value stays 0. |
| D15 | **48h timelock** on all admin parameter changes (`queue_params` → `execute_params`, `cancel_params`). Pause flags stay immediate. Details §6.1. |
| D16 | **Max 2 claim-queue entries per wallet per coin**; payouts to accounts that refuse transfers go to a per-ticket escrow the owner withdraws later (`withdraw_escrow`), so such entries leave the queue. Details §5.3.1. |
| D17 | **Reward pool 8% of supply** (was 5%), keeping 10% claims and the 50/30/20 split; curve re-derived: virtual tokens ≈987.18M, ≈729.66M on the curve, ≈190.34M to the LP (§3). **Claim queue capacity 1024** (was 256). **Auto-claim:** a keeper may claim on a ticket owner's behalf (payout always to the owner, or escrow); on by default, owner can opt out. Source: `sim/REPORT.md` option C. |

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
- **Graduation:** anyone calls `graduate`, which creates the PumpSwap pool (index 0, creator = program PDA, coin_creator = default) with the **whole curve vault** (= `lp_supply`) + raised SOL minus the coin's **snapshotted** graduation fee (D14: `Coin.fees.graduation_fee_lamports`, ≤ 1 SOL, never the current global value), and **locks every LP token** in the immutable `fumpad_lp_locker` (D11, CPI `lock`; replaces the burn): the LP lands in a vault owned by the locker's PDA and a `Lock` account ["lock", pool] records the principal. Afterwards LP mint supply == the locker's balance. The raised SOL is wrapped in graduation's **own** WSOL account, PDA `["graduation_wsol", mint]`, created and closed inside `graduate` (never the pool authority's WSOL ATA, which is `execute_buyback`'s persistent account). The caller pays PumpSwap's account rent plus the Lock and LP-vault rent (~0.01 SOL net; 0.05 SOL is lent to the PDA and the unused part returned in the same instruction). ~270k CU (set a 400k compute budget); the transaction is ~1011 bytes.

### 3.1 LP locker (D11)

`programs/fumpad_lp_locker` — two instructions, no admin, no config, nothing closable, upgrade authority removed at deploy (CONTRACTS.md).

- **Principal in √k units.** The value of one LP token, as PumpSwap's `withdraw` pays it, is `r = √(base × quote) ÷ Pool.lp_supply` (base = base-vault balance; quote = min(vault + `virtual_quote_reserves`, vault − waiting protocol/creator fees), i.e. never more than real liquidity). `Pool.lp_supply` — not the LP mint supply — is the right denominator: `withdraw` divides by it, and it ignores direct burns, so a burned LP's share stays in the pool unclaimed; dividing by the (smaller) mint supply would overstate `r` and let a skim take principal. (The code uses max(`lp_supply`, mint supply) — identical today, and a guard if a PumpSwap layout change ever broke the `lp_supply` read.) At lock: `P = held₀ × ⌈√k₀⌉ ÷ L₀`, fixed forever.
- **Why √k per LP only grows:** swaps add the 0.20% LP fee to k; proportional deposits and withdrawals by other LPs keep `r` (PumpSwap rounds both in the pool's favour); donations add to it; sweeping v2 waiting fees doesn't move effective reserves. It is price-independent (a swap without fee leaves √k unchanged), so moving the price can't fake growth, and a proportional withdraw can't be sandwiched.
- **Fails closed on an unknown Pool layout:** `parse_pool` requires the account to be exactly `POOL_LEN` = 287 bytes (the IDL layout every FUMPAD pool is created with); any other size (e.g. PumpSwap reallocating pools for a new layout) → `UnknownPoolLayout`: `lock` (hence `graduate`; D13 covers that) and `skim` refuse and the principal stays locked.
- **`skim` (permissionless):** `keep = ⌈P × L ÷ ⌊√k⌋⌉ + keep/2²⁰ + 1` (errs toward skimming less); withdraws `held − keep` LP if ≥ 0.001 LP (dust threshold) via PumpSwap `withdraw` (accounts passed through like the router; pool, user = locker PDA, mints, LP vault, both destinations and both pool vaults validated; results measured by balance deltas; LP burned must equal exactly the amount asked). Then it re-measures and **reverts unless the LP left is still worth ≥ P** (exact 256-bit comparison). Base tokens go to the coin's reward vault `["reward_vault", mint]`, WSOL to `ATA(["coin", mint], WSOL)` — both derived from the hard-coded FUMPAD program id and stored in `Lock` at lock time; the caller prepends an idempotent create of the WSOL ATA. ~75k CU.
- **`settle_lp_fees` (FUMPAD, permissionless):** closes `ATA(coin, WSOL)` to the caller, who forwards exactly the unwrapped SOL to the Coin (keeping the ATA's rent reserve — the same caller paid it in the skim, so a keeper doing skim + settle in one transaction nets zero), credited **60% platform / 40% creator**. Coin lamport invariant preserved. Emits `LpFeesSettled`. ~16k CU.
- **Nothing releases principal.** The vault's owner is the locker PDA; the only code that signs for it is the `withdraw` CPI in `skim`, for `held − keep` LP, followed by the principal check. If PumpSwap changes or disables `withdraw`, skims fail and the LP simply stays locked.
- Math in u128, rounding always in the protocol's favor. Property tests: k never decreases, no free tokens, sum of balances conserved.

### 3.2 Escape hatch (D13)

A coin that has been `Complete` for `ESCAPE_HATCH_SECS` = 7 days (a constant, not a param) reopens on the next curve `sell`: the sell sets `status = Curve`, `completed_at = 0`, emits `CurveReopened`, and then executes as an ordinary curve sell (fee, inline buyback, ticket rules unchanged). Design choice — *back to `Curve`* rather than a separate exit mode:
- A Complete coin's reserves are exactly a curve with `real_token = 0`, so curve accounting needs nothing new: sells refund along the curve, and buys work again afterwards.
- `graduate` still requires `Complete`, which a reopened coin only reaches again when buys exhaust the curve (fresh `completed_at`, fresh 7-day clock). The pool is therefore always created at the curve's final price with `lp_supply` tokens — the price-continuity invariant holds; there is no "graduate a half-unwound curve" path.
- Tickets: reopened-curve sells create tickets as usual; they become claimable only if the coin graduates (D1).
- Residuals: pool-share lamports that accrued to `buyback_lamports` while the coin was Complete stay there until graduation. Someone can re-complete a reopened curve by buying it out (restarting the 7 days) — at the full curve price, which pays the exiting holders.

## 4. Fees (1% of SOL side, every FUMPAD trade, pre- and post-graduation)

| Share | Destination |
|---|---|
| 50% | Pool buyback → coin's reward pool vault |
| 30% | Platform fee vault |
| 20% | Creator fee vault (claimable by creator at any time, unconditional) |

- **Pre-graduation buyback:** inline. The program buys from its own curve into the pool vault within the same instruction.
- **Post-graduation buyback:** SOL accrues in the coin's buyback vault; a permissionless `execute_buyback` crank swaps it on PumpSwap only when spot is within ±3% of the 30-min median (blocks sandwich setups), in slices ≤ 0.5% of pool depth.
- Fee bps and split (and the graduation fee) are global params (admin, 48h timelock, D15), **snapshotted into each coin at `create_coin`** (`Coin.fees`, D14): a change only applies to coins launched after it. Hard caps in `Params::is_valid`: `fee_bps ≤ 200`, `graduation_fee_lamports ≤ 1 SOL`.
- **LP fees (D11), on ALL post-graduation PumpSwap volume** — FUMPAD router, Jupiter, bots, anyone: the locked LP earns PumpSwap's 0.20% LP fee (≈100% of the pool's LP). `skim` withdraws the growth at the pool's ratio (≈ half the value in tokens, half in SOL): tokens → reward pool; SOL → `settle_lp_fees` → 60% platform / 40% creator. By value ≈ **50 / 30 / 20**, the same split as the trading fee. The 60/40 is a constant (`LP_FEE_PLATFORM_SHARE_BPS`), not a param.

## 5. Modules

### 5.1 Curve
`create_coin(name, symbol, uri)` · `buy(sol_in, min_tokens_out)` · `sell(tokens_in, min_sol_out)` · `graduate()`. `sell` is also the D13 escape hatch (§3.2).

### 5.2 Router (post-graduation)
`swap_buy(sol_in, min_out)` / `swap_sell(tokens_in, min_out)` CPI into PumpSwap. Both use the user's **canonical Token-2022 ATA** (like the curve), because eligibility is capped by the balance FUMPAD observes there.
- **Upgrade tolerance:** PumpSwap accounts are passed through `remaining_accounts`; the router validates only what matters (program ID, pool == `coin.amm_pool`, user token accounts, mints) and measures **balance deltas** before/after rather than trusting any return layout. A PumpSwap account-list change then needs a client update, not a program upgrade.
- WSOL wrap/unwrap is handled in the client transaction.

### 5.3 Rewards

**Position** `(wallet, mint)`: eligible balance + timestamp of last increase, list of open ticket keys (≤5), rebuy window.
- Increased by FUMPAD buys, or by `register_holdings` (snapshots the wallet's current balance; lets people who bought elsewhere become eligible). Either way the 10-min hold clock restarts for the added amount.
- **Observed balance (v0.3).** `Position.last_balance` is the canonical-ATA balance at FUMPAD's last observation (after a FUMPAD buy/sell, at `register_holdings`). At the next observation:
  - balance **below** it → tokens left unseen: the tracked amount is capped to the balance, from `matured` first (buys now apply this cap too);
  - balance **above** it → tokens arrived unseen (transfer, other venue): they are **untracked and a sell draws on them first**, so fresh tokens can't ride on matured credit ("buy elsewhere / receive → dump through FUMPAD" gets no ticket). An honest holder who received tokens elsewhere can `register_holdings` first (counts as a rebuy).
  - **Residual (cannot be closed on-chain):** FUMPAD only sees the balance at its own touch points. If matured tokens leave unseen and are replaced by *at most as many* fresh tokens before the next touch, the wallet's balance looks unchanged and the old credit still applies (test `regression_unseen_arrivals_cannot_ride_matured_credit`, part 2). It is bounded: the credit required really holding that many tokens for 10 minutes in that wallet, each credit is consumed by the sell it backs, and copying it to another wallet needs that wallet's own `register_holdings` + 10 minutes.

**Sell → ticket.** A sell creates a `Ticket` when all of these hold:
1. USD value of the **ticket's tokens** (the matured part of the sell, at the execution price) ≥ $50 (Pyth SOL/USD, staleness ≤ 60s, confidence ≤ 2%, valued at price − conf).
2. The seller is not the coin creator.
3. The sold tokens have been eligible for ≥10 min. Ticket amount = min(sold, aged eligible balance).
4. The wallet has fewer than 5 open tickets on this coin.

If any check fails, the sell still goes through, just without a ticket. **Pyth problems (missing, stale, wrong feed, uncertain) never block a sell** — they mean "no ticket".

Ticket fields: tokens, sell price (SOL/token, Q64 fixed point, see D10/D12 below), sell timestamp, status (`Open → Queued → Claimed | Escrowed → Claimed | Expired | Voided`). The seller pays ~0.002 SOL rent, refunded when the ticket is closed. `Coin.tickets_created` counts tickets.

**Ticket price (D10 + D12).** `sell_price = max(execution, ⌈reference × execution ÷ pre_trade_spot⌉)` (`math/reference.rs::ticket_price_q64`; 256-bit intermediate, rounded up = protocol-favoring). *Execution* is the sell's price before FUMPAD's fee (after PumpSwap's fee on the router). *pre_trade_spot* is the spot that stood right before the sell: curve virtual reserves (curve), effective PumpSwap reserves = vault + `virtual_quote_reserves` (router); if it is unknown (degenerate pool) the floor is the reference itself (D10). *Reference* is the D10 average below, after this sell's touch point. The ratio `execution ÷ pre_trade_spot` is the sell's own slippage, so the floor is the fill an honest seller of the same size would have got at the reference:
- *Flat market* (reference = pre-trade spot): ticket = execution price, exactly, at any size. (D10 alone priced a big honest sell at the pre-sale spot, above its real fill.)
- *Staged crash* (another wallet dumps on the curve, or a direct PumpSwap dump, then the FUMPAD sell): the sell executes near the crashed pre-trade spot, ratio ≈ 1, so the floor stays ≈ the reference. A crash also makes the pool *deeper* in base, which makes any given sale's slippage smaller — crashing first only moves the ratio toward 1.
- *Pumping first* only raises the execution price; the floor never binds below it.
- *Self-impact round trip (capped, user decision):* an attacker holding inventory can sell a LARGE amount through FUMPAD and buy it back elsewhere in the same bundle; at sell time this is indistinguishable from an honest big exit. Uncapped D12 would price the ticket at reference × x/(x+S) (≈ ½ for S = the pool's whole base reserve, costing ≈ 1.85% of the sale). The floor's slippage credit is therefore capped at 10% (`MAX_SELF_IMPACT_DISCOUNT_BPS = 1_000`): the trick gains at most a 10% discount, and honest sellers whose own impact exceeds 10% get a floor of 90% of the reference instead of their fill. Test: `d12_self_impact_round_trip_discount_is_capped`.

The **reference** (`math/reference.rs`, 40 bytes of `Coin`) is a time-weighted average of spot with a 10-minute window, updated at every FUMPAD touch point: curve buy/sell, router swap, keeper sample (initialised to the start price at `create_coin`, carried unchanged through graduation). At a touch point at time t: first **fold** the interval since the previous touch point into the average, `avg += (v − avg)·w/600`, then **record** the spot right after the touch point as `last`. A spot observed at t therefore has zero weight at t, so a crash staged and undone inside one bundle (A dumps → B sells → A rebuys; or dump on PumpSwap → `swap_sell` → rebuy) cannot lower the reference.
- *Curve* (exact): only FUMPAD moves the curve, so `last` is exactly the price that stood: `v = last`, `w = min(dt, 600)`. Leaving a crashed curve price standing means anyone can buy the dumped tokens at the discount — it is then a real price.
- *PumpSwap* (router, samples): trades elsewhere are invisible, so `last` may be a spot an attacker staged right before the coin goes quiet (with a plain `α = min(1, dt/600)` the next touch after 10 idle minutes would adopt it wholesale). Hence `v = max(last, pre-trade spot)` — a staged spot only gets weight if the touch that closes its interval is staged too; any honest trade or keeper sample zeroes it — and `w = min(dt, 150)`, so one interval moves the average at most ¼ of the way however long the coin sat idle. Dragging the reference to 1/10 with a 20x staged crash then takes ≥11 back-to-back staged intervals (~28 min) with no other FUMPAD touch on the coin, each a fresh dump of ~3.5x the pool's base reserve. The keeper heartbeat (§5.4) closes such windows.
- *Keeper samples (v0.3, V-opt):* when the keeper's **own** observation is an upward move (`pre ≥ last` and `≥ avg`), it is folded with the full elapsed weight `w = min(dt, 600)` — it only raises the floor, so a heartbeat after an idle period refreshes the reference to a genuine rise at once. Downward moves and any value carried in `last` stay capped at 150 s. (Deliberately not extended to router swaps: a swap's pre-trade spot or post-spot can be a staged pump, and uncapping it would let one cheap pump bundle drag every honest ticket's floor up to the pumped price.)
- *Fallback samples (v0.3, V-M2):* permissionless samples are **raise-only** touch points: `avg ← max(avg, folded)` and `last ← max(last, sample)`. They can't lower the reference, so the "[dump → fallback sample → rebuy] every 150 s" drag on a coin without keeper heartbeats no longer works (`regression_fallback_samples_cannot_drag_reference`).
- Costs to honest users: in a decline the reference lags ~10 min (≈+17% in a −50%/hour slide); after a long idle period on PumpSwap it catches up over ~10–30 min of activity. Both err toward a higher ticket price, never a lower one. Pumps can only raise it (griefing, bounded the same way).
- The reference is deliberately upward-biased and is used **only** as this floor — never as a price for anything else.

**Rebuy rule.** A FUMPAD buy (or `register_holdings` increase) within 7 days of an open/queued ticket's sell debits that ticket's tokens by the amount rebought, newest ticket first, down to 0 (→ `Voided`). The client must pass every open ticket (≤5, listed in Position); the program enforces completeness. **Queued tickets stay in `position.open_tickets`** (they are still debited by rebuys) until paid, escrowed, voided or closed. When one of the open tickets is `Queued`, the client must also pass the coin's ClaimQueue right after them (`QueueAccountRequired` otherwise): the rebuy **updates the queue entry in the same instruction** (amount lowered, or the entry removed when the ticket is voided), so queue amounts and order are always exact (`process_queue` keeps a defensive re-sync).

**Claim.** `claim(ticket)` succeeds when:
- the coin has graduated
- now ≤ sell timestamp + 90 days
- oracle median ≥ 10 × sell price, with sample coverage met

Amount = 10% × ticket tokens. If amount ≤ 10% of the pool balance **and** no older fitting entry is waiting → paid in the same transaction. Otherwise → `Queued`, unless the wallet already has **2 entries** in this coin's queue (D16, `MAX_QUEUED_PER_WALLET`): the claim then reverts with `WalletQueueLimit` and the ticket stays `Open` (retry once an entry is paid). Every entry counted as "older fitting" can currently be paid by the crank: amounts are exact (rebuy rule above), entries exist only for `Queued` tickets, and a refusing destination is escrowed (§5.3.1) rather than skipped.

**Queue (per coin, zero-copy PDA `["claim_queue", mint]`, sorted by sell timestamp, capacity 256).** ~20 KB, more than one instruction may allocate, so the permissionless, repeatable `init_claim_queue` grows it by ≤10 KiB per call (3 calls, one transaction) and writes the header only at full size. `process_queue` is a permissionless crank: it walks in order and pays every entry whose amount ≤ 10% of the current pool, skipping the rest (D4); a crank can't reorder it (an entry that fits but whose accounts weren't passed halts payment). Queued entries never expire (D5). If the queue is full, the claim reverts with "queue full" and the ticket stays `Open`. Per call the crank takes `[ticket, position, owner ATA, escrow PDA]` per entry (13 entries fit a legacy transaction's 64 account locks; ~245k CU paying, ~323k CU escrowing, on a full queue — set a compute budget).

#### 5.3.1 Escrow (D16)
If the owner's canonical ATA can't receive a plain transfer when the crank pays the entry — incoming-transfer **memo required**, frozen, or **missing/closed** — the payout goes into the ticket's escrow token account, PDA `["escrow", ticket]` (Token-2022, authority = pool authority, created by the crank; the cranker pays its rent and is recorded in `Ticket.escrow_payer`). The ticket becomes `Escrowed`, leaves the open list, and the entry leaves the queue — such an entry can no longer block the queue or force newer claims to wait (the v0.2 behaviour of skipping it forever let ~256 cheap entries fill the queue for good). The owner calls `withdraw_escrow` to move the tokens to any token account they own for the mint; the escrow is closed, its rent refunded to `escrow_payer`, and the ticket becomes `Claimed` (then closable). `Escrowed` tickets can't be closed. Keepers should create missing ATAs (idempotent) before cranking to save owners the extra step.

### 5.4 Oracle (10x check)

- **Observations (per graduated coin, zero-copy ring, 256 slots):** `(ts, price_q64)` computed from PumpSwap reserves (effective quote = vault + `virtual_quote_reserves`). Canonical PDA `["observations", mint]` created with `init` by the permissionless `init_observations` (payer funds ~0.058 SOL), so there is exactly one ring per coin.
- `record_samples(groups[])` is signed by one of ≤3 registered keeper keys. Group = `[coin (mut, D10 touch point), observations (mut), pool, base vault, quote vault]`, ≤10 coins per call. A legacy transaction fits 5 coins; 6–10 need a v0 transaction with an address lookup table.
- **Rules:**
  - Spacing ≥10 s: a **keeper** sample vs the coin's previous *keeper* sample (a fallback sampler squatting every slot can't lock the keeper out — a keeper sample may land next to recent fallback ones, and then closes the fallback path); a **fallback** sample vs the previous sample of any kind.
  - The sampling transaction must contain no other non-compute-budget instructions (instruction-sysvar check).
  - **Only keeper samples count** for the claim median and coverage, and for `execute_buyback`'s median (V-M1). Fallback samples are a liveness signal (events, ring) and raise-only D10 touch points; during a keeper outage claims and buybacks pause with `InsufficientSamples`.
  - Coverage (claims and buybacks): ≥ 84 keeper samples in the last 30 min (70% of 120 expected @15 s) **and** keeper samples present in ≥ 5 of the window's 6 five-minute buckets (time spread, V-L2) — 84 samples bunched into 14 minutes no longer make a "30-minute" median.
  - The **median** of those samples must be ≥ trigger.
- **Keeper policy (off-chain, required for liveness and safety):**
  - full rate (every 15 s) for coins whose spot is ≥50% of their lowest open trigger (claims need 84 keeper samples spread over ≥5 of the six 5-minute buckets of the last 30 min, i.e. start full rate ≥ ~25 min before a claim is expected);
  - a **heartbeat sample every <10 min for EVERY graduated coin** (batched, ≤10 coins per `record_samples`, v0 transaction + lookup table for 6–10), not only coins with open tickets: it keeps the permissionless fallback closed and gives the D10 reference honest touch points on every coin before a ticket exists;
  - full rate for every graduated coin whose `buyback_lamports` exceeds a small threshold (e.g. 0.05 SOL) — `execute_buyback` needs a median — and **crank `execute_buyback`** for those coins (in ≤0.5%-of-depth slices), otherwise the pool's 50% fee share sits unspent;
  - before `process_queue`, create missing owner ATAs (idempotent) so payouts land directly instead of in escrow.
- **Liveness fallback:** if a coin has no keeper sample for >10 min, `record_samples` becomes permissionless for that coin. Fallback samples are flagged (`SampleRecorded.fallback`, `Observation.fallback`) and never decide a median (above).

## 6. Admin & safety
- `Global.admin` = Squads multisig. Program upgrade authority = the same multisig.
- `fumpad_lp_locker`: **no** upgrade authority (removed right after deploy, `solana program set-upgrade-authority <id> --final`), no admin, no instruction besides `lock`/`skim`. Upgrading `fumpad` can't touch locked LP: the locker only ever pays FUMPAD-derived accounts and only fee growth.
- 48h timelock on every `Params` change (§6.1). No direct `update_params`.
- Pause flags: `pause_launch`, `pause_trade`, `pause_claims` — immediate (`set_pause`). Pausing never blocks sells on graduated coins via PumpSwap directly. `pause_claims` also pauses `process_queue` and `withdraw_escrow`.

### 6.1 Params timelock (D15)
- `queue_params(params)` (admin): validates (`Params::is_valid`, incl. the D14 caps), stores `Global.pending_params` and `Global.pending_eta = now + 48h`; queuing again replaces the pending change and restarts the clock. Event `ParamsQueued { params, eta }`.
- `execute_params()` (**permissionless** — the change was approved when queued): requires a pending change and `now ≥ pending_eta`, re-validates, applies, clears. Event `ParamsUpdated`.
- `cancel_params()` (admin): clears the pending change. Event `ParamsCancelled`.
- Storage: `pending_params` + `pending_eta` are **appended to `Global`** (they don't fit the 128 reserved bytes): Global grew from 481 to 672 bytes. A Global initialized by an earlier build must be re-created (devnet redeploy); there is no mainnet deployment to migrate.
- Not timelocked (not `Params`): `set_pause` (emergency), `set_keepers` (key rotation is incident response; keepers can't move funds — they only trigger samples of on-chain reserves), `set_admin` / treasury. Fee params are also snapshotted per coin (D14), so even an executed change is never retroactive for fees.
- Every state change emits an Anchor event (`emit_cpi!`) — the indexer's sole source of truth.

## 7. Off-chain
- **Keeper (TS):** observation sampling (heartbeat every graduated coin <10 min, §5.4), `process_queue` (create missing ATAs first), `execute_buyback`, `graduate` cranks, `execute_params` once a queued change's 48h elapsed, and per graduated coin a periodic **create-ATA + `skim` + `settle_lp_fees`** in one transaction (936 bytes; skip when `NothingToSkim`). Runs on Railway, health alarms to Telegram.
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
- Pre-audit findings: each fixed issue keeps its original attack scenario as a `regression_*` test asserting the attack now fails (`tests/src/review_rewards.rs`, `review_venue.rs`, `redteam_custody.rs`); worst-case CU in `tests/src/cu_report.rs`.
- LiteSVM end-to-end on one real coin (`tests/src/e2e_tests.rs`): launch → curve trades → graduate (LP locked) → post-grad trades → sampling → claim / queue / buyback / crank → outside (non-FUMPAD) PumpSwap volume → skim → settle → fees → expiry. D10/D12 exploit scenarios: `tests/src/d10_tests.rs`. LP locker (third-party deposits/withdrawals/burns, big swaps both ways, donations, repeated skims, account substitution, lock gating, tx sizes): `tests/src/locker_tests.rs`; √k accounting property tests in the locker crate.
- Devnet end-to-end: the same flow against live PumpSwap and Pyth.
- An independent red-team agent reviews each module before it's marked done.
- **Simulation (Python):** agent-based model of pool solvency across volume and price paths and attacker mixes. Outputs: % of claims paid, time in queue, pool depletion, sensitivity to the 10x / 10% / 5% / fee parameters. No revenue projections.

## 9. Open questions
None open. Sells through other venues (Jupiter, etc.) never create tickets, as intended by the concept.

## 10. Changelog
- **v0.3** (2026-10-11) — pre-audit fixes; D13–D16 implemented: escape hatch after 7 days `Complete` (§3.2); per-coin fee snapshot + caps (1 SOL graduation fee, 200 bps) and 48h params timelock (`queue_params` / `execute_params` / `cancel_params`, §6.1); per-ticket escrow for refusing destinations (`withdraw_escrow`) and max 2 queue entries per wallet per coin (§5.3.1); rebuys update queue entries in place; `Position.last_balance` (unseen arrivals sold first, residual documented §5.3); router sells require the canonical ATA; graduation uses its own WSOL PDA; locker fails closed on unknown Pool layouts; oracle: keeper-only median with 5-of-6-bucket time coverage, raise-only fallback samples, keeper spacing vs keeper samples only, uncapped upward keeper folds; keeper heartbeats every graduated coin.
- **v0.2** — contracts merged (curve, router, rewards, oracle, D10–D12 reference floor, D11 LP locker).
- **v0.1** — initial spec.
