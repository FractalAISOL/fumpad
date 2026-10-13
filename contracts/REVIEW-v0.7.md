# Internal pre-audit review: fumpad v0.7 (Meteora DBC → DAMM v2, attested tickets)

Internal review, 2026-10-13, of `contracts/programs/fumpad/src` at `95c59e9` against `docs/SPEC-v0.7-meteora.md`
(incl. Clarifications), `INTERFACE-v0.7.md` and `CONTRACTS.md`. Does not replace the external audits.
Reproductions: `contracts/tests/src/review_v07.rs`. Each `issue_*` test **passes while the issue exists** and runs on
the **mainnet** DBC 0.2.1 + DAMM v2 0.2.4 binaries and the mainnet DAMM v2 migration config, like the rest of the
suite (full suite: 67 passed, 1 ignored). Turn each into a `regression_*` test when fixing.
**Status:** all five findings fixed on the review-fix branch; every `issue_*` test is now a `regression_*` test
(same file) asserting the fix, plus regression tests for the notes marked fixed below and for the off-chain review
items with contract changes (`security-review/REPORT-v0.7.md` L1 launch binding, L3 void events). L5 (pre-grad
buyback guard on a median of keeper samples) closed on-chain too. Full suite: 78 passed, 1 ignored.

**Bottom line:** no path found for a third party to take funds out of the program or to move one coin's fees,
leftover, LP fees or buyback output to another coin. One High: anyone can stop a coin from ever graduating in fumpad
(cheap, reversible only by the attacker), which disables claims for that coin. Fix H-1 before mainnet.

## Findings

| ID | Sev | Description | Impact | Repro test | Suggested fix | Status (2026-10-13) |
|---|---|---|---|---|---|---|
| H-1 | High | `graduate` requires our permanently-locked position to hold ≥ 99.99% of the DAMM v2 pool's `liquidity`. DAMM v2 `create_position` + `add_liquidity` are permissionless, so anyone who adds > 0.01% of the pool's liquidity (measured: < 0.02 SOL + matching tokens for 0.02% at an 85 SOL raise, all withdrawable) between DBC's migration (permissionless, Meteora keepers do it at completion; an attacker can do it in the same tx) and `graduate` makes `graduate` fail with `InvalidMigratedPool` for as long as the liquidity stays. An honest LP adding liquidity early has the same effect. | The coin can never reach `Graduated`: no claims / `claim_for` / queue (the whole reward product for that coin), no `claim_lp_fees` (LP fees accrue to our locked position but can't be split), router dead (`Curve`/`Complete` → DBC refuses), no post-grad buybacks / samples, DAMM sells can't be attested (`damm_pool` unset → `PoolNotOfCoin`), migration fee + surplus unclaimed. Griefer keeps the liquidity (can hold the coin hostage). | `issue_third_party_damm_liquidity_blocks_graduate_forever` | Drop the share check. Identify our position by what only DBC can produce: `position.pool == damm_pool`, NFT account = `PDA["position_nft_account", nft_mint]` holding 1 NFT owned by `fee_claimer`, `unlocked == 0`, `vested == 0`, `permanent_locked > 0` (only the NFT owner can lock, and `fee_claimer` never signs DAMM lock/liquidity ixs). Do NOT compare with `pool.permanent_lock_liquidity` (@552) either: a third party can permanently lock its own position. | **Fixed.** `graduate` identifies our position only by pool == the canonical DAMM pool (PDA of the DBC-authority migration config + mint + WSOL), NFT held by `fee_claimer` at the DAMM NFT-account PDA, unlocked = vested = 0, permanent locked > 0 — no comparison with pool totals. Hardening: the NFT account has no ImmutableOwner, so anyone can hand a dust-locked position to `fee_claimer` and graduate first with it; `claim_lp_fees` therefore accepts every `fee_claimer`-held position of the coin's pool (ours stays claimable). Tests `regression_third_party_damm_liquidity_cannot_block_graduate`, `regression_position_handed_to_fee_claimer_cannot_strand_our_lp_fees`. |
| M-1 | Med | The per-coin hourly attestation cap counts `ticket_tokens` at attestation and never releases them when the ticket is debited to zero by `attest_rebuy` or voided by `void_ticket`. A wallet that repeatedly sells (≥ 10-min hold) and buys back fills the cap with tickets that end up void, at the cost of fees/slippage only; honest attestations get `AttestRateLimited` and, once `now − block_time > max_attest_age_secs` (24 h), `AttestationExpired` forever. Hot coins with ≥ 20% of supply per hour of qualifying sells hit the same wall without an attacker. | Honest sellers silently lose tickets (contradicts SPEC §5.2 "excess → retry later, never lost"); a whale can starve every other seller of a coin for a day per day of wash trading. | `issue_rate_cap_counts_voided_tickets_and_starves_honest_sells_until_they_expire` | Release cancelled tokens: store the bucket start on the Ticket and subtract its tokens from that bucket when a rebuy/void cancels it while the bucket is still current or previous. Additionally make the age limit forgiving for capped attestations (e.g. check `max_attest_age` against `max(block_time, attest_bucket_start − 1h)` when the coin is at its cap), or treat the hourly cap as a keeper-side ordering rule with a much higher on-chain safety cap. At minimum: document that rate-limited tickets can expire and alert on `AttestRateLimited`. | **Fixed (design change).** The cap is a per-coin leaky bucket that defers and never rejects: a ticket over 20%/h of supply gets `attested_at` (= effective time, start of its challenge window) in the future; `AttestRateLimited` is no longer returned, so no honest sell expires because of the cap. Rebuy debits and guardian voids release their tokens' capacity while the coin has a backlog. Test `regression_rate_cap_releases_cancelled_tickets_and_never_loses_honest_sells`. |
| L-1 | Low | Regression vs v0.6: v0.6 let only the owner close Claimed/Voided tickets and only the wallet close its Position. v0.7 makes `close_ticket` permissionless for every terminal state and lets `position.rent_payer` (the attesting keeper) sign `close_position`. Closing the Position deletes the wallet's D17 `auto_claim_opt_out`; the next `attest_sell` re-creates it with auto-claim enabled. | A keeper (or anyone + the keeper) silently re-enables auto-claim for a wallet that opted out; `claim_for` then claims for it (D17 consent broken). Rent refund itself is correct. | `issue_keeper_can_reset_a_wallets_auto_claim_opt_out` | Only the wallet may close its Position (rent still → `rent_payer`), or keep the opt-out somewhere that survives the Position (e.g. a tiny per-wallet-per-coin preference PDA paid by the wallet), or refuse `close_position` by the rent payer when `auto_claim_opt_out == 1`. | **Fixed.** The rent payer may close a Position only while `auto_claim_opt_out == 0` (nothing to lose; re-creation restores the same default); an opted-out Position is closable by the wallet only, so the opt-out survives. Test `regression_keeper_cannot_reset_a_wallets_auto_claim_opt_out`. |
| L-2 | Low | `void_ticket` voids the ticket but leaves the sell's consumed marker, so a voided trade can never be attested again. The guardian's only tool against a wrong attestation (wrong amount/price/venue bit from an engine bug, not fraud) also destroys the honest seller's correct ticket. | Honest sellers lose tickets whenever the guardian has to void a buggy (not malicious) attestation; incentive to not void. | `issue_voided_attestation_cannot_be_corrected` | Let `void_ticket` close the sell marker (or mark it re-attestable) when the guardian passes a "correctable" reason, so a corrected 2-of-3 attestation of the same trade can be submitted; keep the marker for fraud voids. | **Fixed.** `void_ticket(reason, reopen)`: `reopen = true` turns the sell marker into `kind = 2`; one corrected attestation of the same trade (any message except the voided one, `Consumed.message_hash`) re-uses it; a live ticket still blocks every replay; `reopen = false` = fraud, consumed forever. Test `regression_voided_attestation_can_be_corrected`. |
| I-1 | Info | DBC `withdraw_leftover` is permissionless; if anyone calls it before `graduate`, the 8% still lands in the reward vault but `Coin.leftover_tokens` and `Graduated.leftover_tokens` are 0. | Event-sourced consumers (indexer/app) show an empty reward pool for that coin. | `issue_leftover_withdrawn_by_third_party_is_recorded_as_zero` | Record the vault balance attributable to the leftover (e.g. `vault_after − buyback_tokens`), or emit the reward-vault balance in `Graduated`. | **Fixed.** When the leftover was already withdrawn, `leftover_tokens` = reward-vault balance − `coin.buyback_tokens`. Test `regression_leftover_withdrawn_by_third_party_is_recorded`. |

## Notes (no repro; accepted risks or hygiene)

- **Attestation introspection (no finding).** Checked: Ed25519 ix must be at `current − 1`, every entry self-referencing
  (`u16::MAX`), all entries over byte-identical messages, length + domain tag per kind (sell 284 / rebuy 236, so a sell
  can't parse as a rebuy), distinct signer keys, only active keepers (6h freeze) counted, `attest_threshold` floored at
  2, submitter must be a keeper, CPI-invoked `attest_*` fails (`current` ix must be fumpad), program id + cluster tag
  bound, consumed markers per (sig, ix_key) / (sig, ix_key, ticket), marker close only after ticket close AND
  `block_time + 7d` (≥ any `max_attest_age`), pre-funded PDAs tolerated.
- **PDA-signed CPIs (no finding).** `claim_fees`, `claim_lp_fees`, `graduate` (leftover / migration fee / surplus) and
  `execute_buyback` forward exact pinned lists; pool/config/position pinned to the Coin (`has_one`), vaults read from the
  pinned pool, destinations fixed (reward-vault ATA, transient `fee_wsol`, `buyback` ATA). No path for one coin's action
  to sign for another coin's accounts. Router signs nothing.
- **Cluster tag** is any `u8` at `initialize_global`. If devnet and mainnet share the program id (as INTERFACE implies),
  keepers must never reuse keys across clusters, and the devnet Global must not be initialized with tag 0.
  *Status: documented — devnet (`5YMF…`) and mainnet use different program ids (INTERFACE header, CONTRACTS deploy step 1);
  the message binds both program id and tag; check kept.*
- **Pre-grad buyback trusts one keeper sample ≤ 60 s** and is keeper-only (already in CONTRACTS.md open risks): a single
  compromised keeper key can pump → sample → buy back → dump, bounded by 0.5% of the quote reserve per call, every
  `oracle_min_spacing_secs`. Consider 2 samples from 2 keepers, or a per-coin pre-grad buyback budget per hour.
  *Status: fixed for market manipulation (security-review L5) — the guard is the median of the coin's last 5 keeper
  samples (`Coin.pregrad_ring`, ≥ 4 within 5 min spanning ≥ 60 s) and spot must also agree with the latest sample;
  a single moved sample or a per-sample in-band ratchet can't steer it
  (`regression_l5_one_moved_sample_cannot_steer_the_pregrad_guard`,
  `regression_l5_in_band_ratchet_cannot_make_the_buyback_overpay`; liveness
  `pregrad_buyback_liveness_under_honest_sampling`). Residual: samples are still keeper-only, so a compromised keeper
  key can feed 4 samples over 60 s and must then hold the pumped price that long (same per-call bound).*
- **DAMM v2 `pool_status` / `layout_version` / `collect_fee_mode` are not read.** Samples keep recording a disabled
  pool's frozen price (claims can trigger on it, D38); `token_b_amount` is 0 on layout-0 pools (buyback cap 0). Cheap
  hardening: require `pool_status == 0` for samples/buybacks, `layout_version ≥ 1`, `collect_fee_mode == OnlyB`.
  *Status: router refuses a disabled pool with `PoolDisabled` (`regression_router_refuses_a_disabled_damm_pool`);
  samples/buybacks unchanged (open).*
- **Stranded value with no claim path:** DAMM v2 position rewards (`claim_reward`, owner = `fee_claimer`) and DBC
  partner pool-creation fees (config value is not validated); DBC partner fees of pools on our configs that never
  `register_coin`.
- `Graduated.surplus` = fee_wsol balance − migration fee, so a pre-funded `fee_wsol` is reported as surplus (budget
  itself correct). *Status: fixed — the pre-funded balance is excluded from surplus and budget and returned to the
  caller (`regression_graduated_surplus_ignores_a_prefunded_fee_wsol`).*
- `close_position` with more than ≈ 28 tickets doesn't fit a legacy tx (needs v0 + ALT); > 64 never closable.
- `record_samples` fails the whole batch if one coin turned `Complete` (any router buy can do that) — keeper retries.
  *Status: fixed — `Complete` groups are skipped (`regression_record_samples_skips_a_complete_coin`).*
- Guardian can `set_pause(0)` an admin pause and cancel every admin proposal (v0.6 M-2 design, unchanged).
- `register_coin` accepts any pool on an allow-listed config whose creator signs (known; name/symbol/uri unchecked).
  *Status: optional launch co-signer `Params.launch_signer` (off-chain review L1); DBC verified to give the min fee
  to one swap per pool-creation tx only, so no tx introspection (`regression_launch_signer_binds_register_coin`,
  `verify_dbc_min_fee_goes_to_one_swap_per_launch_tx`).*

## Areas reviewed

Attestation (introspection, binding, replay, rate cap, challenge window, `void_ticket`, rebuy ↔ queue), router
(pass-through, measurement, PartialFill/Complete), fee claims (D33 flag: only callable from `launch_slot + window`,
permissionless, so nobody can settle early; a late first claim only shifts fees to buyback), buybacks, `migrate_pool` /
`graduate` (idempotence, third-party migration / leftover, migration fee + surplus budget, refunds, prefunds),
`register_coin` (creator spoofing, fake mint, double registration, config removal), custody and Coin lamport
invariant, rent payers / close paths, claims / queue / escrow / auto-claim vs v0.6 (diff of `rewards/` since
`037027a~1`), admin / timelocks / pauses / params bounds, oracle offsets (checked against the DAMM v2 IDL layout).
