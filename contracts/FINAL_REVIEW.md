# Final pre-mainnet review: fumpad + fumpad_lp_locker (v0.5)

Internal review, 2026-10-12. Does not replace the two external audits. Reproductions: `contracts/tests/src/final_review.rs` (`issue_*` tests pass while the issue exists). The full suite also passed against **mainnet** PumpSwap + pump-fees binaries and mainnet GlobalConfig/FeeConfig.

**Bottom line:** no path found to steal funds or break the Coin lamport invariant. One High must be fixed before the locker is deployed `--final`.

## Resolution (v0.6, 2026-10-12)

All findings fixed; each `issue_*` reproduction is now a `regression_*` test running the original scenario (SPEC D23–D29, CONTRACTS.md "v0.6 interface changes"). Full suite also re-run against the mainnet PumpSwap + pump-fees binaries and mainnet GlobalConfig/FeeConfig (150/150 at the time).

| ID | Fix | Regression test(s) |
|---|---|---|
| H-1 | Locker accepts `len >= 287`, reads the prefix, cross-checks pool PDA / LP-mint PDA / vault ATAs; short or shifted layouts → `UnknownPoolLayout` | `regression_extend_account_no_longer_bricks_lp_skim`; `locker_tests::regression_skim_works_on_pools_extended_by_pumpswap`, `regression_skim_rejects_fake_or_foreign_pool_data`, `regression_skim_fails_closed_on_unknown_pool_layout` |
| M-1 | Bounded params + reward terms snapshotted per coin (`Coin.rewards`) | `regression_params_changes_cannot_reprice_live_tickets` |
| M-2 | Guardian (`set_pause`, `cancel_params`, `cancel_admin`); `propose_admin` → 48h → `accept_admin` by the new key | `regression_stolen_admin_key_cannot_outrun_the_guardian` |
| M-3 | Curve `sell` never paused; pauses lapse after 7 days | `regression_pause_never_freezes_curve_sells_and_lapses` |
| M-4 | Pyth max age 150 s (bounded 30–300) | `regression_late_pyth_heartbeat_still_files_the_ticket` |
| L-1 | `["pumpswap_signer"]` PDA for buybacks; exact PumpSwap account lists under PDA signatures; `graduate` pins vaults/event authority, no extras | `regression_pumpswap_cpis_carry_no_foreign_accounts` |
| L-2 | Bounds for every param, feed pinned, curve consistency (`graduation_lamports` enforced, D20 continuity) | `regression_params_is_valid_rejects_degenerate_values` |
| L-3 | `GlobalInitialized`, `PauseSet`, `KeepersSet`, `AdminProposed/Accepted/ProposalCancelled` | `regression_admin_changes_emit_events` |
| L-4 | `close_position` | `regression_positions_can_be_closed_when_empty` |
| L-5 | `PAUSE_GRADUATE` | `curve_tests::graduate_is_permissionless_and_has_its_own_pause`, `graduate_pause_lapses_and_escape_hatch_still_opens` |

## Findings

| ID | Sev | Finding | Fix | Test |
|---|---|---|---|---|
| H-1 | High | Anyone can permanently stop LP-fee skimming: PumpSwap's permissionless `extend_account` grows Pool from 287 → 301 bytes (all sampled mainnet pools already 301), and the locker requires exactly 287 → `UnknownPoolLayout` forever. Principal stays safe; the 0.20% LP-fee stream is lost. | Accept `len >= 287`; validate layout via cross-checks (pool PDA, lp_mint PDA, vault ATAs); keep refusing shorter/wrong-discriminator. | `issue_anyone_can_brick_lp_skim_with_pumpswap_extend_account` |
| M-1 | Med | Reward/oracle params apply to live tickets immediately and `is_valid` barely bounds them: a timelocked change (trigger 1.0001x, claim 100%, cap 100%) drains pools 48h later. | Tight bounds and/or snapshot reward terms per coin/ticket. | `issue_timelocked_params_change_reprices_live_tickets` |
| M-2 | Med | `set_admin` is immediate (no accept step / timelock) → a stolen admin key rotates admin and the team can't `cancel_params`. `set_pause`/`set_keepers` also immediate. | Guardian role (cancel + pause), two-step/timelocked `set_admin`. | `issue_admin_rotation_is_immediate_so_timelock_cannot_be_cancelled` |
| M-3 | Med | `PAUSE_TRADE` freezes curve sells (the only venue pre-graduation) indefinitely, including the D13 escape hatch. | Never pause curve `sell`, or pauses expire on-chain. | `issue_pause_trade_freezes_curve_sells_and_escape_hatch_indefinitely` |
| M-4 | Med | Pyth max age 60 s vs a sponsored feed that ages 10–55 s per cycle → honest sells silently lose their ticket (credit consumed). | 120–180 s and/or post a fresh price in the sell tx. | `issue_one_heartbeat_late_pyth_silently_drops_the_ticket` |
| L-1 | Low | `pool_authority` (owner of every vault) signs PumpSwap CPIs with up to 40 caller-chosen extra accounts; safe now, but a malicious PumpSwap upgrade could move other coins' vault tokens. | Dedicated PumpSwap-signer PDA; forward exactly PumpSwap's account count. | `issue_pool_authority_signs_pumpswap_cpi_with_foreign_vaults_attached` |
| L-2 | Low | `is_valid` accepts degenerate values (0 tickets, 0 windows, any feed id, unlimited age, 1-sample oracle, negative stale secs, buyback params that always fail, fee breaking D20 continuity, raise below fee); `graduation_lamports` unused. | Bounds for every param. | `issue_params_is_valid_accepts_degenerate_values` |
| L-3 | Low | `set_pause`, `set_keepers`, `set_admin` (and inits) emit no events → invisible to the event-sourced indexer. | Emit events. | `issue_admin_changes_emit_no_events` |
| L-4 | Low | `Position` can never be closed (~0.0023 SOL rent per wallet per coin locked). | `close_position` when empty and no open tickets. | `issue_positions_are_never_closable` |
| L-5 | Low | `graduate` ignores all pause flags → during a PumpSwap incident a coin's SOL can be pushed into a broken venue. | A pause flag `graduate` respects. | existing `graduate_is_permissionless_and_not_paused` |

Info: third-party PumpSwap/pump admin powers (fees, `admin_cto_pool`, disabling create/withdraw/trade); PUMP incentives stranded in a `pool_authority` ATA; sybil sell/rebuy accepted under D1/D9 (off-chain flagging); malicious keeper/leader sample timing costs ~0.6–0.9× quote reserve to move the median; `ClaimPaid.median` is 0 when paid from the queue; metadata pointer authority None.

## Mainnet parameters

All constants match the D20 derivation; hard-coded PumpSwap, GlobalConfig ADyA8…, pump-fees + FeeConfig 5PHirr…, Pyth receiver and WSOL addresses verified on mainnet. Change: Pyth max age → 120–180 s (M-4). Add lower/upper bounds (M-1, L-2). `graduation_lamports` is unused: enforce or drop. Both programs hard-code each other's id: build together.

## Admin / upgrade setup for mainnet

- `fumpad` upgrade authority: Squads v4 multisig ≥ 3-of-5, hardware keys, Squads time lock ≥ 48h (without it the params timelock is meaningless).
- Admin: separate 3-of-5 multisig; guardian 2-of-3 for cancel + pause (needs M-2); pauses with on-chain expiry (M-3).
- Keepers: up to 3 separate hot keys on separate infra; alert on heartbeat loss and keeper-set changes (needs L-3). Treasury: cold multisig.
- Locker: fix H-1 → verifiable build, publish hash → full suite incl. mainnet PumpSwap fixtures on that exact `.so` → deploy → `set-upgrade-authority --final` before the first graduation.
- Order: deploy fumpad → `initialize_global` (upgrade-authority key) → hand authority to Squads → deploy locker `--final` → open launches.

## Focus list for external auditors

Locker √k math + PumpSwap layout tolerance after H-1 (and `withdraw` across PumpSwap upgrades) · `pool_authority` signer scope in every CPI · D20 graduate lamport flows (caller refund, PDA pre-funding, 50M rent loan) · D10/D12 floor under multi-tx bundles + keeper timing · queue/skip-ahead/escrow at 1024 · `migrate_global` byte transform · params bounds + governance · `Position` observed-balance logic (R-L2) · Pyth parsing/freshness.
