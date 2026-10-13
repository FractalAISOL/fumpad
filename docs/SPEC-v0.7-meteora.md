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
Swap from the coin's buyback balance with `PDA["buyback"]` as payer, output to the reward vault. Post-graduation: v0.6 rules (permissionless, spot within ±3% of the 30-min keeper median, slice ≤ 0.5% of pool depth). Pre-graduation (no median yet): **keeper-only**, slice ≤ 0.5% of the curve's quote reserve, and spot (DBC `sqrt_price`) within ±3% of the coin's most recent keeper sample ≤ 60 s old. Buybacks never complete the curve (cap the slice to stay below the migration threshold).

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
