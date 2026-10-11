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
