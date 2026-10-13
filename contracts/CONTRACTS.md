# FUMPAD contracts — working guide (v0.7, Meteora)

Specs: `../docs/SPEC-v0.7-meteora.md` (source of truth for v0.7) on top of `../docs/SPEC.md` v0.6. Interface for the
services / app: **`INTERFACE-v0.7.md`** (instructions, accounts, PDAs, layouts, events, errors, attestation bytes).
Concept: `../docs/concept-overview.pdf`.

## Program
| Program | Id | Upgradeable | What |
|---|---|---|---|
| `fumpad` | `5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb` (new in v0.7, D39; devnet/test id; mainnet gets its own keypair; **not deployed anywhere**) | yes (Squads multisig) | coins on Meteora DBC → DAMM v2, router, fee claims + split, buybacks, graduation bookkeeping, attested tickets, claims/queue/escrow, oracle samples, governance |

`fumpad_lp_locker`, the own bonding curve, PumpSwap, graduate-to-PumpSwap, the D13 escape hatch, `register_holdings`
and on-chain hold/rebuy/reference bookkeeping are **deleted** (SPEC v0.7 D30/D31). The program keypair is
`target/deploy/fumpad-keypair.json` (git-ignored — back it up before any deploy; the old `ASVE6Nk8…` is not reused).

External programs (raw CPI with hard-coded discriminators and byte offsets, no Meteora crates — `src/external/meteora.rs`):
Meteora DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (mainnet 0.2.1: `create_config`, `EvtSwap`/`EvtSwap2`) and
DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` (0.2.4), Ed25519 precompile, Token-2022, SPL Token, ATA. Nothing
requires DBC 0.2.2 (`create_config2`, `EvtSwap3`): FUMPAD configs are created with `create_config`, which 0.2.2 still
accepts (the spike used `create_config2` on devnet; `create_config` on the 0.2.2 bytecode is UNVERIFIED).

## Build & test
```
export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
anchor build                                   # 0 warnings; IDL → target/idl/fumpad.json
cargo test -p fumpad --lib                     # pure unit tests (attestation encoding, Ed25519 parsing, queue, oracle, sizes)
cargo test -p tests                            # LiteSVM integration tests on the MAINNET DBC + DAMM v2 binaries
cargo test -p tests cu_report -- --nocapture   # CU + tx-size + rent tables
cargo test -p tests derive_exact_curves -- --ignored --nocapture   # re-derive the exact-8% DBC curves (after a DBC upgrade)
UPDATE_VECTORS=1 cargo test -p tests vectors   # regenerate tests/vectors/*.json (otherwise checked byte for byte)
```
Fixtures (`tests/fixtures/`, dumped read-only from mainnet; no mainnet transaction was sent):
`dbc_mainnet.so` (sha256 `4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b`, programdata dump incl.
padding), `damm_v2_mainnet.so` (`4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b`),
`damm_v2_migration_config_mainnet.json` (`A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck`, the DAMM v2 config DBC uses
for `Customizable`), `pyth_sol_usd_mainnet.json` (attestation USD vectors), `wsol_mint.json`. Re-dump before mainnet:
Meteora can upgrade either program at any time (D38).

Vectors for the services (`tests/vectors/`): `attestation.json` (sell + rebuy messages, deterministic keeper keys,
signatures, Ed25519 instruction data, consumed/position/ticket PDAs, USD from the Pyth fixture) and `dbc_config.json`
(exact DBC `create_config` instruction data for the mainnet and devnet FUMPAD configs).

## v0.7 at a glance
- **Launch** (SPEC §2): API-built tx = DBC `initialize_virtual_pool_with_token2022` (vanity mint signs) → creator ATA →
  creator's top-level DBC `swap2` (gets the min fee) → `register_coin`. Measured: **1,057 bytes**, 182k CU (incl. DBC).
  `register_coin` requires the pool's config on `Global.configs` (48h-timelocked allow-list; every config re-checked
  for the FUMPAD shape: fee claimer / leftover receiver = our PDAs, WSOL, Token-2022 6 dec, immutable authority, 100%
  partner permanent lock, Customizable DAMM v2 `OnlyB`, creator fee 0, fixed supply, slot activation), signer = pool
  creator, pool not completed; it creates the reward vault ATA and snapshots reward terms + fee split. With
  `Params.launch_signer` set, the API's launch key must co-sign `register_coin` (off-chain review L1). DBC gives
  the min fee to one swap per pool-creation tx only (verified on the mainnet binary), so no tx introspection.
- **DBC config** (`tests/vectors/dbc_config.json`): 1B supply, 85 SOL raise (devnet 0.85), 99% → 1.25% fee scheduler
  over 8 × 1 slot, `enable_first_swap_with_min_fee`, **1% migration fee** (DBC only supports whole percents; D34 said
  ≈0.75%), migrated pool 125 bps `OnlyB`. The curve is re-derived on the real binary so the reward pool is **exactly
  80,000,000.000000 tokens** on a single-swap completion (`config_tests::derived_configs_are_exact_and_d17_shaped`);
  start MC 30.33 SOL, ×14.69 price to graduation (D17 shape). Every extra swap rounds its output down in the pool's
  favour, so a real trading path leaves 0 to a few base units (10⁻⁶ token each) of dust ON TOP (never less than 80M;
  tests assert ≤ 1,000 base units).
- **Router** `buy`/`sell`: user-signed DBC/DAMM `swap2` pass-through (15/14 ≤ n ≤ 24 accounts), canonical base ATA,
  trader-owned WSOL, referral None, measured deltas + `RoutedTrade`. `PAUSE_TRADE` stops buys only.
- **Fees**: `claim_fees` (DBC partner fees) / `claim_lp_fees` (any `fee_claimer`-held position of the coin's DAMM v2
  pool — normally the DBC-created locked one; REVIEW-v0.7 H-1) signed by `fee_claimer` with
  pinned account lists, claimed into a transient WSOL PDA and unwrapped into the Coin. First DBC claim after the 8-slot
  window → 100% buyback (D33); then 50/30/20 (platform + creator exact floors, remainder buyback).
- **Buyback**: `buyback` PDA as payer, output straight into the reward vault, venue list pinned exactly. Pre-grad:
  keeper-only, spot ±3% of BOTH the median of the coin's recent keeper samples (`Coin.pregrad_ring`: ≥ 4 within 5 min
  spanning ≥ 60 s) and its last keeper sample (≤ 60 s), slice ≤ 0.5% of the curve's quote reserve, never
  completes the curve. Post-grad: v0.6 rules on the DAMM v2 pool (30-min median ±3%, 0.5% of `token_b_amount`).
- **Graduation**: `migrate_pool` (our wrapper of DBC `migration_damm_v2`, records the caller's flash-rent cost) and
  `graduate` (verifies the DAMM v2 pool + our position — pool, `fee_claimer`-held NFT, fully permanently locked; never
  its share of the pool (REVIEW-v0.7 H-1) — `withdraw_leftover` (recorded even if a third party withdrew it), partner migration fee +
  surplus, then refunds → prefunds observations + claim queue → platform). Split in two because the combined account
  list (≈ 37 keys) doesn't fit a legacy transaction; each fits (1,081 / 1,045 bytes). Meteora's keepers may migrate
  directly; `graduate` then skips that step.
- **Tickets** (D31): `attest_sell` / `attest_rebuy` read the record from the Ed25519 precompile instruction right
  before them (2 distinct active keepers; new keys frozen 6h), consumed-marker PDAs, per-coin rate cap as a leaky
  bucket that defers tickets over 20%/h of supply (their challenge window starts later) and never rejects (M-1),
  challenge window (`void_ticket`; `reopen` lets the corrected record of the same trade be attested once, L-2),
  `close_consumed` only after the ticket is closed and the trade is older than 7 days. Rebuy debits and voids release
  rate-cap capacity. Only the wallet closes a Position that opted out of auto-claim (L-1).
- **Claims / queue / escrow / auto-claim**: v0.6 rules, paying from `ATA(reward_pool, mint)`, plus the challenge window.

## Sizes and rent (fresh layouts, D39)
Rent measured in LiteSVM 0.18 with the mainnet feature set (equal to `solana rent` from CLI 4.1.2). At the older
6,960 lamports per byte the queue would cost ≈0.571 SOL; which rate mainnet charges at deploy time is UNVERIFIED.

| Account | Bytes | Rent (SOL) | Paid by |
|---|---|---|---|
| `fumpad.so` program data (`anchor build`, inliner flags) | 754,288 (+45) | ≈3.833 | deployer |
| Global | 1,044 | 0.00595 | admin (init) |
| Coin | 546 | 0.00342 | creator (`register_coin`) |
| Reward vault (Token-2022 ATA) | 170 | ≈0.00207 | creator (`register_coin`) |
| Position | 315 | 0.00225 | attesting keeper |
| Ticket | 276 | 0.00205 | attesting keeper |
| Consumed | 98 | 0.00115 | attesting keeper (re-used by a corrected re-attestation) |
| ClaimQueue (1024) | 81,976 | 0.41709 | prefunded by `graduate` from the migration fee (D34) |
| Observations (256) | 8,280 | 0.04271 | prefunded by `graduate` |

## Compute units (worst cases, `cu_report`, mainnet binaries; ±2k run to run from PDA bumps)
| Instruction | CU | Tx bytes | Compute budget |
|---|---|---|---|
| launch tx (DBC init + ATA + creator swap2 + `register_coin`) | 182k | 1,058 (+32 with a launch co-signer key, +64 its signature) | 300k |
| `buy` router DBC / DBC PartialFill completing the curve / DAMM v2 | 94k / 94k / 55k | — | default (200k) |
| `sell` router DBC / DAMM v2 | 62k / 47k | — | default |
| `claim_fees` (DBC) | 62k | — | default |
| `claim_lp_fees` (DAMM v2) | 67k | — | default |
| `execute_buyback` DBC (pre-grad, 4-sample median, creates the WSOL ATA) / DAMM v2 (full 30-min median) | 115k / 90k | — | default |
| `migrate_pool` (DBC migration CPI incl. DAMM v2 pool + lock) | 176k | 1,081 | set ≥ 400k |
| `graduate` | 110k | 1,045 | set ≥ 200k |
| `init_observations` / `init_claim_queue` × 9 (one tx) | 13k / 61k | — | default |
| `record_samples` 1 coin (pre-grad / DAMM) / 5 coins / 10 coins | 15k / 15k / 46k / 84k | — / — / 773 / 1,268 | 10 coins need v0 + ALT |
| `attest_sell` new position / existing position | 40k / 35k | 985 (with the Ed25519 ix) | default |
| `attest_rebuy` queued ticket on a 1023-entry queue / voiding the front entry | 40k / 34k | — | default |
| `claim` paid now behind 1022 entries / queued at the end / queued at the FRONT of 1023 | 72k / 72k / 71k | — | default |
| `claim_for` paid now / escrowed (1022 scanned) | 79k / 88k | — | default |
| `process_queue` full-queue walk / 13 paid / 13 escrowed on a full queue | 97k / 225k / 415k | — / — / 1,849 | 13 entries need v0 + ALT and ≥ 600k; a legacy tx carries 5 entries |
| `withdraw_escrow` / `close_ticket` (full queue) / `void_ticket` (reopen) / `close_consumed` / `close_position` / `set_auto_claim` | 27k / 20k / 25k / 10k / 9k / 7k | — | default |

## Build profile & program size (approach unchanged; the measurements below are v0.5/v0.6 history)
`anchor build` = `cargo build-sbf --tools-version v1.57 --arch v3` (Anchor 1.2.1 defaults; platform-tools v1.57).
- `Cargo.toml` `[profile.release]`: `opt-level` 3 (default), `lto = "fat"`, `codegen-units = 1`, **`overflow-checks = true` (must stay)**. SBF is already `panic = abort`; the deployed `.so` is stripped by `cargo build-sbf`.
- `.cargo/config.toml` (SBF targets only, `cfg(target_os = "solana")`; host builds/tests/IDL unaffected): `-C llvm-args=-inline-threshold=60 -inlinehint-threshold=60 -unroll-threshold=50`. Builds without the file are still correct, just ~22% bigger — keep it for `anchor build --verifiable` / `solana-verify` too (it lives in the repo, so they pick it up).
- Feature flags: none in the deployed binary. `idl-build` is only enabled by the IDL step (IDL output byte-identical before/after this tuning); `no-log-ix-name` was rejected (−2.5 KB, drops the `Instruction: X` log lines).
- Code (fumpad only; the locker source is untouched): events go through `emit_event!(ctx, Event { .. })` (lib.rs) → one non-generic `events::emit_cpi_data` — byte-identical self-CPI to Anchor's `emit_cpi!`, which inlined the whole CPI at ~30 sites; `logic::plan_rebuy` orders ≤5 tickets with a stable insertion sort instead of std `sort_by` (same order; unit test checks it against `sort_by` on 2,000 random sets).

| Build | `fumpad.so` | rent | `fumpad_lp_locker.so` | rent |
|---|---|---|---|---|
| before (O3, no flags) | 1,086,184 | 5.519 SOL | 209,960 | 1.067 SOL |
| tuned (v0.5) | 800,672 (−26.3%) | 4.068 SOL | 184,216 (−12.3%) | 0.937 SOL |
| **v0.6** (final-review fixes, same build profile) | **835,544 (+4.4%)** | **4.245 SOL** | **187,512 (+1.8%)** | **0.953 SOL** |

Rent = `solana rent <len + 45>` (program-data header), refundable on close; `solana program deploy` sizes the
program-data account to the `.so` — pass `--max-len` for upgrade headroom, or `solana program extend` later.

What was measured (deterministic keys, `cu_report` + `venue_tests::compute_units_and_batch_size` + `curve_tests::snipe_tax_compute_units` + the locker skim test; sizes in bytes):
| Change | fumpad.so | locker.so | CU effect |
|---|---|---|---|
| `opt-level = "z"` | 824,240 | 182,632 | **+17–200%** (record_samples +90%, close_ticket +200%) — rejected |
| `opt-level = "s"` | 904,832 | 189,040 | **+8–54%** (buy +23%, record_samples +54%) — rejected |
| `opt-level = 1` | 1,115,440 | 216,600 | +10–60% and bigger — rejected |
| `opt-level = 2` | 1,059,552 | 205,736 | ±0.1% (−2.5% size; superseded, worse than O3 combined with the flags) |
| `lto = "thin"` / `lto = false` | 1,086,872 / 1,086,120 | 209,960 | none — no gain |
| locker `[profile.release.package] opt-level = "s"/"z"` (with flags) | — | 186,120 / 184,816 | bigger than the flags alone — rejected |
| `no-log-ix-name` feature | −2,568 | −176 | removes log lines — rejected |
| code: `emit_event!` + insertion sort (O3, no flags) | 1,035,560 | 209,960 | −5.7…0% (event bytes copied once instead of byte-by-byte) |
| code + inline 75 / hint 75 | 877,960 | 197,176 | −4…+4% |
| code + inline 50 / hint 50 / unroll 50 | 800,624 | 184,256 | −2.4…+6.3% |
| code + inline 35 / hint 35 | 821,224 | 195,584 | up to +10% — rejected |
| **code + inline 60 / hint 60 / unroll 50 (chosen)** | **800,672** | **184,216** | **−2.5…+5.8%** |

CU before → after (chosen build, same keys): curve `buy` 45,674 → 46,619 (+2.1%), first buy (ATA + position) 76,414 → 78,821 (+3.1%), `sell` (creates ticket) 54,516 → 55,560 (+1.9%), `swap_buy` 145,453 → 148,772 (+2.3%), `swap_sell` 127,599 → 130,876 (+2.6%), `claim` paid now 56,721 → 57,068 (+0.6%), `claim_for` escrowed 87,471 → 88,754 (+1.5%), `process_queue` full queue 13 paid 301,330 → 293,686 (−2.5%) / 13 escrowed 400,777 → 405,678 (+1.2%), `record_samples` 10 coins 108,366 → 110,595 (+2.1%), `graduate` 277,477 → 283,002 (+2.0%, budget 400k), `execute_buyback` 143,255 → 144,728 (+1.0%), `close_ticket` full-queue scan 22,479 → 23,793 (+5.8%), locker `skim` 79,637 → 80,859 (+1.5%), `settle_lp_fees` 20,320 → 20,488 (+0.8%). Every row stays under its budget in the compute table below.


**v0.7:** same profile and `.cargo/config.toml` inliner flags (kept; `anchor build` picks them up); `fumpad.so` =
**738,952 bytes** (v0.6: 835,544 with the curve + PumpSwap code; the locker is gone). 0 warnings.
After the REVIEW-v0.7 fixes: **747,616 bytes** (+8,664; rent +0.044 SOL). CU deltas of the fixes (same machine,
`cu_report`, ±2k PDA-bump noise): `void_ticket` 15.4k → 24.8k (coin + consumed accounts, rate-cap release, reopen),
`attest_rebuy` +2.9k (rate-cap release), `claim_lp_fees` +3.2k (pool check of the position), `graduate` +3k,
`attest_sell` unchanged within noise (the bucket arithmetic is cheaper than the sliding hour; +sha256 of the message),
everything else within noise.

## Deploy (v0.7, order matters — nothing is deployed yet)
1. Deploy `fumpad` (devnet: id `5YMF…S9Fb`; **mainnet: its own fresh keypair + `declare_id!`** — never the devnet
   id; upgrade authority → Squads ≥ 3-of-5 with a ≥ 48h time lock — transfer it AFTER step 3, init needs the key).
2. Create the FUMPAD DBC config with `create_config` using `tests/vectors/dbc_config.json` (new config keypair).
3. `initialize_global(admin, treasury, cluster_tag (0 mainnet / 1 devnet), params, keepers)` from the
   upgrade-authority key, with the DBC config as a remaining account. **Bootstrap:** the 3 keepers (separate
   infra/RPCs) attest at once (`keeper_added_at = 0`, no 6h freeze) and the config is allow-listed at once (no 48h
   timelock; validated like `execute_config` add) — only the upgrade authority can initialize and it could replace
   the program anyway. Every later `set_keepers` (6h freeze for new keys) and `queue_config` (48h) keeps its delay.
   Set `params.launch_signer` to the API's launch co-signer key (or queue it later: 48h) so only API-built launch txs
   register. Devnet: `services/scripts/devnet/bootstrap-v07.ts` does 2–3 (+ funding, verification); runbook
   `services/DEPLOY-v07.md`; rehearsed locally by `npm run bootstrap:rehearsal` (services/).
4. `propose_admin(admin, treasury, guardian)` → 48h → `accept_admin` to hand the guardian to its own multisig.
5. Open launches. Keepers: `claim_fees` right after each coin's 8-slot window, pre-grad samples + buybacks, attestations
   (finalized txs only), `migrate_pool` + `graduate` + `init_observations` + 9 × `init_claim_queue`, post-grad samples,
   `claim_lp_fees`, buybacks, auto-claim, `process_queue`, `close_ticket`, `close_consumed`.

## Open risks (v0.7)
- Meteora's single upgrade authority can change DBC / DAMM v2 (fees, locks, layouts); DAMM v2 operators can disable
  a pool or change its fee (D38). fumpad fails closed on the layouts it reads (owner + discriminator + length); an
  account-list change needs a client update (router) or a program update (pinned PDA-signed lists).
- The pre-graduation buyback guard (L5) is the median of the coin's last 5 keeper samples (≥ 4 within 5 min spanning
  ≥ 60 s) and spot must also agree with the latest sample, so one sample at a moved spot (or a +band ratchet per
  sample) can't steer it. A pump held through ≥ 3 keeper samples (≥ ~40 s at a 20 s cadence; ~80 s at the keeper's
  40 s cadence) does move the median; the 0.5%-of-quote-reserve slice and the ±3% band bound each buyback. Samples
  stay keeper-only: a compromised keeper key can still push 4 samples over 60 s (REVIEW-v0.7 note).
- Tickets are only as good as the 2-of-3 keeper re-derivation (D31): the 6h challenge window + guardian `void_ticket`
  and the per-coin rate cap bound a compromised keeper pair; nothing on-chain re-checks hold time, rebuys or the
  D10/D12 ticket price. Since M-1 the cap defers instead of rejecting: a compromised pair can push every later ticket
  of a coin back (claimable later, never lost) until the guardian pauses `PAUSE_ATTEST`; capacity released by voids
  and rebuy debits is re-used at the end of the backlog, so a single hour can briefly see up to ≈ 2× the cap.
- `register_coin` accepts any pool on an allow-listed config whose creator signs unless `Params.launch_signer` is
  set (off-chain review L1) — set it before opening launches.
- `graduate` may record a third-party position that was locked and handed to `fee_claimer` before it (the DAMM NFT
  account has no ImmutableOwner); harmless for fees (`claim_lp_fees` takes any `fee_claimer` position of the pool),
  but `Coin.damm_position` is then not "the" 100% position — keepers claim LP fees with the NFT from the migration.
- A deferred ticket whose guardian void comes late may leave less than `max_attest_age` for the corrected
  re-attestation (the trade's age counts from `block_time`).
- The 8% reward pool is exact for a single-swap completion; real paths add rounding dust on top (tests: ≤ 1,000 units).
- Mainnet rent rate at deploy time (sizes table) — UNVERIFIED.

## v0.7 review fixes (REVIEW-v0.7.md, 2026-10-13)
H-1, M-1, L-1, L-2, I-1 fixed, plus the review notes (samples skip `Complete` coins, `Graduated.surplus` with a
pre-funded `fee_wsol`, router `PoolDisabled`, cluster ids) and the contract items of the off-chain review (L1 launch
co-signer `Params.launch_signer`; L3 `void_ticket` references `coin` + `mint`, `TicketVoided.coin`). Interface
changes: `INTERFACE-v0.7.md` §8 (changelog). Tests: `tests/src/review_v07.rs` (`regression_*`, `verify_*`).

**L5 (security-review, on-chain part):** the pre-graduation buyback guard is the median of `Coin.pregrad_ring` (last 5
keeper pre-grad samples; ≥ 4 within 300 s spanning ≥ 60 s) and spot must also be within the band of the latest
sample (INTERFACE §8 2026-10-13 c, SPEC Clarifications 24). The ring uses 62 of the Coin's 64 reserved bytes: Coin
stays 546 bytes, Global unchanged. Tests: `tests/src/oracle_buyback_tests.rs` (`regression_l5_*`,
`pregrad_buyback_liveness_under_honest_sampling`) + unit test `pregrad_ring_median_needs_count_and_span`. Cost:
≈ +0.5k CU `record_samples` (pre-grad), ≈ +1.3k CU `execute_buyback` (DBC), +4,488 bytes of `.so`.
**Devnet:** a program upgrade is needed (the deployed program data is 749,800 bytes →
`solana program extend 5YMF… 4488` first, ≈ +0.031 SOL rent); **no Global/Coin migration** — existing Coins read an
empty ring (zeroed reserved bytes) and their pre-grad buybacks resume after the keeper's next 4 samples (≥ 60 s).

## Archive: v0.3–v0.6 notes (superseded by the v0.7 fresh layouts, D39 — kept for history only)
### v0.6 interface changes (final pre-mainnet review — `FINAL_REVIEW.md`; SPEC D23–D29)
Regenerate the client from `target/idl/*.json` (`services`: `npm run sync-idl`, `npm run vectors`). Every `issue_*` test
in `tests/src/final_review.rs` is now a `regression_*` test.

**Locker (H-1, before `--final`)** — no interface change. `parse_pool` accepts `len >= POOL_LEN` (287) and reads the
prefix; `read_pool` cross-checks pool == PDA ["pool", index, creator, base, quote] (stored bump), lp_mint == PDA
["pool_lp_mint", pool], base/quote vault == ATA(pool, mint, Token-2022 / SPL Token); `UnknownPoolLayout` for
shorter or shifted layouts, `WrongAccount` for a wrong discriminator. Tests: `locker_tests::regression_skim_*`
(real `extend_account` to 301 bytes; foreign/fake pool data), `final_review::regression_extend_account_*`.

**State layout**
- `Global` **680 → 776 bytes**: `guardian: Pubkey`, `pause_expires_at: i64`, `pending_admin_eta: i64` carved from
  `reserved` (128 → 80, right after `params`); `pending_admin`, `pending_treasury`, `pending_guardian` (Pubkeys)
  appended after `pending_eta`. `migrate_global` upgrades 672 (v0.4) and 680 (v0.5) Globals (`LEGACY_PARAMS_LENS`
  = [183, 187]): guardian = stored admin, active pause flags → `pause_expires_at = now + 7 days`, empty proposal;
  the snipe args only matter from 672. Existing params are **not** re-validated (devnet's test params migrate).
- `Coin.rewards: RewardTerms { trigger_multiple_bps u32, claim_bps u16, max_claim_pool_bps u16, min_sell_usd_cents u64,
  min_hold_secs i64, rebuy_window_secs i64, claim_window_secs i64, max_open_tickets u8 }` (41 bytes) carved from
  `reserved` (60 → 19); size unchanged (338). Snapshotted at `create_coin`; zeros (pre-v0.6 coins) = follow
  `Global.params`. Clients: `coinRewardParams(coin, global)` for trigger / claim / cap / windows.
- `Params` layout unchanged (187 bytes). Default `max_price_age_secs` **60 → 150**.

**Params validation (`Params::is_valid`)** — every param bounded (`constants.rs` `MIN_*` / `MAX_*`, SPEC §6.2), feed
pinned to `PYTH_SOL_USD_FEED_ID`, `curve_consistent()` (graduation_lamports = curve raise ±10 bps, raise > fee, LP
opening price = curve final price ±10 bps). Local/devnet test windows (e.g. 2 s hold, 60 s oracle window) are no
longer accepted by `initialize_global` / `queue_params`: the local e2e stack seeds its Global into the genesis
(`services/scripts/local/harness.ts` `startValidator({ global })`) — v0.7: only for its out-of-bounds windows
(10 s challenge, 5 s hold, 60 s oracle window); keepers + configs need no seeding since the `initialize_global`
bootstrap, which `npm run bootstrap:rehearsal` exercises on a local validator.

**Instructions**
| Change | Details |
|---|---|
| `set_admin` **removed** | → `propose_admin` / `accept_admin` / `cancel_admin` |
| `propose_admin(new_admin, platform_treasury, guardian)` (admin, **new**) | `admin` (signer), `global` (mut), `event_authority`, `program`. All three keys non-zero (`InvalidParams`); replaces any proposal; eta = now + 48h (`ADMIN_TIMELOCK_SECS`). Event `AdminProposed`. |
| `accept_admin()` (**new**) | `new_admin` (signer = `Global.pending_admin`), `global` (mut), `event_authority`, `program`. Errors `NoPendingAdmin`, `Unauthorized`, `TimelockNotElapsed`. Event `AdminAccepted`. |
| `cancel_admin()` (admin or guardian, **new**) | `authority` (signer), `global` (mut), `event_authority`, `program`. Event `AdminProposalCancelled`. |
| `set_pause(paused)` | accounts now `authority` (admin **or guardian**, signer), `global` (mut), `event_authority`, `program`. Bits outside `PAUSE_ALL` (0b1111) → `InvalidParams`. Non-zero → `pause_expires_at = now + 7 days`; 0 → 0. Event `PauseSet`. |
| `cancel_params()` | account `admin` renamed `authority` (admin **or guardian**). Event `ParamsCancelled` + `authority`. |
| `set_keepers(keepers)` | + `event_authority`, `program` (event `KeepersSet`). |
| `initialize_global(...)` | + `event_authority` (PDA `["__event_authority"]`) after `system_program` (event `GlobalInitialized`); guardian = admin. |
| `close_position()` (wallet, **new**) | `wallet` (signer, mut — rent goes here), `position` (mut, `["position", mint, wallet]`), `event_authority`, `program`; remaining = ticket PDAs `["ticket", mint, wallet, seq]` for seq 0..`next_ticket_seq` (≤ 64), none a live FUMPAD account. Errors `PositionNotEmpty` (open tickets, wrong count, unclosed ticket), `InvalidAccount` (wrong PDA). Event `PositionClosed`. |
| `close_ticket` | **`coin`** (`["coin", ticket.mint]`) appended after `claim_queue` (claim window from the coin's snapshot). |
| `execute_buyback` | `pool_authority` → **`pumpswap_signer`** (mut, PDA `["pumpswap_signer"]`); `buyback_wsol` = ATA(pumpswap_signer, WSOL); venue slice user = `pumpswap_signer`, **exactly 17 accounts** (`WrongVenue` otherwise). One-time setup: PumpSwap `init_user_volume_accumulator(payer, user = pumpswap_signer)` (SDK `buildPostGraduation` does it). |
| `graduate` | **no remaining accounts** (`InvalidAccount`); `pool_base_vault` / `pool_quote_vault` must be ATA(pool, mint, Token-2022) / ATA(pool, WSOL, SPL Token), `amm_event_authority` the PumpSwap event-authority PDA (`WrongVenue`). Respects `PAUSE_GRADUATE`. |
| `sell` | never paused (`PAUSE_TRADE` no longer applies). |
| curve `buy`, `swap_buy`, `swap_sell`, `execute_buyback`, `create_coin`, claims | pause checks honour `pause_expires_at`. |

**Pause flags:** `PAUSE_LAUNCH` 1, `PAUSE_TRADE` 2 (curve buys, router, buyback), `PAUSE_CLAIMS` 4, **`PAUSE_GRADUATE` 8**.
`Global::is_paused(flag, now)`. Constants: `ADMIN_TIMELOCK_SECS` (48h), `MAX_PAUSE_SECS` (7 days),
`PUMPSWAP_SIGNER_SEED`, `VENUE_V2_ACCOUNTS` (17), `MAX_CLOSE_POSITION_TICKETS` (64), the `MIN_*`/`MAX_*` param bounds.

**Events:** new `GlobalInitialized`, `PauseSet`, `KeepersSet`, `AdminProposed`, `AdminAccepted`, `AdminProposalCancelled`,
`PositionClosed`; appended fields: `ParamsCancelled.authority`, `GlobalMigrated.guardian`, `.pause_expires_at`
(SDK `LEGACY_EVENT_PADS` decodes older payloads with them zeroed).
**Errors (appended):** 6037 `NoPendingAdmin`, 6038 `PositionNotEmpty`.

**Keeper behaviour:** buyback setup inits the volume accumulator of `pumpswap_signer`; reward decisions (auto-claim,
queue pre-check, trigger pre-filter) use each coin's snapshot; pauses respect their expiry; failed transactions log
their simulation/execution logs.

**Devnet upgrade (v0.5 → v0.6):**
1. `anchor build` (both programs). The devnet fumpad program-data account (1,089,832 bytes) fits the new `.so`.
2. `solana program deploy -u d target/deploy/fumpad.so --program-id ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv`
   (upgrade authority 9HXg… signs), then **immediately** `migrate_global` from `Global.admin`:
   `npx tsx scripts/devnet/migrate-global.ts` (args `{ snipe_window_slots: 4, snipe_start_bps: 9_900 }` — ignored for
   the 680-byte devnet Global; the admin pays ≈0.00067 SOL extra rent). Global becomes 776 bytes, guardian = admin.
3. The devnet locker is still upgradeable (authority 9HXg…): `solana program deploy -u d
   target/deploy/fumpad_lp_locker.so --program-id 8TkV5aWsBJ9bHr96HV5iQXrCJ51XvHTTtxnufMQmEaY9` to get the H-1 fix
   (no state change; existing `Lock` accounts unchanged).
4. Keeper/SDK: deploy the v0.6 services; the keeper inits the `pumpswap_signer` volume accumulator on its next
   post-graduation pass. Old buyback dust in ATA(pool_authority, WSOL) stays there (unused).
5. Devnet's test params (30 s hold, 5-min oracle window, 15 samples, 0.3 SOL curve) stay live but are outside the
   v0.6 bounds — any new `queue_params` must be in bounds (e.g. 60 s hold, 10-min window, ≥ 10 samples).
   Coins created before the upgrade follow `Global.params` for rewards (no snapshot); new coins snapshot.

**Compute (v0.6 deltas, `cu_report` + locker/venue/curve CU tests; pre-fix tree 53f89b4 vs v0.6, same machine, 2–3 runs
each — ranges are PDA-bump spread on random keys):**
| Instruction | v0.5 | v0.6 | Why |
|---|---|---|---|
| locker `skim` | 76–85k | **92–115k** | H-1: `read_pool` (before and after the withdraw) cross-checks pool PDA + LP-mint PDA + 2 vault ATAs. Keeper/SDK `CU.skimSettle` 200k → **300k** (skim + settle + ATA ≈ 125–150k). |
| `graduate` | 272–307k | 278–317k | L-1 vault/event-authority pinning + the locker's H-1 checks in `lock`; budget 400k unchanged |
| `execute_buyback` | 144.7k | 133.4k | different PDA (`pumpswap_signer`) bump; exact-count check is free |
| `close_ticket` (full-queue scan) | 23.8k | 26.5k | + `coin` account (M-1 claim window) |
| `register_holdings` (rebuy, full queue) | 25.6k | 27.4–28.9k | `coin.reward_params` + 776-byte Global |
| curve `sell` (creates ticket) | 49.6–54.1k | 56.3–57.8k | `coin.reward_params` (Params copy) + Global decode |
| `claim` paid now / queued at end | 57.1k / 69.5k | 57.7k / 70.1k | +0.6–0.7k |
| `process_queue` walk only / 13 voided | 95.2k / 115.4k | 95.9k / 116.0k | +0.7k |
| `record_samples` 1 / 5 / 10 coins | 16.7k / 58.2k / 110.6k | 17.2k / 60.2k / 114.4k | larger Global (+3.4%) |
| `init_claim_queue` × 9 | 71.9k | 72.7k | worst-case bumps **140k** (`cu_report::post_graduation_setup_worst_case_bumps`; the SDK's old 9 × 12k budget failed for such coins → `CU.initClaimQueue` 25k/call, bump-aware `initClaimQueueCu`) |
| `swap_buy` / `swap_sell` / curve `buy` | within run-to-run spread | unchanged | — |
All rows remain far below the 1.4M limit (`cu_report` asserts < 1M).

### v0.5 interface changes (D19 snipe tax, D20 graduation fee — SDK / keeper / indexer / app)
Regenerate the client from `target/idl/fumpad.json` (`services`: `npm run sync-idl`, `npm run vectors`). SPEC §3 (D20) and §4.1 (D19) have the rationale.

**Params / Global** (`Params` fields appended at the end → `Params` +4 bytes, `Global` 672 → **680 bytes**: upgrade an existing Global in place with `migrate_global`, below)
- `snipe_window_slots: u16` (default 4, cap 50; 0 = off), `snipe_start_bps: u16` (default 9,900, cap 9,900). `Params::is_valid` enforces both caps.
- `graduation_fee_lamports` default **0 → 650,000,000** (0.65 SOL; cap 1 SOL unchanged).
- Curve defaults re-derived for continuity with the fee kept out of the LP: `initial_virtual_token` **988,744,870,180,001**, `curve_supply` **730,811,425,785,218**, `lp_supply` **189,188,574,214,782** (reward pool 80M, 30 SOL virtual, 85 SOL raise unchanged). Read them from chain; anything hard-coding the v0.4 values (e.g. `app/src/data/chain.ts` `initialVirtualTokens`) must update.
- New constants: `DEFAULT_SNIPE_WINDOW_SLOTS`, `DEFAULT_SNIPE_START_BPS`, `MAX_SNIPE_WINDOW_SLOTS` (50), `MAX_SNIPE_START_BPS` (9,900), `DEFAULT_GRADUATION_FEE_LAMPORTS`; `OBSERVATIONS_SPACE` (8,280) exported next to `CLAIM_QUEUE_SPACE`.

**State layout**
- `Coin.snipe: SnipeConfig { launch_slot: u64, window_slots: u16, start_bps: u16 }` carved from `reserved` (72 → 60); size unchanged (338). Pre-v0.5 coins read zeros = no tax.

**Instructions**
| Change | Details |
|---|---|
| `buy` | Same accounts/args. In the launch window the snipe tax is carved out of `sol_in`: curve offer = ⌊sol_in·(10,000 − t)/10,000⌋, tax = ⌈sol_used·t/(10,000 − t)⌉, user pays `sol_used + fee(sol_used) + tax` (≤ `sol_in + fee(sol_in)`). t = 0 for the creator's buy that is the coin's first trade in the launch slot (bundle it with `create_coin`). Quote with the slot you expect to land in (current slot = pessimistic) and set `min_tokens_out` from it. |
| `graduate` | **Two accounts appended** after `system_program` (before the event-CPI pair): `observations` (mut, PDA `["observations", mint]`), `claim_queue` (mut, PDA `["claim_queue", mint]`). Tx ≈1077 bytes. Spends the coin's snapshotted fee: caller refund (its measured net rent) → observations rent → claim-queue rent (pre-funded into the PDAs) → remainder to `platform_fees_unclaimed`. |
| `init_observations`, `init_claim_queue` | Unchanged interface; with a pre-funded PDA the payer pays nothing (only a shortfall). |
| `register_holdings` | Unchanged interface (`global`, `coin` boxed: the 680-byte Global overflowed the 4 KB stack frame). |
| `migrate_global(args: MigrateGlobalArgs { snipe_window_slots: u16, snipe_start_bps: u16 })` (admin, **new**) | `admin` (signer, mut — pays the extra rent; must equal `Global.admin`), `global` (mut, PDA `["global"]`, raw — may be the legacy layout), `system_program`, `event_authority`, `program`. Grows a 672-byte (v0.3/v0.4) Global to 680 in place: every existing byte kept, the appended `Params` fields (in `params` **and** `pending_params`) set from `args`. No-op on a current Global (idempotent — can't re-set them later; existing params still go through queue → 48h → execute). Errors: `Unauthorized` (not the stored admin), `InvalidAccount` (wrong discriminator), `UnsupportedGlobalLayout` (larger than current = never shrinks, or an unknown size), `InvalidParams` (args over the caps). Event `GlobalMigrated { old_len: u32, new_len: u32, snipe_window_slots, snipe_start_bps, rent_paid: u64, ts }`. Every other instruction fails with `AccountDidNotDeserialize` (3003) until it runs — call it right after the upgrade. Future `Params` appends: add the old length to `LEGACY_PARAMS_LENS` and the new fields to `MigrateGlobalArgs`. |

**Events (layout changes — update decoders)**
- `Trade` + trailing `snipe_tax: u64`, `snipe_tax_bps: u16` (0 for sells / router swaps / outside the window). Total charged on a buy = `sol_amount + fee_pool + fee_platform + fee_creator + snipe_tax`; `pool_tokens_bought` includes the tax's buyback. Indexer/UI: show "snipe tax" when `snipe_tax > 0`; count it as reward-pool inflow, not platform/creator fees.
- `Graduated` + trailing `caller_refund: u64`, `setup_prefunded: u64`, `platform_fee: u64` (sum = the coin's graduation fee).

**Errors (appended):** 6036 `UnsupportedGlobalLayout` (`migrate_global`). **Events (new):** `GlobalMigrated`.

**Keeper behaviour:** unchanged sequence (`graduate`, then `init_observations` + 9× `init_claim_queue`); it now costs the keeper only tx fees for coins with the 0.65 SOL fee (it still advances graduate's 0.05 SOL rent loan, returned in-instruction).

**Compute (v0.5 deltas):** curve `buy` +~200 CU (taxed 45.9k vs normal 45.7k, existing ATA/position; `curve_tests::snipe_tax_compute_units`); `graduate` **276–279k** (+~5k: two PDA bump checks + pre-funding; still set 400k). Everything else unchanged (table below).

### v0.4 interface changes (D17 — backend SDK / keeper must pick these up)
Regenerate the client from `target/idl/fumpad.json`. SPEC §3, §5.3 and §10 have the rationale.

**Defaults / constants**
- Curve defaults (in `Global.params`, read them from chain, don't hard-code): `reward_pool_supply` 80,000,000,000,000 (8%), `initial_virtual_token` 987,180,527,383,367, `curve_supply` 729,655,172,413,793, `lp_supply` 190,344,827,586,207 (`initial_virtual_sol` 30 SOL and `graduation_lamports` 85 SOL unchanged). Re-init Global on devnet to pick them up.
- `CLAIM_QUEUE_CAPACITY` 256 → **1024**. `ClaimQueue` account = 8 + 48 + 80 × 1024 = **81,976 bytes** (decoders: entries array is 1024 × 80 B; rent ≈ 0.571 SOL).
- New `CLAIM_QUEUE_INIT_CALLS` = **9**: `init_claim_queue` must be called 9× (one transaction; was 3×) before the queue is usable.

**Instructions (new)**
| Instruction | Accounts / args |
|---|---|
| `claim_for()` (registered keeper) | `keeper` (signer, mut — pays escrow rent if needed), `global`, `coin` (mut), `mint`, `ticket` (mut), `position` (mut, `["position", mint, ticket.owner]`), `claim_queue` (mut), `observations`, `pool_authority`, `reward_vault` (mut), `owner_ata` (mut, **must be** ATA(ticket.owner, mint, Token-2022) — may not exist), `escrow` (mut, PDA `["escrow", ticket]`), `token_program` (Token-2022), `system_program`, `event_authority`, `program`. Errors: `Unauthorized` (not a keeper), `AutoClaimDisabled` (owner opted out), `InvalidAccount` (wrong ATA), plus every `claim` error. Prepend an idempotent ATA create (keeper-paid) to avoid escrow. |
| `set_auto_claim(enabled: bool)` (wallet) | `wallet` (signer), `position` (mut, `["position", mint, wallet]` — must exist), `event_authority`, `program` |

`claim` (owner-signed) is unchanged (same accounts/args).

**State layout**
- `Position`: `auto_claim_opt_out: u8` carved from `reserved` (56 → 55); size unchanged (322). 0 = auto-claim on (default), 1 = opted out.

**Events:** `ClaimPaid`, `ClaimQueued`, `ClaimEscrowed` get a trailing `triggered_by: Pubkey` (owner for `claim`, keeper for `claim_for`, cranker for `process_queue`) — layout change, update decoders. New `AutoClaimSet { mint, wallet, enabled, ts }`.
**Errors (appended):** 6035 `AutoClaimDisabled`.

**Keeper behaviour:** after `graduate`, `init_observations` + 9× `init_claim_queue`; auto-claim: `claim_for` each `Open` ticket whose trigger holds with coverage (skip positions with `auto_claim_opt_out = 1`; a wallet already at 2 queue entries can only be paid now, else `WalletQueueLimit`), creating a missing owner ATA first; `process_queue` as before.

**Compute (measured, `cargo test -p tests cu_report -- --nocapture` + `venue_tests::compute_units_and_batch_size`; ranges = 4 runs, the spread comes from PDA bump searches on random keys)** — default budget is 200k per instruction; `cu_report` asserts every row < 1M:
| Instruction | CU | Explicit compute budget? |
|---|---|---|
| `init_claim_queue` × 9 (one transaction, total) | 69k | no |
| `claim` paid now (empty queue / behind 1024 older non-fitting entries) | 57k / 72k | no |
| `claim` queued at the end (1023 ahead → full) / at the **front** (1023 shifted → full) | 69k / 71–80k | no |
| `claim_for` paid now / queued at front (1023 in queue) / escrowed (1024 scanned) | 74–77k / 71–77k / 78–87k | no |
| `process_queue` full queue (1024), walk only / 1 paid / 1 escrowed | 94k / 107–111k / 116–122k | no |
| `process_queue` full queue (1024), 13 entries paid directly | 280–294k | **yes** (e.g. 450k) |
| `process_queue` full queue (1024), 13 entries escrowed | 393–413k | **yes** (e.g. 600k) |
| `process_queue` full queue (1024), 13 voided entries dropped | 114k | no |
| `register_holdings` rebuy voiding the front entry of a full queue (`buy`/`swap_buy` share the hook) | 25–37k | no |
| `close_ticket` voided, queue passed (full 1024 scanned) | 21–22k | no |
| `record_samples` 1 / 5 / 10 coins | 16k / 56k / 107k | no (10 coins needs a v0 tx + ALT for size) |
| `graduate` | 276–279k (v0.5; v0.4: 250–273k) | **yes** (400k) |
| `swap_buy` (first buy, creates ATA+position / 5 open tickets) | 139–166k / 126–153k | no (clients set 1.4M today; ≥ 200k advisable) |
| `swap_sell` (creates ticket) | 120–147k | no |
| `execute_buyback` | 143k | no |
All far below the 1.4M transaction limit; the 1024 queue costs ~90 CU per entry walked, every queue operation is one linear pass, so no bounded-walk cursor is needed. 13 queue entries is the most a legacy transaction can carry under 64 account locks (11 + 13 × 4).

### v0.3 interface changes (backend SDK / keeper must pick these up)
Regenerate the client from `target/idl/fumpad.json` (and `fumpad_lp_locker.json`). SPEC §10 has the rationale.

**Instructions**
| Change | Accounts / args |
|---|---|
| `update_params` **removed** | — |
| `queue_params(params)` (admin) | `admin` (signer), `global` (mut), `event_authority`, `program` |
| `execute_params()` (anyone, after 48h) | `caller` (signer), `global` (mut), `event_authority`, `program` |
| `cancel_params()` (admin) | `admin` (signer), `global` (mut), `event_authority`, `program` |
| `withdraw_escrow()` (ticket owner) | `owner` (signer), `global`, `mint`, `ticket` (mut), `escrow` = PDA `["escrow", ticket]` (mut), `pool_authority`, `destination` (mut, any Token-2022 account of the owner for the mint), `escrow_payer` (mut, = `ticket.escrow_payer`), `token_program` (Token-2022), `event_authority`, `program` |
| `graduate` | `pool_authority_wsol` (ATA) **replaced by** `graduation_wsol` = PDA `["graduation_wsol", mint]` (mut; created + closed inside). Same account count/position. |
| `process_queue` | `cranker` is now **mut** (pays escrow rent); **`system_program` added** after `token_program`; remaining accounts are **quadruples** `[ticket, position, owner ATA, escrow PDA ["escrow", ticket]]` (all mut), in queue order |
| `buy`, `swap_buy`, `register_holdings` | remaining accounts: open tickets, then **the coin's ClaimQueue (mut) iff one of the open tickets is `Queued`**, then (swap_buy) the PumpSwap accounts. Missing → `QueueAccountRequired` |
| `swap_sell` | `user_token_account` must be the user's **canonical Token-2022 ATA** (Anchor `ConstraintAssociated` otherwise) |
| `close_ticket` | `claim_queue` no longer required for voided tickets (optional, harmless) |
| `sell` | may now succeed on a `Complete` coin ≥ 7 days after `completed_at` (D13; emits `CurveReopened`, coin back to `Curve`) |

**State layout**
- `Global`: `pending_params: Params` + `pending_eta: i64` appended → 481 → **672 bytes** (re-init Global on devnet).
- `Coin`: `fees: CoinFees { graduation_fee_lamports u64, fee_bps u16, fee_pool_share_bps u16, fee_platform_share_bps u16, fee_creator_share_bps u16 }` carved from `reserved` (88 → 72); size unchanged (338). Fees for a coin come from here, not `Global.params`.
- `Position`: `last_balance: u64` carved from `reserved` (64 → 56); size unchanged.
- `Ticket`: `escrow_payer: Pubkey` replaces `reserved: [u8; 32]`; size unchanged. `TicketStatus::Escrowed` appended (= 5).
- `Observations`: `_pad[0]` → `keeper_sampled: u8`; layout unchanged.
- Constants: `ESCROW_SEED`, `GRADUATION_WSOL_SEED`, `MAX_QUEUED_PER_WALLET` (2), `MAX_GRADUATION_FEE_LAMPORTS` (1 SOL), `MAX_FEE_BPS` (200), `PARAMS_TIMELOCK_SECS` (48h), `ESCAPE_HATCH_SECS` (7 days).

**Events (new):** `ParamsQueued`, `ParamsUpdated`, `ParamsCancelled`, `CurveReopened`, `ClaimEscrowed`, `EscrowWithdrawn`.
**Errors (appended, earlier codes unchanged):** 6030 `NoPendingParams`, 6031 `TimelockNotElapsed`, 6032 `WalletQueueLimit`, 6033 `NoEscrow`, 6034 `QueueAccountRequired`; `InsufficientSamples` (6019) message now says claims/buybacks pause during a keeper outage. Locker: 6007 `UnknownPoolLayout`.

**Keeper behaviour:** heartbeat-sample **every** graduated coin < 10 min (batched); only keeper samples count for medians, spread over ≥ 5 of 6 five-minute buckets (start full rate ≥ ~25 min before claims/buybacks need a median); create missing owner ATAs before `process_queue`; `execute_params` after 48h.

**Compute:** see the v0.4 table above.


## Rules
- Every SOL/token amount: checked math, u128 intermediates, rounding in the protocol's favor.
- Validate every account: PDA seeds + bump, owners, mints, token programs. No trusting the client.
- Every state change emits an event from `events.rs` via `emit_event!(ctx, Event { .. })` (needs `#[event_cpi]`; same self-CPI as Anchor's `emit_cpi!`, which isn't used because it inlines the whole CPI per call site); without `ctx`, `instructions::rewards::util::emit_event`.
- Respect `Global.paused` flags (and their expiry).
- CPIs signed by a fumpad PDA (`fee_claimer`, `buyback`, `reward_pool`) forward exactly pinned account lists
  (`meteora::require_exact_accounts` or lists built from validated named accounts); user-signed pass-through only
  for the router. Read external accounts only through `external::meteora` readers (owner + discriminator + length).
- Keep CU in mind: no large stack arrays (SBF frame = 4KB); heap or zero-copy instead.
- Tests: happy path AND every rejection path (each `require!` should have a test that hits it).
