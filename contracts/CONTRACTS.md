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

`tests/src/flow.rs` drives a real coin through the whole lifecycle (used by `d10_tests.rs`
and `e2e_tests.rs`); `Env::set_sol_usd` writes a fresh Pyth SOL/USD account.
`tests/src/lib.rs` is the shared harness (`Env::new()` = fumpad + real PumpSwap + pump fees
program + PumpSwap GlobalConfig, global initialized, one keeper). Devnet account dumps live
in `tests/fixtures/` (`solana account -u d <addr> --output json -o <file>`;
`solana program dump -u d <id> <file>.so`).

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

**Compute (measured, `cargo test -p tests cu_report -- --nocapture` + `venue_tests::compute_units_and_batch_size`)** — default budget is 200k per instruction:
| Instruction | CU | Explicit compute budget? |
|---|---|---|
| `claim` (paid now / queued behind 255 / inserted at front of 255) | 57.8k / 58.7k / 61.9k | no |
| `process_queue` full queue (256), 13 entries paid directly | 244k | **yes** (e.g. 400k) |
| `process_queue` full queue (256), 13 entries escrowed | 323k | **yes** (e.g. 450k) |
| `record_samples` 1 / 5 / 10 coins | 16k / 56k / 107k | no (10 coins needs a v0 tx + ALT for size) |
| `graduate` | 270k | **yes** (400k) |
| `swap_buy` (first buy, creates ATA+position / 5 open tickets) | 151k / 135k | no (clients set 1.4M today; ≥ 200k advisable) |
| `swap_sell` (creates ticket) | 127k | no |
| `execute_buyback` | 143k | no |
All fit the 1.4M transaction limit. 13 queue entries is the most a transaction can carry under 64 account locks (11 + 13 × 4).

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
- Every state change emits an event from `events.rs` via `emit_cpi!` (`#[event_cpi]`).
- Respect `Global.paused` flags.
- Keep CU in mind: no large stack arrays (SBF frame = 4KB); heap or zero-copy instead.
- Tests: happy path AND every rejection path (each `require!` should have a test that hits it).
