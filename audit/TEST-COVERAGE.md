# Test coverage map

This branch's head (pre-audit fixes, PRIOR-REVIEWS §0), run on 2026-10-13 with `audit/build-and-test.sh`
(toolchain in README §4).

| Suite | Command | Count | Runtime (M1) |
|---|---|---|---|
| Program unit tests | `cargo test -p fumpad --lib` | 21 | < 1 s |
| LiteSVM integration (mainnet DBC 0.2.1 + DAMM v2 0.2.4 binaries) | `cargo test -p tests` | 94 pass, 1 ignored (`derive_exact_curves`, a tool) | ≈ 15 s |
| Services unit (vitest `unit`) | `npm test` in `services/` | 42 files, 436 tests | ≈ 50 s |
| Services integration incl. local e2e | `npm run test:integration` | 6 files, 31 tests (e2e: 1 test, 20 named checks) | ≈ 4 min |
| App (node test runner) | `npm test` in `app/` | 113 tests | ≈ 2 s |
| v0.7 off-chain PoCs (flipped) | `node --import tsx --test …` (script step 8) | 8 files | < 10 s |

LiteSVM test names are `contracts/tests/src/<file>::<test>`; unit tests are `contracts/programs/fumpad/src/...::tests::<name>`;
services tests are quoted by their `it(...)` title.

Every LiteSVM test runs the program built from source against the real mainnet Meteora bytecode, so Meteora
behaviour in these tests is the deployed behaviour (at the fixture hashes, README §5.1), not a mock. The helper
`flow::assert_coin_invariant` (Coin lamport invariant I1) is called from `admin_tests`, `e2e_tests`, `fees_tests`,
`lifecycle_tests`, `oracle_buyback_tests`, `review_v07` and `router_tests` after state-changing steps.

## 1. On-chain invariants (THREAT-MODEL §3) → tests

| Inv. | Tests |
|---|---|
| I1 Coin lamports | `flow::assert_coin_invariant` in 18 call sites (above); `fees_tests::creator_and_platform_withdrawals`; `e2e_tests::full_lifecycle_one_coin` |
| I2 No cross-coin movement | **`two_coin_tests::two_coins_share_pdas_without_moving_each_others_funds`** (two live coins through launch-window + 50/30/20 fee claims of both in one tx, pre-grad buybacks of both in one tx, attestations, graduation in the same slot, LP-fee claims of both in one tx, post-grad buybacks of both in one tx, claims on both in one tx; every delta matched to the coin's own events, shared PDAs empty after each tx, cross-coin substitutions refused), `audit_prep_tests::unregistered_pool_fees_go_to_the_platform_treasury` (registered coin refused, mint ≠ pool), `position_farming_rewards_go_to_the_reward_pool_or_treasury` (another coin's position refused), `fees_tests::fee_claims_reject_spoofed_accounts` (another coin's pool under this coin), `router_tests::regression_router_requires_canonical_ata_and_rejects_spoofed_accounts` (another coin's pool / vaults / mint), `admin_tests::graduation_adversarial_and_migration_fee_accounting` (migrate_pool with another coin's accounts), `review_v07::regression_position_handed_to_fee_claimer_cannot_strand_our_lp_fees` (another coin's position refused), `rewards_tests::process_queue_rejects_spoofing`, `attest_tests::record_binding_rules` (mint / pool of another coin), `oracle_buyback_tests::regression_pda_signed_cpis_carry_no_foreign_accounts` |
| I3 Vault pays only tickets | `rewards_tests::claim_pays_ten_percent_immediately`, `auto_claim_pays_only_the_owner_and_respects_opt_out`, `regression_memo_refusing_or_missing_atas_are_escrowed_and_leave_the_queue`, `over_cap_claims_queue_skip_ahead_and_never_expire`, `process_queue_rejects_spoofing`; `e2e_tests::full_lifecycle_one_coin` |
| I4 Claim preconditions | `rewards_tests::claims_need_a_graduated_coin`, `claim_rules_trigger_samples_owner_pause_expiry` (TriggerNotMet, InsufficientSamples, TicketExpired, Paused, TicketInChallenge), `instant_claim_waits_behind_older_fitting_entry_and_wallet_limit` (WalletQueueLimit), `queue_full_reverts_and_ticket_stays_open` (QueueFull); unit `state::observations::tests::{median_window_and_coverage, coverage_requires_time_spread, fallback_samples_excluded, spike_does_not_move_median}`, `instructions::rewards::queue::tests::*` |
| I5 Ticket creation | `audit_prep_tests::attest_sell_refuses_a_ticket_price_below_execution` (TicketPriceBelowExecution), `operators_are_jobs_keys_and_never_attestors` (an operator can't submit or co-sign), `attest_tests::attestation_requires_two_distinct_active_keepers`, `ed25519_instruction_must_be_immediately_before_and_self_contained` (MissingAttestation, InvalidAttestation), `forged_and_tampered_signatures_fail_in_the_precompile`, `non_keeper_cannot_submit_and_new_keepers_are_frozen_for_6h`, `record_binding_rules` (WrongCluster, PoolNotOfCoin, CreatorSell, BelowMinimumUsd, InvalidTicketAmount, StalePythPrice, AttestationExpired), `attest_sell_creates_ticket_position_and_marker`, `tickets_attested_in_every_status_and_venue`, `open_ticket_limit_pause_and_status`; `vectors::program_accepts_vector_style_attestation`, `vectors::attestation_vectors_match_checked_in_file`; unit `attestation::tests::{sell_roundtrip_and_offsets, rebuy_roundtrip, ed25519_parse}` |
| I6 Consumed-key uniqueness | `attest_tests::replayed_and_duplicate_attestations_are_rejected`, `rebuy_debits_voids_and_cannot_replay`; `review_v07::regression_voided_attestation_can_be_corrected` (reopen allows exactly one different message; a live ticket blocks replays) |
| I7 Marker closure | `attest_tests::consumed_markers_close_only_after_ticket_and_max_age` (ConsumedNotClosable) |
| I8 Rate cap | `attest_tests::rate_cap_defers_tokens_beyond_the_hourly_cap`, `review_v07::regression_rate_cap_releases_cancelled_tickets_and_never_loses_honest_sells`; unit `state::coin::tests::rate_cap_defers_and_releases` |
| I9 Ticket monotonicity | `attest_tests::rebuy_debits_voids_and_cannot_replay` (RebuyOutOfWindow), `guardian_voids_inside_the_challenge_window_only` (ChallengeWindowOver); `rewards_tests::regression_rebuy_updates_queue_entry_so_order_holds` |
| I10 Timelocks / roles | `audit_prep_tests::operators_are_jobs_keys_and_never_attestors`, `initialize_global_bootstraps_operators`, `migrate_global_fills_operators_from_keeper_0`, `error_no_pending_config`; `admin_tests::params_timelock_bounds_and_cancel`, `params_timelock_boundary_1h`, `config_timelock_boundary_1h`, `admin_timelock_boundary_6h`, `guardian_cancels_within_the_short_windows`, `timelock_values_are_1h_routine_6h_authority`, `regression_stolen_admin_key_cannot_outrun_the_guardian`, `initialize_global_only_by_upgrade_authority_and_validates`, `bootstrap_keepers_attest_immediately_and_bootstrap_config_registers_immediately`, `regression_pause_semantics_and_expiry`, `regression_admin_changes_emit_events`; `config_tests::config_allow_list_is_timelocked_and_validated`; `attest_tests::non_keeper_cannot_submit_and_new_keepers_are_frozen_for_6h`; Squads side: `npm run multisig:rehearsal` (not in the script, results in `services/MULTISIG.md` §6) |
| I11 Pauses never trap users | `router_tests::regression_pause_never_freezes_router_sells_and_lapses`, `admin_tests::regression_pause_semantics_and_expiry`, `lifecycle_tests::register_coin_rejections` (PAUSE_LAUNCH), `attest_tests::open_ticket_limit_pause_and_status` (PAUSE_ATTEST), `rewards_tests::claim_rules_trigger_samples_owner_pause_expiry` (PAUSE_CLAIMS) |
| I12 Pinned PDA-signed CPIs | `oracle_buyback_tests::regression_pda_signed_cpis_carry_no_foreign_accounts`, `fees_tests::fee_claims_reject_spoofed_accounts`, `oracle_buyback_tests::pre_graduation_buyback_keeper_only_guarded_and_never_completes` / `post_graduation_buyback_median_guard_and_slice` (exact lists) |
| I13 Router | `router_tests::dbc_router_buy_and_sell_measure_exact_amounts`, `damm_router_after_graduation`, `regression_router_requires_canonical_ata_and_rejects_spoofed_accounts`, `review_v07::regression_router_refuses_a_disabled_damm_pool` |
| I14 Fee split | `fees_tests::launch_window_fees_go_100_percent_to_buyback_then_split_50_30_20` (LaunchWindowActive), `first_claim_with_nothing_accrued_still_settles_launch_flag`, `lp_fees_from_all_post_graduation_volume` (LaunchFeesUnsettled); unit `math::fees::tests::split_sums_and_matches_spike` |
| I15 Graduation budget | `admin_tests::graduation_adversarial_and_migration_fee_accounting` (sum identity, NotMigrated, InvalidMigratedPool), `review_v07::regression_graduated_surplus_ignores_a_prefunded_fee_wsol`, `regression_third_party_damm_liquidity_cannot_block_graduate`, `regression_leftover_withdrawn_by_third_party_is_recorded` |
| I16 8% leftover | `lifecycle_tests::full_lifecycle_to_graduation_with_exact_reward_pool`, `devnet_config_graduates_with_exact_reward_pool`; `config_tests::derived_configs_are_exact_and_d17_shaped`, `dbc_config_vectors_match_checked_in_file` |
| I17 Buybacks | `audit_prep_tests::disabled_damm_pool_is_never_sampled_bought_or_claimed` (PoolDisabled), `error_nothing_to_buy_back`; `oracle_buyback_tests::pre_graduation_buyback_keeper_only_guarded_and_never_completes` (operator only; attestor refused), `post_graduation_buyback_median_guard_and_slice`, `regression_l5_one_moved_sample_cannot_steer_the_pregrad_guard`, `regression_l5_in_band_ratchet_cannot_make_the_buyback_overpay`, `pregrad_buyback_liveness_under_honest_sampling` (PriceDeviation, StaleSample, InsufficientSamples); unit `state::coin::tests::pregrad_ring_median_needs_count_and_span` |
| I18 Registration | `lifecycle_tests::launch_registers_coin_with_snapshot`, `register_coin_rejections` (ConfigNotAllowed, …), `launch_tx_fits_and_sniper_in_same_slot_pays_99_percent`; `review_v07::regression_launch_signer_binds_register_coin`, `verify_dbc_min_fee_goes_to_one_swap_per_launch_tx`; `config_tests::queue_config_rejects_non_fumpad_configs`; `admin_tests::bootstrap_rejects_invalid_configs` |
| I19 Fail closed on foreign accounts | spoofing tests above (owner / discriminator / address mismatches); oracle `post_graduation_samples_ring_and_fallback`, `pre_graduation_samples_are_keeper_only_and_spaced` (SampleTooSoon, SampleTxNotIsolated) |
| I20 Roles disjoint | `audit_prep_tests::operators_are_jobs_keys_and_never_attestors`, `initialize_global_bootstraps_operators`, `migrate_global_fills_operators_from_keeper_0` (KeeperOperatorOverlap both ways; transitional fill then separation); services `keeper/test/role.test.ts` |
| I21 Disabled pools | `audit_prep_tests::disabled_damm_pool_is_never_sampled_bought_or_claimed`, `review_v07::regression_router_refuses_a_disabled_damm_pool` |
| Every error code | `error_coverage::every_error_code_is_asserted_by_a_test` (fails if any `FumpadError` the program returns has no test, or if a reserved code is returned) |

## 2. Threats (THREAT-MODEL §2) → tests

| Threat | Tests |
|---|---|
| Sniper in the launch block / bundled into the launch tx | `lifecycle_tests::launch_tx_fits_and_sniper_in_same_slot_pays_99_percent`, `review_v07::verify_dbc_min_fee_goes_to_one_swap_per_launch_tx`; e2e check "creator's first buy got the min fee (1.25%), not the 99% launch-window fee" |
| Self-launch on our config without the API | `review_v07::regression_launch_signer_binds_register_coin`; e2e (unsigned self-launch refused); `services/api/test/launch-signer.test.ts` |
| Graduation griefing (extra liquidity, donated position, third-party leftover / migration, pre-funded PDAs) | `review_v07::regression_third_party_damm_liquidity_cannot_block_graduate`, `regression_position_handed_to_fee_claimer_cannot_strand_our_lp_fees`, `regression_leftover_withdrawn_by_third_party_is_recorded`, `regression_graduated_surplus_ignores_a_prefunded_fee_wsol`; `admin_tests::graduation_adversarial_and_migration_fee_accounting` |
| Buyback sandwich / oracle steering | `oracle_buyback_tests::*` (incl. `regression_l5_*`); `keeper/test/buyback-guard.test.ts`; unit `state::observations::tests::spike_does_not_move_median` |
| Single compromised operator (jobs key) | `audit_prep_tests::operators_are_jobs_keys_and_never_attestors` (can't submit / co-sign attestations; rotated out at once); `oracle_buyback_tests::regression_l5_*` (sample timing bounded) |
| Single compromised keeper | `attest_tests::attestation_requires_two_distinct_active_keepers` (one key twice = 1), `non_keeper_cannot_submit_and_new_keepers_are_frozen_for_6h`; `keeper/test/attestor.test.ts` "a keeper that derives something different never gets its message submitted", "forged / non-keeper signatures on the board are ignored", "board status is only a hint (V7-M1, L4)"; `rewards_tests::auto_claim_pays_only_the_owner_and_respects_opt_out`; `review_v07::regression_keeper_cannot_reset_a_wallets_auto_claim_opt_out` |
| 2-of-3 compromise (bounded by window, guardian, cap) | `attest_tests::guardian_voids_inside_the_challenge_window_only`, `rate_cap_defers_tokens_beyond_the_hourly_cap`, `open_ticket_limit_pause_and_status` (PAUSE_ATTEST); `rewards_tests::claim_rules_trigger_samples_owner_pause_expiry` (TicketInChallenge); watcher: `keeper/test/watcher.test.ts` (mismatch, missing, alerts); e2e check "watcher: every TicketAttested / TicketDebited matches its independent re-derivation" |
| Replay / cross-cluster / cross-program attestation | `attest_tests::replayed_and_duplicate_attestations_are_rejected`, `record_binding_rules`, `consumed_markers_close_only_after_ticket_and_max_age`; `sdk/test/attestation.test.ts`, `sdk/test/contract-vectors.test.ts` |
| Ed25519 instruction layout tricks | `attest_tests::ed25519_instruction_must_be_immediately_before_and_self_contained`, `forged_and_tampered_signatures_fail_in_the_precompile`; unit `attestation::tests::ed25519_parse` |
| Wash selling / fresh tokens / rebuys | `engine/test/engine.test.ts` "hold time …", "rebuy rule …", "fresh tokens can't ride on matured credit (V7-M4)", "transfers out", "exclusions"; `engine/test/rules.test.ts` (v0.6 `hooks.rs` / `reference.rs` ports); `engine/test/property.test.ts`; PoCs `fresh-tokens-ride-matured`, `rebuy-before-attestation` |
| Crash staged in a bundle (D10/D12) | `engine/test/engine.test.ts` "D10 reference + D12 floor"; `rules.test.ts` "reference.rs" (`same_timestamp_observation_has_zero_weight`, `dragging_to_a_tenth_needs_eleven_staged_intervals`, `d12_ticket_price`, …) |
| Fake / spoofed Meteora events, vault donations, owner changes | `meteora/test/parse.test.ts` "fail closed" (event not signed by the event authority, vault mismatch, truncated event, missing stackHeight, garbage), "fixtures: invariants re-checked against balances"; `meteora/test/vaultflow.test.ts`; PoCs `vault-donation-freeze`, `owner-change-negative-balance` |
| Keeper disagreement / determinism | `engine/test/golden.test.ts` (two independent replays byte-identical; reverse-order input), `engine/test/property.test.ts` (200 random tapes, order-insensitive), `engine/test/pyth.test.ts` "two keepers getting the same updates in different orders pick the same one" |
| Malicious / incomplete RPC | `keeper/test/derive.test.ts` "L8: …" (2 tests); `engine/test/fetch.test.ts` |
| Compromised API / DB | `keeper/test/attestor.test.ts` "board status is only a hint (V7-M1, L4)"; PoC `board-status-suppression`; `app/src/chain/allowlist.test.ts` "V7-M3 …", `app/src/chain/launch.test.ts` "checkLaunchBinding" |
| Keeper liveness DoS | `engine/test/fetch.test.ts` "incremental mint crawl (V7-M6)"; `keeper/test/attestor.test.ts` "coin scheduling (V7-M6)"; PoC `crawl-amplification` |
| Meteora pool disabled (D38) | `review_v07::regression_router_refuses_a_disabled_damm_pool` (router), `audit_prep_tests::disabled_damm_pool_is_never_sampled_bought_or_claimed` (samples, buybacks, claims wait) |
| Stranded value (unregistered pools, farming rewards) | `audit_prep_tests::unregistered_pool_fees_go_to_the_platform_treasury`, `position_farming_rewards_go_to_the_reward_pool_or_treasury` |
| Admin compromise | `admin_tests::regression_stolen_admin_key_cannot_outrun_the_guardian`, `params_timelock_bounds_and_cancel`, `guardian_cancels_within_the_short_windows`; `keeper/test/watcher.test.ts` "governance alerts" (O8); `config_tests::config_allow_list_is_timelocked_and_validated`; `regression_params_changes_cannot_reprice_live_coins` |
| Embedded-wallet silent signing (scope C) | `app/src/chain/allowlist.test.ts` (28 tests on transactions captured from the local stack + tampered variants), `app/src/chain/launchAuth.test.ts`, `app/src/chain/fixtures.test.ts`, `app/src/chain/limits.test.ts`; PoC `app-allowlist-min-out` |

## 3. End-to-end evidence

- `contracts/tests/src/e2e_tests.rs::full_lifecycle_one_coin` (LiteSVM): launch → router and direct curve trades →
  fee claims (launch window, then 50/30/20) → pre-grad buyback → attested tickets → completion (PartialFill) →
  migration → graduation (8% leftover exact) → LP fees → samples → claims / queue → expiry.
- `services/test/integration/e2e.test.ts` (= `npm run local`, real validator, real services, 3 attestors + watcher):
  20 checks, from "prepare: DBC init → creator top-level swap2 → register_coin …" to "watcher: every TicketAttested / TicketDebited matches its
  independent re-derivation" and "bob received his 10% payout in the coin's tokens".
- Not in the script (recorded results): `npm run multisig:rehearsal` 33/33 (at `aa137a9`), `npm run mainnet:rehearsal`
  37/37 (re-run at this head on the 2026-10-13 mainnet snapshot, slot 456,589,591: operator key bootstrapped, jobs
  keeper on it, attestors separate), `npm run bootstrap:rehearsal` 7/7 (incl. the devnet operators upgrade:
  pre-operators Global → `migrate_global` + `set_operators` in one tx), a devnet scenario (`services/scripts/devnet/*`,
  live devnet v0.7 program at `aa137a9`).

## 4. Known gaps

**On-chain**
1. ~~Error paths never asserted~~ — closed: every code the program returns is asserted, enforced by
   `error_coverage`. Previously missing, now in `audit_prep_tests`: `PoolNotFresh`, `NothingToBuyBack`, `NoEscrow`,
   `NoPendingConfig`, `LamportInvariant`, `SlippageExceeded`, `MathOverflow`. `NoEscrow` and `LamportInvariant` are
   defense in depth (no instruction sequence reaches them; the tests corrupt the state on purpose). `WouldCompleteCurve`
   and `AttestRateLimited` stay reserved and are asserted never to be returned.
2. ~~No multi-coin interleaving test~~ — closed: `two_coin_tests` (I2 row). Graduation of the two coins runs in the
   same slot, not the same transaction (`migrate_pool` / `graduate` each need ~1,050 bytes on their own).
3. No fuzzing (instruction-sequence or account-substitution fuzzing) and no property tests on chain beyond the unit
   tests listed; no formal verification.
4. DAMM v2 `layout_version` / `collect_fee_mode` are still not read (THREAT-MODEL G2); a layout-0 pool is untested.
   Pool status and reward slots are set in tests by writing the mainnet DAMM pool / position accounts (DAMM's
   `set_pool_status` / `initialize_reward` need its admin keys), so DAMM's own admin paths aren't exercised.
5. The rate cap's ≈ 2× burst after releases is described in CONTRACTS.md but not asserted as an upper bound.
6. Tests run against one snapshot of Meteora's bytecode (fixture hashes); compatibility with a future Meteora upgrade
   is checked only by re-dumping (`npm run mainnet:compare`) and re-running.
7. Rent figures are LiteSVM's; the mainnet rate at deploy time is UNVERIFIED.
8. `close_position` with > 28 tickets (v0 + ALT) and the 64-ticket limit are not exercised.

**Off-chain**
9. Golden mainnet histories are 4 recorded coins (`services/engine/test/fixtures`, default + stress terms); they do not include every
   router seen on mainnet (`services/meteora/ATTESTATION.md` §6: GMGN / Photon / Trojan / Padre transactions were not
   found in the sample; unlabelled router programs are parsed as `unknown_program`).
10. Hermes is mocked in tests (`StaticPythSource`, recorded responses); live Hermes behaviour (rate limits, 404
    patterns) is covered only by the devnet deployment.
11. Telegram delivery and the guardian's human response time are not tested; O7 (watcher alert ≪ challenge window)
    and O8 (governance alert ≪ 1 h timelock, THREAT-MODEL R9) are operational properties.
12. The board's Postgres RLS is tested on a throwaway Postgres (`services/DEPLOY-v07.md` §3) and in unit tests with
    `MemoryBoard`; the integration tests do not run the attestors under separate DB roles.
13. One vitest test (`keeper/test/queue.test.ts` "matches the program on random queues …") uses the 5 s default
    timeout and timed out once when run in parallel with a cargo build; it passes when the machine is not loaded
    (the script runs suites sequentially).

**Scope C**
14. The allow-list is tested against captured local-stack transactions; Privy's own iframe / bridge behaviour is
    not tested here.
