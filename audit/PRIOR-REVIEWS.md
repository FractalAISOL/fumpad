# Prior internal reviews

All reviews below were internal (same team, AI-assisted); none is an external audit. Each finding was reproduced
by a test that passed while the issue existed (`issue_*` on chain, PoC files off chain) and, once fixed, turned into
a test asserting the attack fails (`regression_*`, or the PoC "flipped"). Commit hashes are on `main`.

Sources:
- **FR** — `contracts/FINAL_REVIEW.md`: final pre-mainnet review of the **v0.5 / v0.6** program (own bonding curve,
  PumpSwap, `fumpad_lp_locker`), 2026-10-12. Most of that code was deleted in v0.7 (D30); kept here for the
  findings whose rule carried over.
- **RV** — `contracts/REVIEW-v0.7.md`: internal review of the **v0.7** program at `95c59e9`, 2026-10-13.
  Repros in `contracts/tests/src/review_v07.rs`, run on the mainnet DBC 0.2.1 / DAMM v2 0.2.4 binaries.
- **SR7** — `security-review/REPORT-v0.7.md`: v0.7 off-chain review (services + app) at `95c59e9`, 2026-10-13.
  PoCs in `security-review/v07-poc/`.
- **SR6** — `security-review/REPORT.md`: v0.6 off-chain review at `ff0c4ea`, 2026-10-12. Listed where the code
  still exists in v0.7.

Status values: **Fixed** (fix + regression test on `main`), **Fixed (design)** (resolved by a spec decision),
**Superseded** (the code was removed in v0.7; the v0.7 equivalent is named), **Open**, **Accepted**.

## 1. v0.7 program — REVIEW-v0.7 (RV)

| ID | Sev | Finding | Status | Fix commit | Regression test(s) (`contracts/tests/src/`) |
|---|---|---|---|---|---|
| RV H-1 | High | `graduate` required our locked position to hold ≥ 99.99% of the DAMM v2 pool's liquidity; anyone adding > 0.01% liquidity (permissionless) blocked graduation forever (no claims, no LP-fee split, router dead) | Fixed: position identified by pool + `fee_claimer`-held NFT + fully permanently locked, never by pool share; `claim_lp_fees` accepts any `fee_claimer`-held position of the pool | `c9be557` | `review_v07::regression_third_party_damm_liquidity_cannot_block_graduate`, `review_v07::regression_position_handed_to_fee_claimer_cannot_strand_our_lp_fees` |
| RV M-1 | Med | Hourly attestation cap counted voided / debited tickets and rejected honest attestations until they expired (24 h) | Fixed (design): per-coin leaky bucket that defers (`attested_at` = effective time), never rejects; debits / voids release capacity | `c9be557` | `review_v07::regression_rate_cap_releases_cancelled_tickets_and_never_loses_honest_sells`, `attest_tests::rate_cap_defers_tokens_beyond_the_hourly_cap`, unit `state::coin::tests::rate_cap_defers_and_releases` |
| RV L-1 | Low | A keeper (Position rent payer) could close a Position and reset the wallet's auto-claim opt-out | Fixed: rent payer may close only while `auto_claim_opt_out == 0` | `c9be557` | `review_v07::regression_keeper_cannot_reset_a_wallets_auto_claim_opt_out` |
| RV L-2 | Low | `void_ticket` left the replay marker, so a wrongly attested honest trade could never be re-attested | Fixed: `void_ticket(reason, reopen)`; reopened marker accepts one corrected message (different hash) | `c9be557` | `review_v07::regression_voided_attestation_can_be_corrected`, `attest_tests::guardian_voids_inside_the_challenge_window_only` |
| RV I-1 | Info | Leftover withdrawn by a third party recorded as 0 | Fixed: `leftover_tokens` = vault balance − `buyback_tokens` | `c9be557` | `review_v07::regression_leftover_withdrawn_by_third_party_is_recorded` |
| RV note | — | `record_samples` failed the whole batch when one coin turned `Complete` | Fixed: `Complete` groups skipped | `c9be557` | `review_v07::regression_record_samples_skips_a_complete_coin` |
| RV note | — | `Graduated.surplus` counted a pre-funded `fee_wsol` | Fixed: excluded from surplus and budget, returned to caller | `c9be557` | `review_v07::regression_graduated_surplus_ignores_a_prefunded_fee_wsol` |
| RV note | — | DAMM v2 `pool_status` / `layout_version` / `collect_fee_mode` not read | Partly fixed: router refuses a disabled pool (`PoolDisabled`); **samples and buybacks still don't check** (THREAT-MODEL G2) | `c9be557` | `review_v07::regression_router_refuses_a_disabled_damm_pool` |
| RV note | — | Pre-grad buyback trusted one keeper sample ≤ 60 s | Fixed for market manipulation (see SR7 L5); residual: a compromised keeper can feed 4 samples over 60 s | `418b24c`, `5cac136` | `oracle_buyback_tests::regression_l5_one_moved_sample_cannot_steer_the_pregrad_guard`, `regression_l5_in_band_ratchet_cannot_make_the_buyback_overpay`, `pregrad_buyback_liveness_under_honest_sampling`, unit `pregrad_ring_median_needs_count_and_span` |
| RV note | — | `register_coin` accepts any pool on an allow-listed config whose creator signs | Fixed (opt-in): `Params.launch_signer` co-signature; DBC verified to give the min fee to one swap per launch tx | `c9be557` | `review_v07::regression_launch_signer_binds_register_coin`, `review_v07::verify_dbc_min_fee_goes_to_one_swap_per_launch_tx` |
| RV note | — | Cluster tag is any u8; devnet / mainnet must not share program id + tag | Accepted / documented (different program ids) | — | `attest_tests::record_binding_rules` (wrong program id / cluster rejected) |
| RV note | — | Stranded value: DAMM position rewards, DBC partner pool-creation fees, partner fees of unregistered pools | Open / accepted (THREAT-MODEL G4) | — | — |
| RV note | — | `close_position` > ≈ 28 tickets needs v0 + ALT; > 64 never closable | Accepted (G5) | — | `rewards_tests::regression_positions_can_be_closed_when_empty` |
| RV note | — | Guardian can `set_pause(0)` an admin pause and cancel every admin proposal | Accepted (v0.6 M-2 design) | — | `admin_tests::regression_stolen_admin_key_cannot_outrun_the_guardian` |

Areas RV reported as reviewed without findings: Ed25519 introspection (position, self-reference, identical
messages, domain + length per kind, distinct keys, 6 h freeze, threshold floor, CPI invocation refused), PDA-signed
CPIs (exact pinned lists), `claim_fees` launch-flag timing, custody and the Coin lamport invariant, rent payers and
close paths, claims / queue / escrow / auto-claim vs v0.6, governance, Meteora oracle offsets.

## 2. v0.7 off-chain — REPORT-v0.7 (SR7)

PoCs: `security-review/v07-poc/*.test.ts` (flipped to assert the fix in `92737ba`).

| ID | Sev | Finding | Status | Fix commit | Regression test(s) |
|---|---|---|---|---|---|
| V7-H1 | High | Rebuy debits before the sell's attestation landed were lost (`ticketAddress = null` forever) → "sell, buy back next slot" kept a full ticket | Fixed | `e01899c` | PoC `rebuy-before-attestation`; `engine/test/engine.test.ts` "rebuy debits carry the attested ticket PDA, also for buys BEFORE the attestation landed (V7-H1)"; `keeper/test/records.test.ts` "V7-H1 rebuy before attestation" |
| V7-H2 | High | Any engine issue (1-unit vault donation in a swap tx, `SetAuthority(AccountOwner)`, non-swap vault movement, unmappable ticket) froze all attestations of a coin forever | Fixed: issues scoped to tx (+ one D10 window) / wallet; non-swap vault flows accounted; per-token-account owner deltas | `e01899c` | PoCs `vault-donation-freeze`, `owner-change-negative-balance`; `meteora/test/vaultflow.test.ts` (all); `engine.test.ts` "negative balance … fails closed for THAT wallet only (V7-H2)", "parser issue on our pool …", "an attested ticket the engine can't map blocks only its owner (V7-H2)"; `golden.test.ts` "a 1-unit donation into the DBC base vault … (V7-H2)"; `records.test.ts` "V7-H2 scoped cut-off" |
| V7-M1 | Med | Unsigned board status rows ("dropped") let one keeper or a DB writer suppress all attestations | Fixed: status is a hint; "landed" = consumed marker at `finalized`; per-attestor DB roles + RLS | `e01899c` | PoC `board-status-suppression` (a); `keeper/test/attestor.test.ts` "board status is only a hint (V7-M1, L4)" |
| V7-M2 | Med | `PoolNotOfCoin` for a DAMM sell before `graduate` was treated as permanent | Fixed: DAMM sells signed only after `Coin.damm_pool` is set; retryable errors back off | `e01899c` | PoC `board-status-suppression` (b); `attestor.test.ts` "DAMM v2 sells wait for graduate (V7-M2)" |
| V7-M3 | Med | App allow-list didn't bound `min_out` (came from the API quote) → silent sandwichable trades | Fixed: local quote floor; `amountIn` / `minOut` in `SilentPolicy` | `ec3d416` | PoC `app-allowlist-min-out`; `app/src/chain/allowlist.test.ts` "V7-M3: refuses a min_out below the app's own quote floor …" |
| V7-M4 | Med | Fresh tokens rode on matured credit (sell draws matured first) | Fixed (design, SPEC Clarification 21): pending sold first | `e01899c` | PoC `fresh-tokens-ride-matured`; `engine.test.ts` "fresh tokens can't ride on matured credit (V7-M4)" |
| V7-M5 | Med | Hermes 404 cached forever; cross-keeper Pyth selection determinism unverified | Fixed: only successes cached, 404 re-asked; pinned deterministic selection | `e01899c` | PoC `hermes-null-cache`; `engine/test/pyth.test.ts` (all) |
| V7-M6 | Med | Keeper liveness DoS (full re-crawl every tick, serial coins, unbounded caches) | Fixed: incremental crawl, per-coin RPC budget, prioritised parallel coins, LRU; launch co-signer on chain. Residual: open accounts cost one call per tick | `e01899c` (+ `c9be557` on chain) | PoC `crawl-amplification`; `engine/test/fetch.test.ts` "incremental mint crawl (V7-M6)"; `keeper/test/derive.test.ts` "V7-M6 …"; `attestor.test.ts` "coin scheduling (V7-M6)" |
| L1 | Low | Launch binding off-chain only | Fixed: `Params.launch_signer` + API co-signs | `c9be557`, `824cf86`, `57bc8d1` | `review_v07::regression_launch_signer_binds_register_coin`; `services/api/test/launch-signer.test.ts`; local e2e (unsigned self-launch refused) |
| L2 | Low | Indexer treated unregistered pools on our config as FUMPAD's | Fixed: gated on `CoinRegistered` | `e01899c` | `services/indexer/test/meteora.test.ts` "L2: a pool on a FUMPAD config whose mint was never registered …" |
| L3 | Low | `void_ticket` referenced no mint / coin → voids missed after a restart | Fixed: `void_ticket` takes `coin` + `mint`; services rely on it | `c9be557`, `824cf86` | `keeper/test/derive.test.ts` "L3: a guardian void is in the very first derivation after a restart" |
| L4 | Low | "Landed" decided at `confirmed` | Fixed: consumed marker at `finalized` | `e01899c` | `attestor.test.ts` "own landing at confirmed: no resend while it finalizes …" |
| L5 | Low | Pre-grad buyback guard followed a movable spot | Fixed: off-chain randomized timing + TWAP; on-chain ring median | `e01899c`, `418b24c` | `keeper/test/buyback-guard.test.ts`; `oracle_buyback_tests::regression_l5_*` |
| L6 | Low | CSP `img-src https:` / `'unsafe-inline'`; same-context scripts | Fixed (image part): image proxy, CSP without `https:`; same-context assumption documented in `app/LAUNCH.md` | `87d0a18`, `ec3d416` | `services/api/test/img.test.ts`; `app/src/security/headers.test.ts` "V7-L6: …" |
| L7 | Low | Watcher alert gaps (unattested sells, engine issues, 6 h cooldown) | Fixed | `e01899c`, `824cf86` | `keeper/test/watcher.test.ts` "watcher liveness alerts (L7)", "guardian voids …" |
| L8 | Low | RPC with incomplete history diverges permanently | Fixed: first-available-block floor vs coin launch; pool creation must precede `launch_slot` | `e01899c` | `derive.test.ts` "L8: …" (2 tests) |
| Info | — | Prelaunch gate is host-based (`fumpad.vercel.app` previews serve the full app) | Accepted | — | `app/src/prelaunch/gate.test.ts` |

## 3. v0.5 / v0.6 program — FINAL_REVIEW (FR)

| ID | Sev | Finding (v0.6 code) | Status in v0.7 | Fix commit (v0.6) | v0.7 regression test |
|---|---|---|---|---|---|
| FR H-1 | High | LP locker required exactly 287-byte PumpSwap pools; permissionless `extend_account` bricked LP-fee skims | Superseded: locker deleted (D36: Meteora permanent lock). v0.7 analogue = RV H-1 | `3d74b2d` | (see RV H-1) |
| FR M-1 | Med | Reward / oracle params repriced live tickets; weak bounds | Fixed and carried over: `Params::is_valid` bounds every field; reward terms + fee split snapshotted per coin | `58cd808` | `admin_tests::regression_params_changes_cannot_reprice_live_coins`, `admin_tests::params_timelock_bounds_and_cancel` |
| FR M-2 | Med | `set_admin` immediate; no guardian | Fixed and carried over: guardian; `propose_admin` → 48 h → `accept_admin` | `fa2c696` | `admin_tests::regression_stolen_admin_key_cannot_outrun_the_guardian` |
| FR M-3 | Med | `PAUSE_TRADE` froze curve sells indefinitely | Fixed and carried over: router sells never paused; pauses lapse after 7 d | `fa2c696` | `router_tests::regression_pause_never_freezes_router_sells_and_lapses`, `admin_tests::regression_pause_semantics_and_expiry` |
| FR M-4 | Med | Pyth max age 60 s dropped honest tickets | Superseded: Pyth is off-chain in v0.7 (engine picks the update ≤ block time within `max_price_age_secs`, default 60 s, bounds 30–300; program checks the attested age) | `58cd808` | `engine/test/engine.test.ts` "Pyth: greatest publish_time ≤ block time within 60 s …"; `attest_tests::record_binding_rules` |
| FR L-1 | Low | `pool_authority` signed PumpSwap CPIs with caller-chosen extra accounts | Superseded; v0.7 rule: every PDA-signed CPI forwards an exact pinned list | `998d4d2` | `oracle_buyback_tests::regression_pda_signed_cpis_carry_no_foreign_accounts`, `fees_tests::fee_claims_reject_spoofed_accounts` |
| FR L-2 | Low | `is_valid` accepted degenerate values | Fixed and carried over (+ v0.7 attestation params) | `58cd808` | `admin_tests::regression_params_is_valid_rejects_degenerate_values`, unit `state::global::tests::defaults_valid_and_bounds` |
| FR L-3 | Low | Admin changes emitted no events | Fixed and carried over | `fa2c696` | `admin_tests::regression_admin_changes_emit_events` |
| FR L-4 | Low | Positions never closable | Fixed and carried over (+ RV L-1) | `e6e8fab` | `rewards_tests::regression_positions_can_be_closed_when_empty` |
| FR L-5 | Low | `graduate` ignored pauses | Fixed and carried over: `PAUSE_GRADUATE` (`migrate_pool`, `graduate`) | `fa2c696` | `admin_tests::regression_pause_semantics_and_expiry` |
| FR info | — | Sybil sell / rebuy (D1 / D9); keeper sample-timing cost ≈ 0.6–0.9× quote reserve to move the median; metadata pointer authority | Accepted (THREAT-MODEL R3, R7) | — | `admin_tests::regression_fallback_samples_never_decide_the_median`, unit `state::observations::tests::*` |

## 4. v0.6 off-chain — REPORT (SR6), items whose code still exists

| ID | Sev | Finding | Status | Fix commit | Regression test(s) |
|---|---|---|---|---|---|
| H-1 | High | Indexer webhook accepted forged transactions | Fixed: secret required, webhook = hint re-fetched from RPC | `a556b83` | `services/indexer/test/webhook.test.ts` "H-1 webhook forgery is rejected"; PoC `security-review/services-poc/webhook-forgery.test.ts` (v0.6) |
| H-2 | High | `trustProxy: true` → spoofable client IP | Fixed: `TRUST_PROXY_HOPS` | `a556b83`, `e9a4642` | `services/api/test/security.test.ts` "H-2 client IP / rate limits" |
| H-3 | High | Coins routed by symbol; squatting | Fixed: route by mint | `a0a7c20`, `e9a4642`, `3f36c05` | `api/test/security.test.ts` "H-3 Repo resolution", "L-5 health, L-3 validation, H-3 coin routing" |
| H-4 | High | Keeper `process_queue` blocked behind non-fitting head entries | Fixed: SDK plans the program's skip-ahead walk | `eb15c88`, `a556b83` | `keeper/test/queue.test.ts` "H-4 process_queue planning" |
| H-5 | High | No CSP while the embedded wallet signs silently | Fixed: CSP + headers (V7-L6 tightened images) | `44f62d3`, `c48f2c7` | `app/src/security/headers.test.ts` |
| M-1 | Med | Launch tx not bound to the user's mint / metadata / first buy | Fixed | `afb4f21` | `app/src/chain/launch.test.ts` "checkLaunchBinding" |
| M-2 | Med | Vanity pool drainable; RPC inside a DB tx | Fixed: wallet-signed launch prepare | `e9e9ce5`, `a556b83` | `services/api/test/launch-auth.test.ts` |
| M-3 | Med | SSRF via metadata URI | Fixed | `a556b83` | `services/indexer/test/ssrf.test.ts` |
| M-4 / M-5 | Med | Finalizer rollback on one miss; poller cursor skipping | Fixed | `a556b83` | `services/indexer/test/reorg-cursor.test.ts` |
| M-6 | Med | WebSocket fan-out without global cap | Fixed | `a556b83` | `api/test/security.test.ts` "M-6 global WebSocket cap" |
| M-7 | Med | Keeper spend unbounded | Fixed (jobs keeper; attestor liveness see V7-M6) | `a556b83` | `keeper/test/queue.test.ts` "M-7 spend controls" |
| M-8 | Med | Frontend RPC key public / fallback | Fixed: restricted key / guidance | `293e2dd` | `app/src/security/rpc.test.ts` |
| M-9 | Med | Slippage from fresh state, not the shown quote | Fixed, then tightened by V7-M3 | `570cbb7`, `ec3d416` | `app/src/chain/limits.test.ts` "slippage from the shown quote (M-9)" |
| L-1 … L-11 | Low | metadata image URLs, path encoding, validation, grinder DB TLS / shared role, health detail, webhook limits, mint co-signature check, session cap, Docker root, single keeper, cache wipes | Fixed | `a556b83`, `f7eb3a7`, `afb4f21`, `570cbb7` | `api/test/security.test.ts`, `indexer/test/webhook.test.ts` "L-6 …", `app/src/chain/limits.test.ts` "L-8", `test/integration/keeper-lock.test.ts` (L-10) |

## 5. Not yet reviewed internally

- Squads handover tooling (`services/scripts/ops/multisig.ts`) — exercised by `npm run multisig:rehearsal` (33/33),
  not security-reviewed.
- Mainnet bootstrap tooling (`services/scripts/mainnet/*`) — exercised by `npm run mainnet:rehearsal` (37/37).
- No fuzzing campaign and no formal verification has been done on any component.
