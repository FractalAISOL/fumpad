# FUMPAD contracts — working guide

Spec: `../docs/SPEC.md` (source of truth). Concept: `../docs/concept-overview.pdf`.

## Programs
| Program | Id | Upgradeable | What |
|---|---|---|---|
| `fumpad` | `ASVE6Nk8T1c2Uv81vjPeNDnX54nHGWg98G1afYt2j8Cv` | yes (Squads multisig) | everything (curve, router, rewards, oracle) |
| `fumpad_lp_locker` | `8TkV5aWsBJ9bHr96HV5iQXrCJ51XvHTTtxnufMQmEaY9` | **NO — must be made immutable at deploy** | holds every pool's LP forever; `lock` (CPI from `graduate`) + `skim` (fee growth only). SPEC §3.1 / D11 |

They reference each other by hard-coded id: the locker's `FUMPAD_PROGRAM_ID` (pool-authority signer check, reward-vault / coin PDAs) and fumpad's `LP_LOCKER_PROGRAM_ID` (= `fumpad_lp_locker::ID`, CPI target). The program keypairs live in `target/deploy/` (git-ignored) — back them up; deploying under other ids means changing `declare_id!`/`FUMPAD_PROGRAM_ID` in BOTH crates (and Anchor.toml) and rebuilding both.

## Build & test
```
source ~/.cargo/env; export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
anchor build                           # builds both programs; must pass, no new warnings
cargo test -p fumpad --lib             # pure math/state unit tests
cargo test -p fumpad_lp_locker --lib   # locker √k accounting (property tests)
cargo test -p tests                    # LiteSVM integration tests (needs `anchor build` first)
```

## Build profile & program size
`anchor build` = `cargo build-sbf --tools-version v1.57 --arch v3` (Anchor 1.2.1 defaults; platform-tools v1.57).
- `Cargo.toml` `[profile.release]`: `opt-level` 3 (default), `lto = "fat"`, `codegen-units = 1`, **`overflow-checks = true` (must stay)**. SBF is already `panic = abort`; the deployed `.so` is stripped by `cargo build-sbf`.
- `.cargo/config.toml` (SBF targets only, `cfg(target_os = "solana")`; host builds/tests/IDL unaffected): `-C llvm-args=-inline-threshold=60 -inlinehint-threshold=60 -unroll-threshold=50`. Builds without the file are still correct, just ~22% bigger — keep it for `anchor build --verifiable` / `solana-verify` too (it lives in the repo, so they pick it up).
- Feature flags: none in the deployed binary. `idl-build` is only enabled by the IDL step (IDL output byte-identical before/after this tuning); `no-log-ix-name` was rejected (−2.5 KB, drops the `Instruction: X` log lines).
- Code (fumpad only; the locker source is untouched): events go through `emit_event!(ctx, Event { .. })` (lib.rs) → one non-generic `events::emit_cpi_data` — byte-identical self-CPI to Anchor's `emit_cpi!`, which inlined the whole CPI at ~30 sites; `logic::plan_rebuy` orders ≤5 tickets with a stable insertion sort instead of std `sort_by` (same order; unit test checks it against `sort_by` on 2,000 random sets).

| Build | `fumpad.so` | rent | `fumpad_lp_locker.so` | rent |
|---|---|---|---|---|
| before (O3, no flags) | 1,086,184 | 5.519 SOL | 209,960 | 1.067 SOL |
| **now** | **800,672 (−26.3%)** | **4.068 SOL** | **184,216 (−12.3%)** | **0.937 SOL** |

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

## Deploy (order matters)
1. Deploy `fumpad` (upgrade authority → Squads multisig), run `initialize_global`.
2. Deploy `fumpad_lp_locker` from `target/deploy/fumpad_lp_locker.so` with its keypair, then **remove its upgrade
   authority immediately, before any coin can graduate**:
   ```
   solana program deploy target/deploy/fumpad_lp_locker.so --program-id target/deploy/fumpad_lp_locker-keypair.json
   solana program set-upgrade-authority 8TkV5aWsBJ9bHr96HV5iQXrCJ51XvHTTtxnufMQmEaY9 --final
   solana program show 8TkV5aWsBJ9bHr96HV5iQXrCJ51XvHTTtxnufMQmEaY9   # "Authority: none"
   ```
   Verify the deployed bytes against a reproducible build (`anchor build --verifiable` / `solana-verify`) and publish
   the hash. `--final` is irreversible: a bug in the locker can then only be "fixed" by leaving its pools as they
   are (principal stays locked; skims may stop) — re-run the locker test suite against the exact `.so` first.
3. `graduate` fails cleanly (whole instruction reverts, coin stays `Complete`) while the locker isn't deployed, so finish step 2 before opening launches.

**Upgrading `fumpad` over an existing Global** (e.g. devnet v0.4 → v0.5): `solana program extend` if the new `.so` is
larger than the program-data account, `solana program deploy target/deploy/fumpad.so --program-id <id>` (upgrade
authority signs), then immediately `migrate_global` signed by `Global.admin` (SDK `migrateGlobalIx`; devnet:
`npx tsx scripts/devnet/migrate-global.ts` in `services/`). Every instruction that loads Global fails until it runs. The
locker is immutable and unaffected.

`tests/src/flow.rs` drives a real coin through the whole lifecycle (used by `d10_tests.rs`
and `e2e_tests.rs`); `Env::set_sol_usd` writes a fresh Pyth SOL/USD account.
`tests/src/lib.rs` is the shared harness (`Env::new()` = fumpad + real PumpSwap + pump fees
program + PumpSwap GlobalConfig, global initialized, one keeper). Devnet account dumps live
in `tests/fixtures/` (`solana account -u d <addr> --output json -o <file>`;
`solana program dump -u d <id> <file>.so`).

## v0.5 interface changes (D19 snipe tax, D20 graduation fee — SDK / keeper / indexer / app)
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

## v0.4 interface changes (D17 — backend SDK / keeper must pick these up)
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

## v0.3 interface changes (backend SDK / keeper must pick these up)
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

## Module ownership (parallel branches — stay in your lane)
| Module | Files you own |
|---|---|
| curve | `instructions/curve/*`, `math/curve.rs`, `external/pumpswap.rs` (create_pool section), `tests/src/curve*.rs` |
| rewards | `instructions/rewards/*` (incl. `hooks.rs` bodies), `external/pyth.rs`, `tests/src/rewards*.rs` |
| venue | `instructions/venue/*` (incl. `settle_lp_fees`), `external/pumpswap.rs` (swap/reserves section), `tests/src/venue*.rs` |
| locker | `programs/fumpad_lp_locker/*` (keep it tiny, no admin, no new instructions), `tests/src/locker_tests.rs` |

Shared files (`state/*`, `events.rs`, `constants.rs`, `error.rs`, `lib.rs`, `math/fees.rs`,
`math/price.rs`, `tests/src/lib.rs`): change only when unavoidable, minimally, and list every
change in your final report. Errors: add variants only inside your module's section of
`error.rs`. New test helpers go in your own test files, not the shared harness.
`lib.rs` entrypoint signatures are fixed; if you must change args, say so in your report.

## Rules
- Every SOL/token amount: checked math, u128 intermediates, rounding in the protocol's favor.
- Validate every account: PDA seeds + bump, owners, mints, token programs. No trusting the client.
- Every state change emits an event from `events.rs` via `emit_event!(ctx, Event { .. })` (needs `#[event_cpi]`; same self-CPI as Anchor's `emit_cpi!`, which isn't used because it inlines the whole CPI per call site); in hooks without `ctx`, `hooks::emit_event`.
- Respect `Global.paused` flags.
- Keep CU in mind: no large stack arrays (SBF frame = 4KB); heap or zero-copy instead.
- Tests: happy path AND every rejection path (each `require!` should have a test that hits it).
