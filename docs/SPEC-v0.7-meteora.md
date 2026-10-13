# FUMPAD — Technical Spec v0.7 (Meteora)

Status: **APPROVED by user 2026-10-13 (incl. D31 one attested-ticket model)** · 2026-10-13 · Supersedes the venue/curve parts of `SPEC.md` v0.6 (§3, §3.1, §3.2, §4, §4.1, §5.1, §5.2, parts of §5.3/§5.4/§6). Everything not mentioned here keeps its v0.6 meaning (D1–D6, D9, D15–D18, D23–D26, D29).
Evidence: `spike/meteora/REPORT.md` (devnet spike, 11/12 PASS), `services/meteora/ATTESTATION.md` (trade parser + keeper rules), on-chain census of hook vs plain DBC coins (Axiom shows no warning for plain DBC coins — user-verified 2026-10-13).

## 0. New decisions

| # | Decision |
|---|---|
| D30 | **Meteora DBC + DAMM v2 replace our curve, PumpSwap and the LP locker.** Every coin launches as a **plain** (no transfer hook) Token-2022 DBC pool on a FUMPAD config and graduates to DAMM v2. Coins are tradable on any app from launch (Axiom, Jupiter, GMGN, Photon, bots). Supersedes D7, D11, D13, D21, D22, D27, D28. |
| D31 | **Tickets for every qualifying sell, on any app, before and after graduation**, created by **2-of-3 keeper attestations** (user decision "B"). See §5. |
| D32 | **Trading fee 1.25%** (Meteora keeps 20% → FUMPAD nets 1.00% on all volume, any app), collected in SOL, split **50 buyback / 30 platform / 20 creator** by our program. DBC creator fee share = 0; the creator's 20% is paid by our split. Same 1.25% (`OnlyB`) on the DAMM v2 pool after graduation. |
| D33 | **Snipe protection = DBC fee scheduler**: 99% → 1.25% linear over 8 slots (~3 s), applies to buys **and** sells in the window. **Our whole share of each coin's launch-window fees goes to that coin's reward pool** (replaces D19's "tax to pool"; §3.3). The cheap first swap in the launch tx (DBC `enable_first_swap_with_min_fee`) is the creator's buy, enforced by our backend building the launch tx (D18). |
| D34 | **Graduation setup funded by DBC's migration fee** (replaces D20): ~0.75% of the raise (≈0.64 SOL at 85 SOL) to the partner (us) at graduation, spent on the claim-queue + observations rent like D20; remainder → platform. |
| D35 | **Reward pool = DBC fixed-supply leftover**: exactly 8% of supply lands in `ATA(PDA["reward_pool"], mint)` at graduation (`withdraw_leftover`). Before graduation the vault holds only buybacks. |
| D36 | **LP = DAMM v2 position NFT owned by `PDA["fee_claimer"]`, 100% permanently locked** (Meteora's lock; replaces our immutable locker). LP fees claimed by our program and split 50/30/20. |
| D37 | **Build against mainnet program versions** (DBC 0.2.1: `create_config`, `EvtSwap`/`EvtSwap2`; DAMM v2 0.2.4). Feature-detect DBC 0.2.2 (`create_config2`, `EvtSwap3`) but never require it. LiteSVM tests run on the **mainnet** binaries + mainnet configs. |
| D38 | **Risk acceptance (user, 2026-10-13):** Meteora's single upgrade authority (multisig unverified) can change DBC/DAMM v2; DAMM v2 operators can disable a pool's trading or change its fee; Meteora takes 20% of fees and 0.2% at graduation. Disclosed on `/risk`. |
| D39 | **Fresh layouts.** Mainnet isn't deployed, so v0.7 uses new account layouts and a new program id; devnet gets a fresh deploy and a new Global. No v0.6 → v0.7 data migration. `migrate_global` keeps only the mechanism for future layouts. |

## 1. Architecture

```
 any app (Axiom, Jupiter, bots…) ──swap──►  Meteora DBC (curve) ──migrate──► Meteora DAMM v2 (pool)
 FUMPAD app ──► fumpad router (CPI swap2) ──┘          ▲ partner fees, leftover        ▲ LP NFT (100% locked), LP fees
                                                       │                                │
                           fumpad program: coins · fees/buyback · tickets (attested) · claims/queue · oracle samples
                                                       ▲ 2-of-3 Ed25519 attestations
                 keepers ×3 (own keys, own RPCs, @fumpad/meteora parser) ◄── chain data (all venues)
```

PDAs (program-wide, seeds fixed): `global`, `fee_claimer` (DBC config fee_claimer + LP NFT owner), `reward_pool` (DBC leftover_receiver; vault = its Token-2022 ATA per mint), `buyback` (swap payer for buybacks), `coin[mint]`, `position[mint, wallet]`, `ticket[mint, wallet, seq]`, `consumed[sig_hash, ix_key]`, `claim_queue[mint]`, `observations[mint]`, `escrow[ticket]`.

## 2. Token, config, launch

- **DBC config (one per parameter version = the D14 snapshot):** created by admin via `create_config` (mainnet) with: quote WSOL; Token-2022 base, 6 decimals, `TokenAuthorityOption::Immutable` (mint/freeze/metadata authority None after init); fixed supply 1B, leftover 80M (8%); curve from the SDK builder reproducing D17 (start MC ≈30.39 SOL, graduation at **85 SOL** raised on mainnet, ×14.7 price ratio; devnet scaled to 0.85 SOL); `activation_type` slot; fee scheduler 99% → 1.25% over 8 × 1 slot; `collect_fee_mode` quote; `creator_trading_fee_percentage` 0; `enable_first_swap_with_min_fee` 1; migration DAMM v2, `migrationFeeOption` Customizable, migrated pool fee 125 bps `OnlyB`; partner permanent locked liquidity 100%; migration fee per D34 (partner 100%); `fee_claimer` = PDA `fee_claimer`, `leftover_receiver` = PDA `reward_pool`. Re-derive the curve so the 8% leftover stays exact **with** the migration fee (verify on LiteSVM).
- `Global.configs`: allow-list of FUMPAD DBC config keys (admin, timelocked like params). A coin is FUMPAD's iff its DBC pool's config is in this list at `register_coin`.
- **Launch tx (built + mint-co-signed by the API, D18):** `initialize_virtual_pool_with_token2022` (vanity `…fmbL` mint signs) → creator `swap2` **top-level** (gets the min fee; never routed) → `fumpad.register_coin(mint)`. `register_coin`: pool's config ∈ allow-list, pool base mint == mint, creator == signer == pool creator; records `Coin { mint, dbc_pool, config, creator, launch_slot, status = Curve, fees/reward snapshot }`. Pause flag `PAUSE_LAUNCH`.
- Coins never registered (e.g. someone else using our config) are ignored by keepers and the app. (Our config's fees still accrue to us — harmless.)

## 3. Trading, fees, buyback

### 3.1 Router (`buy`, `sell`)
`buy(amount_in, min_out, mode)` / `sell(amount_in, min_out)`: CPI DBC `swap2` while `Coin.status == Curve`, DAMM v2 `swap2` once `Graduated`. Accounts via `remaining_accounts` (spike pattern): validate program id, discriminator, pool == coin's pool, user owns the canonical Token-2022 ATA + WSOL account; measure balance deltas; emit `RoutedTrade { mint, trader, side, base, quote_gross, fee, pre_sqrt_price, post_sqrt_price, slot }`. Buys that may complete the curve use **PartialFill** (DBC reverts on overshoot). `PAUSE_TRADE` stops router buys only; router sells are never paused (users can always sell on Meteora directly anyway). No extra router fee (D32 fee already applies to every trade). Router trades are ordinary trades for tickets: they're attested like any other sell (§5) — the router exists for UX (one-click, Privy silent signing allow-list) and exact events.

### 3.2 `claim_fees(mint)` (permissionless)
CPI DBC `claim_trading_fee` (and after graduation DAMM `claim_position_fee`) signed by `fee_claimer`; measure the WSOL delta; split 50% → coin's buyback balance, 30% → platform, 20% → creator balance (per-coin accounting in `Coin`, lamports or WSOL — implementer's choice, keep the Coin lamport/WSOL invariant testable). Also claims the partner migration fee + surplus at graduation (§4).

### 3.3 Launch-window fees → reward pool (D33)
`Coin.launch_fees_settled = false` at register. The **first** `claim_fees` for a coin, only allowed once `slot ≥ launch_slot + 8`, sends **100%** of what it claims to the buyback balance (everything accrued so far = the snipe window plus a few normal slots; the overshoot only ever favors the reward pool), then sets the flag. Keeper calls it right after the window. Later claims split normally.

### 3.4 `execute_buyback(mint, max_in)`
Swap from the coin's buyback balance with `PDA["buyback"]` as payer, output to the reward vault. Post-graduation: v0.6 rules (permissionless, spot within ±3% of the 30-min keeper median, slice ≤ 0.5% of pool depth). Pre-graduation (no median yet): **keeper-only**, slice ≤ 0.5% of the curve's quote reserve, and spot (DBC `sqrt_price`) within ±3% of the coin's most recent keeper sample ≤ 60 s old AND of the median of its recent keeper samples (Clarifications 24). Buybacks never complete the curve (cap the slice to stay below the migration threshold).

## 4. Graduation
DBC completes when the quote threshold is reached; anyone (Meteora's mainnet keepers, our keeper, or `fumpad.graduate`) calls `migration_damm_v2`. `graduate(mint)` (permissionless, idempotent per step):
1. If the DBC pool isn't migrated yet: CPI `migration_damm_v2` (caller pays Meteora's ~0.0165 SOL flash-rent refund; reimbursed from the migration fee).
2. Verify and record the DAMM v2 pool (PDA from the migration config + mint + WSOL) and the position (owner = `fee_claimer`, 100% permanently locked, pool matches) → `Coin.damm_pool`, `Coin.position`, `status = Graduated`.
3. `withdraw_leftover` (tolerate "already withdrawn"), claim partner migration fee + surplus.
4. Spend the migration fee per D20 order: caller refund (measured) → pre-fund `observations` + `claim_queue` PDAs → remainder platform.
`PAUSE_GRADUATE` blocks only our `graduate` bookkeeping, never Meteora's migration. Status `Complete` (curve done, not migrated) is observable; tickets keep being attested from DBC trades that happened before completion.

## 5. Tickets by attestation (D31)

### 5.1 One ticket model for all sells
Every ticket — FUMPAD-routed or outside — is created by `attest_sell`. Eligibility (≥ $50, ≥ 10-min hold, not the creator, ≤ 5 open per wallet/coin, rebuy rule, D10/D12 floor) is computed **off-chain by each keeper from the complete chain history** (all venues + wallet transfers), deterministically, and attested. Rationale: most buys now happen outside FUMPAD, so the on-chain Position could never see them (v0.6's `last_balance` model would deny almost every honest ticket); a single deterministic engine is simpler, auditable and identical for every app. `register_holdings` and on-chain hold/rebuy bookkeeping are removed.

### 5.2 `attest_sell(record, keeper_sigs)`
Message (fixed-width LE, Ed25519): `"FUMPAD-SELL-v1" ‖ program_id ‖ cluster_tag ‖ mint ‖ pool ‖ venue ‖ signature(64) ‖ ix_key(u32) ‖ trader ‖ base_amount ‖ quote_gross ‖ ticket_tokens ‖ ticket_price_q64(u128) ‖ usd_cents ‖ pyth_publish_time ‖ slot ‖ block_time`. On-chain checks:
- 2 **distinct** keys of `Global.keepers` (3 max) signed exactly these bytes — verified by Ed25519-program instruction introspection in the same tx.
- `consumed[sha256(signature), ix_key]` doesn't exist → create it (rent from the attesting keeper; never closable while its ticket lives, closable after).
- `mint` is a registered coin; `pool` == `Coin.dbc_pool` or `Coin.damm_pool` (third-party pools never count).
- `trader != Coin.creator`; `usd_cents ≥ min_sell_usd_cents`; `ticket_tokens ≤ base_amount`; `block_time ≥ launch` and `now − block_time ≤ max_attest_age` (default 24 h).
- Per-coin rate cap: attested `ticket_tokens` per rolling hour ≤ `max_attest_tokens_per_hour_bps` of supply (default 2,000 = 20%; excess → retry later, never lost).
- Wallet ≤ `max_open_tickets` open tickets on the coin (Position keeps the list + counters + auto-claim opt-out).
Creates `Ticket { owner = trader, tokens = ticket_tokens, sell_price_q64, sell_ts = block_time, source: Router | Outside, attested_at, rent_payer = keeper }`. Event `TicketAttested` (all fields + both keeper keys).

### 5.3 Rebuy debits, voids, challenge window
- `attest_rebuy(ticket, debit_tokens, signature, ix_key)` — same 2-of-3 + consumed-key scheme: an outside or routed buy (or incoming transfer, per the engine's rule) within 7 days debits the ticket (→ `Voided` at 0; updates the queue entry like v0.6).
- **Challenge window:** a ticket is claimable only after `attested_at + ticket_challenge_secs` (default 6 h, bounds 1–48 h). `void_ticket(ticket, reason)` — guardian (or admin) only, within the window — voids a bad attestation. A public, independent **watcher** re-derives every attestation and alerts (Telegram) on any mismatch so the guardian can act.
- Claims, auto-claim, queue (1024, skip-ahead, 2 per wallet), escrow: unchanged from v0.6, paying from `ATA(reward_pool, mint)`. Ticket rent is the keeper's; `close_ticket` (permissionless once terminal) refunds `rent_payer`.

### 5.4 Deterministic off-chain engine (keepers + watcher, `services/`)
Inputs: finalized txs only; `@fumpad/meteora` records (§ATTESTATION.md rules: event authority, CPI parent, vault-delta cross-check, strong trader attribution, refuse `base_owner_unsigned`); wallet transfers of the mint. Total order: (slot, tx index in block, ix_key) — tx index from `getBlock`. Rules ported bit-exact from v0.6 (`hooks.rs`, `math/reference.rs`): hold buckets (matured/pending, 10 min), rebuy window (7 d, newest ticket first), D10 reference (10-min TWAP of pool spot; touch points = every swap on our pools, any venue; spot = the event's post-swap sqrt price), D12 floor with the 10% self-impact cap, USD value from the Pyth SOL/USD update with the greatest `publish_time ≤ block_time` (Hermes historical API; |Δ| ≤ 60 s or no ticket). Same tx buy+sell by one wallet = no ticket. A keeper that derives anything different doesn't sign.

## 6. Oracle & claims
Keeper `record_samples` now read the DAMM v2 pool (`sqrt_price` at data offset 456, price = (sqrt/2⁶⁴)² × 10⁻³ SOL/token for 6-dec base / 9-dec WSOL; reserves `token_a_amount`/`token_b_amount` for depth). Median, coverage (84 samples, 5/6 buckets), fallback, heartbeat: unchanged. Pre-graduation samples (DBC `sqrt_price` at offset 280) are recorded for the pre-graduation buyback guard only; they never count for claims (D1).

## 7. Admin & safety (changes to v0.6 §6)
Keep: params timelock (D15), bounds (D23, minus curve params — the curve now lives in the DBC config), guardian + two-step admin (D24), pause expiry (D25), Pyth 150 s (D26). New params: `max_attest_age_secs`, `max_attest_tokens_per_hour_bps`, `ticket_challenge_secs`, `attest_threshold` (fixed 2-of-3 in v1). Config allow-list changes timelocked 48 h. Pause flags: `PAUSE_LAUNCH`, `PAUSE_TRADE` (router buys, buyback), `PAUSE_CLAIMS`, `PAUSE_GRADUATE`, **`PAUSE_ATTEST`**. Keeper keys: 3, separate machines + RPC providers; `set_keepers` immediate (event) — a keeper-set change also starts a 6 h attest freeze for the new keys.

## 8. Off-chain
- **Indexer:** `@fumpad/meteora` source on (all venues, our pools) + FUMPAD events; fix v1 transactions everywhere (`maxSupportedTransactionVersion: 1`).
- **Keepers:** attestor (×3, independent), watcher, `claim_fees` (launch window first), `graduate` crank, buyback, samples, auto-claim, queue, close tickets.
- **API:** trades from all venues; tickets with `source` and challenge status.
- **App:** router-based trade panel (DBC/DAMM quotes via Meteora SDK math), launch tx per §2, ticket states "verifying → in challenge window (claimable in Xh) → open", copy: "trade FUMPAD coins anywhere; every sell over $50 counts"; remove register-holdings UI; `/risk` adds D38.

## 9. Testing gates
LiteSVM with **mainnet** DBC 0.2.1 + DAMM v2 binaries and mainnet migration config; full launch → curve (router + direct third-party swaps) → completion (PartialFill) → migration → leftover 8% exact → fees split → buybacks → samples → attested tickets → claims/queue/escrow → expiry. Adversarial: forged/duplicate/replayed attestation, single-keeper signature, keeper not in set, wrong pool/third-party pool, creator as trader, rate cap, challenge-window claim, guardian void, rebuy debit, launch-window fee routing, buyback sandwich guards, migration-fee accounting, pause semantics. Off-chain: engine golden tests on recorded mainnet histories (bit-exact across two independent runs), keeper disagreement tests. Local e2e and devnet e2e as before. Internal security review before external audits.

## Clarifications (contracts v0.7 implementation, 2026-10-13)

Made while implementing `contracts/` (details: `contracts/INTERFACE-v0.7.md`, `contracts/CONTRACTS.md`). None changes a
decision; each pins down something the spec left open or that the mainnet binaries forced.

1. **Migration fee = 1% (D34).** DBC 0.2.1 takes `migration_fee_percentage` as a whole percent, so ≈0.75% isn't
   expressible: FUMPAD configs use 1% (0.85 SOL at 85 SOL; 0.0085 SOL on devnet). `graduate` spends migration fee +
   partner surplus together as the setup budget (migrator refund → caller refund → observations → claim queue →
   platform).
2. **8% exact (D35).** The DBC curve is re-derived on the mainnet binary (incl. the DAMM v2 deposit's rounding dust)
   so the leftover is exactly 80,000,000.000000 tokens when the curve completes in one swap. Each extra swap rounds its
   output down in the pool's favour, so a real path adds a few base units (10⁻⁶ token) on top — never less.
   Start MC 30.33 SOL (spec ≈30.39), ×14.69 to graduation.
3. **Graduation is two instructions** (§4): `migrate_pool` (wrapper of DBC `migration_damm_v2`, records the caller's
   flash-rent cost) + `graduate` (steps 2–4). One instruction needs ≈ 37 accounts and doesn't fit a legacy tx. Anyone
   may migrate directly on DBC; `graduate` skips done steps (leftover, migration fee, surplus each checked by DBC
   flags). `graduate` accepts any DAMM v2 config whose `pool_creator_authority` is DBC's pool authority (not only
   `A8gM…`) and a position of that pool whose NFT `fee_claimer` holds, with all its liquidity permanently locked —
   never compared with the pool's totals (REVIEW-v0.7 H-1; see 15).
4. **Fee claims are two instructions** (§3.2): `claim_fees` (DBC partner fees; the first one after `launch_slot +
   launch_window_slots` sends 100% to buyback, D33) and `claim_lp_fees` (DAMM v2 position; requires the launch flag
   settled). Claimed WSOL is unwrapped into the Coin account (lamport invariant). Split: platform and creator get
   exact floors of 30%/20%, the rounding remainder goes to buyback; the split is snapshotted per coin like D14.
5. **Attestation message (§5.2).** `cluster_tag` is a `u8` stored in `Global` at init (0 mainnet, 1 devnet,
   2 local). The `venue` byte carries the source: bit0 = venue (0 DBC, 1 DAMM v2), bit7 = routed by the FUMPAD router
   (→ `Ticket.source`). `attest_sell`/`attest_rebuy` take no arguments: the record is read from the Ed25519
   instruction immediately before them (every entry self-referencing, one shared message). Consumed seeds hash the
   64-byte signature with SHA-256. The rebuy message (236 bytes) adds ticket/mint/owner/slot/block_time to the spec's
   args, and its consumed marker is per (trade, ticket) because one buy can debit several tickets.
6. **Attestation checks.** Submitter must be a keeper (it pays and gets back the rent). `block_time ∈ [created_at −
   60 s, now + 60 s]`, `slot ≥ launch_slot`, `0 ≤ block_time − pyth_publish_time ≤ max_price_age_secs` (default
   60 s per §5.4; Pyth is no longer read on-chain). The hourly cap defers instead of rejecting (see 16).
   `attest_rebuy` re-checks `sell_ts ≤ block_time ≤ sell_ts + rebuy_window`.
7. **Replay markers** are closable only after their ticket is closed AND the trade is older than the max attestation
   age bound (7 days), so a closed marker can never let the same trade be attested again.
8. **Rent payers.** Position, ticket and consumed rent are the attesting keeper's; `close_ticket` is permissionless
   for every terminal state; `close_position` may be signed by the wallet, or by the rent payer only while the
   wallet hasn't opted out of auto-claim (REVIEW-v0.7 L-1: closing would delete the D17 opt-out); rent always
   returns to the payer.
9. **Statuses.** `Complete` is set only when the router itself completes the curve; `graduate` accepts `Curve` or
   `Complete` once DBC reports the pool migrated. `PAUSE_GRADUATE` covers `migrate_pool` and `graduate`.
10. **Pre-graduation samples** are keeper-only, spaced like keeper samples, and stored in the Coin (the latest one
   plus a 5-sample ring for the pre-grad buyback guard, see 24; no observations account before graduation). Pre-graduation buybacks additionally require the launch window to be over.
11. **Router.** Buys: ExactIn or PartialFill; sells: ExactIn. Referral must be None (exact fee measurement).
   `RoutedTrade.quote_gross` = WSOL spent incl. fee (buy) / WSOL received + fee (sell).
12. **Config allow-list**: 8 slots; add and remove are both 48h-timelocked; every add (and every `register_coin`)
   re-checks the config's structural FUMPAD fields.
13. **Keeper freeze**: per key; keys that stay in the set keep their original timestamp.
14. **Rent figures** in `contracts/CONTRACTS.md` are measured with LiteSVM 0.18's mainnet feature set (claim queue
   0.417 SOL vs 0.571 SOL in v0.6); the rate in force at deploy time is UNVERIFIED.
15. **Graduation position / LP fees (REVIEW-v0.7 H-1).** Anyone can add liquidity to the DAMM v2 pool, lock it and
   (the NFT account has no ImmutableOwner) hand the NFT to `fee_claimer`. So `graduate` checks only what identifies a
   FUMPAD position (pool = the canonical pool, NFT held by `fee_claimer`, fully permanently locked) and
   `claim_lp_fees` accepts every `fee_claimer`-held position of the coin's pool: extra liquidity can't block
   graduation, and a donated position recorded first can't strand the fees of DBC's 100% position.
16. **Rate cap = deferral (§5.2 "excess → retry later, never lost"; REVIEW-v0.7 M-1).** Per-coin leaky bucket: a
   ticket over `max_attest_tokens_per_hour_bps` of supply per hour is still created, with `attested_at` (its
   effective time: claimable and guardian-voidable until `attested_at + ticket_challenge_secs`) pushed back so that
   at most one hour's cap becomes effective at once and the rest at the cap rate. `attest_sell` never fails on the
   cap, so an honest sell can't expire behind it. Rebuy debits and guardian voids release their tokens' capacity
   while the coin has a backlog. Chosen over "release only" (which still loses honest sells when real volume
   exceeds the cap for `max_attest_age`) because it is the simplest design where the cap can only delay.
17. **Correctable voids (REVIEW-v0.7 L-2).** `void_ticket(reason, reopen)`: `reopen = true` for a wrong attestation
   of a possibly honest trade (engine bug) reopens the trade's replay marker for ONE corrected attestation (any
   message except the voided one, recorded as `Consumed.message_hash`); `reopen = false` (fraud) keeps the trade
   consumed. A live ticket always blocks a second attestation of its trade.
18. **Leftover (D35; REVIEW-v0.7 I-1).** When someone else called DBC's permissionless `withdraw_leftover` first,
   `graduate` records the leftover as the reward-vault balance minus the coin's buybacks. WSOL pre-funded into the
   transient `fee_wsol` isn't partner surplus: excluded from the setup budget, returned to the caller.
19. **Launch binding (§2; off-chain review L1).** `Params.launch_signer` (default unset): when set, `register_coin`
   must be co-signed by that key — the API signs the launch tx it builds, as it co-signs the vanity mint — so only
   API-built launches register. Changed through the params timelock (48 h). Verified on the mainnet DBC 0.2.1
   binary: `enable_first_swap_with_min_fee` gives the min fee to one swap of the pool-creation tx only (extra
   top-level swaps pay 99%), so `register_coin` doesn't introspect the tx.
20. **Clusters.** Devnet and mainnet use different fumpad program ids (`5YMF…` is devnet's); attestation messages
   bind program id and `cluster_tag`. `record_samples` skips `Complete` coins instead of failing the batch; the
   router refuses a DAMM v2 pool disabled by its operator (`PoolDisabled`, D38). `void_ticket` references the coin
   and mint (indexers crawling by mint see voids; `TicketVoided.coin`).
21. **Fresh tokens can't ride on matured credit (off-chain review V7-M4; restores v0.6 §5.2).** A sell draws on the
   wallet's most recently acquired tokens FIRST — its `pending` bucket (bought or received less than `min_hold_secs`
   ago) — and only the remainder on `matured` tokens; only that remainder counts for the ticket. So "receive or buy X,
   sell X a second later" gets no ticket however many matured tokens the wallet holds, and the matured stock keeps its
   full credit for a later sell. (v0.6 got this from "unseen arrivals are sold first"; in v0.7 every arrival is seen
   and pending, so the engine's `plan_sell` / `debit_sold` take pending first. Transfers out still remove matured
   first — conservative.)
22. **Engine failures are scoped (off-chain review V7-H2).** No chain data can stop a coin's attestations: a swap
   the parser can't verify blocks that transaction's sells and the D10 window after it (`price_unverified`); a
   negative balance or an attested ticket the engine can't map blocks only that wallet, until it fully exits
   (`history_inconsistent`). Non-swap vault movements in a swap tx (donations, pool-program transfers, SyncNative)
   are accounted, and token-account owner changes move the balance between wallets like a transfer.
23. **Bootstrap without timelocks (deploy).** `initialize_global` sets the INITIAL keeper set and the INITIAL DBC config
   allow-list (≤ 8, each validated exactly like `execute_config` add): the initial keepers attest immediately
   (`keeper_added_at = 0`, no 6 h freeze) and the initial configs register coins immediately (no 48 h timelock).
   Only the program's upgrade authority can initialize, and it could replace the program anyway; the timelocks and
   freezes protect an already-running system, so every later `set_keepers` (6 h freeze for new keys) and config
   change (48 h) keeps them. Three keeper slots means the jobs keeper (samples, `claim_for`, pre-graduation
   buybacks) shares a key with one attestor (devnet: attestor-1).
24. **Pre-graduation buyback guard = median of keeper samples (security-review L5).** The Coin keeps its last 5
   keeper pre-graduation samples (`pregrad_ring`, carved out of reserved bytes — Coin size unchanged). A pre-grad
   buyback needs ≥ 4 of them within the last 5 min spanning ≥ 60 s; the guard price is their median, and spot must
   be within ±band of that median AND of the latest sample (≤ 60 s old). One sample taken at a moved spot, or a
   ratchet of in-band moves sampled one after another, can't move the guard; the price must be held through a
   majority of the window's samples. Fixed constants, not params. After a keeper outage > 5 min (or at the first
   samples of a coin) buybacks wait for a 60 s warm-up. Post-graduation guard unchanged.
