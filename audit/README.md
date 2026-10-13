# FUMPAD — external audit package (v0.7)

Entry point for the external security review. Everything here is factual as of **2026-10-13**; statements that
were not verified are marked **UNVERIFIED**.

| Document | What it contains |
|---|---|
| `audit/README.md` (this file) | product summary, exact scope, out of scope + integration assumptions, build / test / reproduce |
| `audit/ARCHITECTURE.md` | components, trust boundaries, every PDA and who signs for what, fund flows, state machines, admin / guardian / keeper powers |
| `audit/THREAT-MODEL.md` | assets, actors, invariants that must hold, accepted risks, questions for the auditors |
| `audit/PRIOR-REVIEWS.md` | every internal finding (v0.5/v0.6 + v0.7, on-chain and off-chain) with status, fix commit, regression test |
| `audit/TEST-COVERAGE.md` | invariants / threats → tests, and known gaps |
| `audit/build-and-test.sh` | one script that builds and runs every suite listed below |

Normative sources in the repo (read in this order): `docs/SPEC-v0.7-meteora.md` (v0.7 decisions D30–D39 +
Clarifications 1–24) → `docs/SPEC.md` (v0.6; every rule v0.7 does not change is still in force, notably D1–D6, D9,
D10/D12, D15–D17, D23–D26, D29) → `contracts/INTERFACE-v0.7.md` (instructions, accounts, PDAs, byte layouts,
attestation messages, events, errors) → `contracts/CONTRACTS.md` (build, sizes, CU, deploy order, open risks) →
`services/meteora/ATTESTATION.md` (trade parser and keeper signing rules).

---

## 1. What FUMPAD is

FUMPAD is a Solana memecoin launchpad with one extra rule: **a seller who sells a FUMPAD coin and later sees that
coin hold ≥ 10× their sell price can claim 10% of the tokens they sold** ("fumble ticket"), paid in the coin's own
tokens from a per-coin reward pool.

- **Venue.** Every coin is a plain (no transfer hook) Token-2022 coin with a fixed 1B supply, launched on a
  **Meteora Dynamic Bonding Curve (DBC)** pool that uses a FUMPAD-owned DBC config. When the curve raises its
  threshold (85 SOL on mainnet), DBC migrates the liquidity to a **Meteora DAMM v2** pool whose LP position is
  100% permanently locked and whose position NFT is held by a FUMPAD PDA. FUMPAD does not run its own AMM. Coins
  trade on any app (FUMPAD's router, Jupiter, Axiom, bots, direct).
- **Fees.** Meteora charges 1.25% on every swap of these pools; Meteora keeps 20% of it, FUMPAD's share (1.00% of
  volume) is claimed by the FUMPAD program and split 50% buyback / 30% platform / 20% creator. Fees taken during the
  8-slot launch window (99% → 1.25% anti-sniper fee scheduler) go 100% to the coin's buyback balance.
- **Reward pool.** Per coin, a Token-2022 token account (`ATA(PDA["reward_pool"], mint)`) receives (a) the DBC
  "leftover" of exactly 8% of supply at graduation and (b) the tokens bought back with the buyback balance. Claims
  are paid only from this account.
- **Tickets.** Sells happen anywhere, so the program cannot observe them. Each qualifying sell (≥ $50, tokens held
  ≥ 10 min, not the creator, ≤ 5 open tickets per wallet and coin, rebuy rule, D10/D12 price floor) is turned into
  an on-chain `Ticket` by **2-of-3 keeper attestations**: three keepers independently re-derive the coin's full
  history from finalized chain data with a deterministic engine and sign a fixed-width Ed25519 message; the program
  verifies the signatures by Ed25519-precompile introspection, prevents replays with per-trade PDAs, applies a
  per-coin rate cap, and makes every ticket wait out a **challenge window** (default 6 h) during which a guardian
  multisig can void it. An independent watcher re-derives every attestation and alerts on mismatch.
- **Claims.** After graduation, a ticket is claimable when the 30-minute median of keeper-recorded DAMM v2 spot
  samples is ≥ 10× the ticket price (with coverage rules). Claims pay immediately if they fit (≤ 10% of the pool and
  no older fitting claim waiting), otherwise they enter a per-coin skip-ahead queue (1024 entries); payouts to
  accounts that refuse transfers go to a per-ticket escrow. Keepers may auto-claim on the owner's behalf (payout
  always to the owner); owners can opt out.
- **Governance.** Admin = Squads v4 multisig (3-of-5, 48 h Squads time lock; also program upgrade authority);
  guardian = separate Squads multisig (2-of-3, no time lock) that can only pause, cancel pending changes and void
  tickets in their challenge window. Params, the DBC-config allow-list and admin/treasury/guardian changes are 48 h
  timelocked on chain. On devnet today all three roles are one key (see §6).

Accepted product risks (user decision D38): Meteora's upgrade authority can change DBC / DAMM v2; DAMM v2 operators
can disable a pool or change its fee; Meteora takes 20% of trading fees.

---

## 2. Scope

**Commit:** `aa137a936518d89c9a2aba83cbf1e8f27208aa47` (`main`, 2026-10-13). This package lives on a branch on
top of that commit and adds only the `audit/` directory; no code differs. Program source last changed in `5cac136`
/ `418b24c` (both ancestors of `aa137a9`).

Line counts: `wc -l` (all lines) and "code" = lines that are neither blank nor comment-only (`//`, `///`, `//!`,
`*`). Produced by the counting snippet in §2.4.

### 2.1 Scope A — on-chain program (primary)

`contracts/programs/fumpad/` — Anchor 1.2.1, one program `fumpad`, devnet / test id
`5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb` (mainnet will get its own keypair and `declare_id!`; §6).

**47 Rust files, 6,526 lines (5,362 code), of which 523 lines are in-file `#[cfg(test)]` modules**; plus
`programs/fumpad/Cargo.toml` (31), `contracts/Cargo.toml` (release profile, `overflow-checks = true`),
`contracts/.cargo/config.toml` (SBF inliner flags), `contracts/rust-toolchain.toml`, `contracts/Cargo.lock`.

| File | Lines | Contents |
|---|---:|---|
| `src/lib.rs` | 199 | `declare_id!`, 37 instruction entry points, `emit_event!` macro |
| `src/attestation.rs` | 389 | sell (284 B) / rebuy (236 B) message codecs, Ed25519-precompile introspection |
| `src/constants.rs` | 153 | seeds, defaults, param bounds, external ids |
| `src/error.rs` | 125 | 59 custom errors (6000–6058) |
| `src/events.rs` | 353 | events + shared event self-CPI (`emit_cpi_data`) |
| `src/external/meteora.rs` | 361 | DBC 0.2.1 / DAMM v2 0.2.4 raw layouts (byte offsets), discriminators, pass-through CPI, `require_exact_accounts` |
| `src/external/mod.rs` | 1 | |
| `src/math/{fees,price,mod}.rs` | 44 + 132 + 5 | 50/30/20 split, Q64 price from `sqrt_price`, 10× check |
| `src/state/global.rs` | 264 | `Global`, `Params` + `is_valid` bounds, pause flags, keeper/guardian predicates |
| `src/state/coin.rs` | 269 | `Coin`, rate-cap leaky bucket, pre-graduation sample ring (median) |
| `src/state/{position,ticket,consumed,claim_queue,observations,mod}.rs` | 31 + 56 + 27 + 28 + 185 + 34 | per-wallet / per-ticket / replay-marker / queue / oracle ring |
| `src/instructions/admin/{mod,config,migrate_global}.rs` | 264 + 104 + 41 | init, params / config / admin timelocks, pause, keepers, layout hook |
| `src/instructions/launch.rs` | 121 | `register_coin` |
| `src/instructions/venue/router.rs` | 173 | `buy` / `sell` (user-signed DBC / DAMM v2 `swap2` pass-through) |
| `src/instructions/venue/fees.rs` | 309 | `claim_fees` (DBC partner fees), `claim_lp_fees` (DAMM v2 position fees) |
| `src/instructions/venue/buyback.rs` | 234 | `execute_buyback` (pre- and post-graduation guards) |
| `src/instructions/venue/graduation.rs` | 332 | `migrate_pool`, `graduate` (leftover, migration fee, surplus, setup budget) |
| `src/instructions/venue/{record_samples,init_observations,common,mod}.rs` | 151 + 47 + 112 + 16 | oracle samples, WSOL helpers |
| `src/instructions/tickets/{attest_sell,attest_rebuy,mod}.rs` | 259 + 152 + 98 | attestations, `void_ticket`, `close_consumed` |
| `src/instructions/rewards/*.rs` (12 files) | 1,247 | `claim`, `claim_for`, `process_queue`, queue ops, escrow, close paths, fee withdrawals, `set_auto_claim`, `init_claim_queue` |
| `src/instructions/mod.rs` | 11 | |

Test code (not in scope for findings, but it is the regression evidence): `contracts/tests/src/*.rs`, 15 files,
5,557 lines (LiteSVM harness + 79 integration tests on the mainnet Meteora binaries).

### 2.2 Scope B — off-chain attestation trust chain

Everything that decides what a keeper signs, or that checks what was signed. TypeScript (Node ≥ 22, ESM, strict).

| Package / files | Files | Lines (code) | Role |
|---|---:|---:|---|
| `services/meteora/src/*.ts` (excl. `idl/`) | 9 | 1,389 (1,068) | Meteora DBC / DAMM v2 trade parser: event authenticity (event-authority PDA, CPI parent by `stackHeight`), vault-delta cross-check (`vaultflow.ts`), trader attribution, pool facts, v1-tx RPC client |
| `services/meteora/src/idl/{dbc,damm_v2}.idl.ts` | 2 | 1,470 (data) | on-chain IDLs the parser decodes with (pinned; strict length checks) |
| `services/engine/src/**/*.ts` | 12 | 1,608 (1,195) | deterministic eligibility engine: hold buckets, rebuy rule, D10 reference / D12 floor, USD via Pyth (Hermes historical), canonical output, incremental mint crawl |
| `services/keeper/src/attest/*.ts` | 7 | 1,232 | attestor: re-derivation per coin (`derive.ts`), messages (`records.ts`), signature board (Postgres + RLS, `board.ts`), submission (`attestor.ts`, `chain.ts`), history guard |
| `services/keeper/src/watch/*.ts` | 2 | 339 | watcher: field-by-field verification of every `TicketAttested` / `TicketDebited`, alerts |
| `services/keeper/src/{main,config,alerts}.ts` | 3 | 225 | mode switch, key loading, Telegram alerts |
| `services/sdk/src/{attestation,hash,pda}.ts` | 3 | 464 (396) | message encoding (byte-identical to the program, vector-tested), Ed25519 sign/verify, PDA derivation incl. consumed markers |

Total scope B: **36 files, 5,227 lines (4,085 code) + 1,470 lines of IDL data.**

Out of scope B but relevant context: `services/keeper/src/keeper.ts` (the "jobs" keeper: samples, cranks,
auto-claim, pre-graduation buybacks; its on-chain powers are bounded by the program and listed in ARCHITECTURE
§7), `services/indexer`, `services/api` (incl. the launch co-signer `LAUNCH_SIGNER_KEY`), `services/grinder`.

### 2.3 Scope C — optional / light: embedded-wallet silent signing

The app's Privy embedded "Trading wallet" signs some FUMPAD transactions without a prompt. The allow-list decides
which.

| File | Lines (code) | Role |
|---|---:|---|
| `app/src/chain/allowlist.ts` | 508 | exact-pattern vetting of every transaction (programs, signers, ALTs, account lists rebuilt with the SDK, amount and `min_out` bounds from the app's own quote) |
| `app/src/chain/signer.ts` | 53 | vet → sign → compare message bytes; silent only for vetted txs from the embedded wallet |
| `app/src/chain/launchAuth.ts` | 170 | allow-list of the one off-chain message the wallet may sign silently (launch proof-of-ownership) |

Total scope C: **3 files, 731 lines (498 code).** Callers for context: `app/src/chain/{build,tx,flow,limits}.ts`,
`app/src/components/wallet/PrivyIsland.tsx`.

### 2.4 Reproducing the counts

```sh
cnt() { t=0; c=0; for f in "$@"; do t=$((t+$(wc -l <"$f"))); c=$((c+$(grep -cvE '^\s*$|^\s*//|^\s*\*|^\s*/\*' "$f"))); done; echo "$# files, $t lines, $c code"; }
cnt $(git ls-files 'contracts/programs/fumpad/src/*.rs')
cnt $(git ls-files 'services/meteora/src/*.ts' | grep -v /idl/) $(git ls-files 'services/engine/src/*.ts' 'services/keeper/src/attest/*.ts' 'services/keeper/src/watch/*.ts') services/keeper/src/{main,config,alerts}.ts services/sdk/src/{attestation,hash,pda}.ts
cnt app/src/chain/{allowlist,signer,launchAuth}.ts
```

---

## 3. Out of scope, and what we assume about it

Not under review, but FUMPAD's safety depends on these assumptions. Each one is a place where a reviewer should
check that our code does not assume more than stated.

| Component | Version / id | Our assumptions |
|---|---|---|
| **Meteora DBC** | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, mainnet 0.2.1, programdata sha256 `4c26a8a5…f23b`, upgrade authority `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd`, last deployed slot 445,503,633 | Account layouts at the byte offsets in `external/meteora.rs` (`VirtualPool` 424 B, `PoolConfig` 1,048 B) stay valid (readers fail closed on owner / discriminator / length). `claim_trading_fee` pays partner fees only to the config's `fee_claimer` signer. `withdraw_leftover` pays the leftover only to `ATA(leftover_receiver, mint)` and sets `is_withdraw_leftover`. `withdraw_migration_fee` (partner) / `partner_withdraw_surplus` pay only to the `fee_claimer` signer and set their flags. `migration_damm_v2` creates the DAMM v2 pool under a config whose `pool_creator_authority` is DBC's pool authority and mints the 100% partner-locked position NFT to `fee_claimer`. `enable_first_swap_with_min_fee` gives the min fee to exactly one swap of the pool-creation transaction (verified on the binary: `verify_dbc_min_fee_goes_to_one_swap_per_launch_tx`). `TokenAuthorityOption::Immutable` leaves no mint / freeze / metadata authority. Swaps emit `EvtSwap` + `EvtSwap2` via self-CPI with the `__event_authority` PDA. |
| **Meteora DAMM v2** | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, mainnet 0.2.4, sha256 `4d5b920b…848b`, same upgrade authority, last deployed slot 445,230,614; migration config `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` | Pool PDA `["pool", config, max(mint, WSOL), min(mint, WSOL)]`; `sqrt_price` at offset 456, `pool_status` at 481, `token_b_amount` for depth. `claim_position_fee` requires the position-NFT holder to sign and pays to the given token accounts. Permanently locked liquidity can never be withdrawn by anyone. Anyone can create positions / add / lock liquidity in the pool (handled, REVIEW-v0.7 H-1). The pool can be disabled by its operator (router refuses; samples do **not** check it — THREAT-MODEL §4). |
| **Squads v4** | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, sha256 `dec8d3e0…d34c`, upgrade authority **none** (immutable), last deployed slot 302,582,236 | Vault PDA signs only executed proposals; time lock enforced by the program; `configAuthority = null` makes membership / threshold / time-lock changes themselves subject to vote + time lock. |
| **Pyth** (Hermes historical API, SOL/USD feed `0xef0d8b6f…b56d`) | off-chain only in v0.7 (the program no longer reads Pyth) | All attestors and the watcher use the same Hermes source and pick the update with the greatest `publish_time ≤ block_time` (deterministic tie-break); the program only checks `0 ≤ block_time − pyth_publish_time ≤ max_price_age_secs` on the attested numbers. Hermes availability / integrity is trusted for the $50 threshold only. |
| SPL Token, Token-2022, ATA, System, Ed25519 precompile, instructions sysvar | Solana mainnet builtins / programs | Standard semantics. Ed25519 precompile verifies every listed signature or fails the whole transaction. |
| Solana runtime | Agave 4.1.x feature set (LiteSVM 0.18 tests use the mainnet feature set) | `Clock.unix_timestamp` within normal drift; rent rate at deploy time UNVERIFIED (CONTRACTS.md). |
| RPC providers (keepers, watcher) | four different companies planned for mainnet | Each serves complete finalized history incl. v1 transactions; a single malicious / incomplete provider affects at most one attestor (checked by `scripts/ops/rpc-check.ts`, L8 first-available-block guard). |

Also out of scope: `services/indexer`, `services/api`, `services/grinder`, the rest of `app/` (UI, data layer,
CSP), `marketing/`, `design/`, `sim/`, `spike/`, deployment scripts (`services/scripts/**`) except as tooling to
reproduce tests.

---

## 4. Toolchain (versions the suite was run with on 2026-10-13)

| Tool | Version | Pinned where |
|---|---|---|
| Rust (host, tests) | 1.99.0 (`rustc b940084d7 2026-09-28`) | `contracts/rust-toolchain.toml` (`channel = "1.99.0"`); `rust-version = 1.89.0` minimum |
| Anchor CLI | 1.2.1 (`avm`) | `anchor-lang` / `anchor-spl` `1.2.1` in Cargo.toml |
| Solana / Agave CLI | 4.1.2 (`cargo-build-sbf 4.1.0`) | — |
| SBF platform-tools | v1.57 (Anchor 1.2.1's default: `cargo build-sbf --tools-version v1.57 --arch v3`) | Anchor defaults |
| LiteSVM | 0.18 (`features = ["precompiles"]`) | `contracts/tests/Cargo.toml` |
| Node.js / npm | 22.15.0 / 10.9.2 | `services/package.json` `engines.node >= 22` |
| PostgreSQL (integration + e2e) | 18.3 (`initdb` / `pg_ctl` on PATH, or `DATABASE_URL`) | — |
| `solana-test-validator` | 4.1.2 | — |
| OS used | macOS 15.5, arm64 | — |

No Docker is needed. `anchor build --verifiable` (Docker) has **not** been run (see §6).

---

## 5. Build and test from a clean checkout

```sh
git clone <repo> fumpad && cd fumpad && git checkout <audit branch>
audit/build-and-test.sh            # everything below; ≈ 6 min with warm caches (measured, M1), longer on first run (downloads + builds)
audit/build-and-test.sh --help     # flags: --skip-integration, --skip-app, --skip-pocs, --keypair <path>
```

The script checks prerequisites first and stops with a message naming what is missing. Logs go to a temporary
directory it prints; each step prints its pass/fail line. What it runs, in order:

1. **Fixture check.** `contracts/tests/fixtures/*` are committed (dumped read-only from mainnet; no download
   needed). The script verifies their sha256 against the values in §5.1.
2. **Program build.** `anchor build -p fumpad` in `contracts/` → `contracts/target/deploy/fumpad.so` (754,288
   bytes at `aa137a9`), IDL `target/idl/fumpad.json`. The program keypair `contracts/target/deploy/fumpad-keypair.json`
   is git-ignored and **is not part of the package**; it does not affect the compiled bytes (`declare_id!` does). If
   it is absent, `anchor build` creates a throwaway keypair and prints "Program ID mismatch detected" (harmless;
   verified: a build from a `git archive` copy in another directory with a fresh keypair gave the same `fumpad.so`
   sha256 as the build with the devnet keypair). It is only needed to *deploy* (the local e2e stack loads the `.so` at the program id with `--upgradeable-program` and needs no
   keypair).
3. **Program unit tests.** `cargo test -p fumpad --lib` — 20 tests (attestation codec + Ed25519 parsing, queue,
   oracle median / coverage, pre-graduation ring, rate cap, fee split, price math, account sizes).
4. **LiteSVM integration suite.** `cargo test -p tests` — 78 pass + 1 ignored (`derive_exact_curves`, a re-derivation
   tool), ≈ 15 s. Runs the built `fumpad.so` together with the **mainnet** DBC 0.2.1 and DAMM v2 0.2.4 binaries and
   the mainnet DAMM v2 migration config. Includes the CU / tx-size / rent report (`cu_report`; print it with
   `cargo test -p tests cu_report -- --nocapture`) and the attestation / DBC-config test-vector checks
   (`UPDATE_VECTORS=1` regenerates them).
5. **Services.** `npm ci`, `npm run typecheck`, `npm test` (vitest, project `unit`: 40 files, 411 tests incl.
   parser fixtures from mainnet transactions, engine golden replays of recorded mainnet histories, attestor 2-of-3
   logic, watcher, SDK ↔ contract vectors).
6. **Services integration + local e2e.** `npm run test:integration` (6 files, 31 tests, ≈ 4 min): indexer ↔
   Postgres ↔ API, keeper single-instance lock, and `e2e.test.ts` = `npm run local`: a `solana-test-validator` with
   the built `fumpad.so`, the mainnet DBC / DAMM v2 binaries and migration config, a throwaway Postgres
   (`initdb`), the real indexer, API, jobs keeper, **three attestors and the watcher**, running launch → direct and
   routed trades on DBC → attested tickets (outside + router) → rebuy debit → curve completion → migration →
   `graduate` → DAMM v2 trades → samples → auto-claim payout, and asserting the watcher found every attestation
   matching. Ports: the script pins the validator's gossip / dynamic ports to 8001 / 8002–8041 (a first run without that collided with another validator on the same machine); override with `FUMPAD_RPC_PORT`, `FUMPAD_API_PORT`, `FUMPAD_GOSSIP_PORT`, `FUMPAD_PG_PORT`.
7. **App.** `npm ci` and `npm test` in `app/` (node test runner: 104 tests incl. the allow-list against
   transactions captured from the local stack and tamper variants).
8. **Security-review PoCs.** The v0.7 off-chain PoCs (`security-review/v07-poc/*.test.ts`) were written to pass while
   each bug existed and were flipped to assert the fix; the script runs them (it creates the git-ignored symlink
   `security-review/node_modules → ../services/node_modules` they need). The older v0.6 PoCs
   (`security-review/services-poc`, `app-poc`) target APIs that no longer exist and are not run.

Manual equivalents:
```sh
cd contracts && anchor build -p fumpad && cargo test -p fumpad --lib && cargo test -p tests
cd ../services && npm ci && npm run typecheck && npm test && npm run test:integration    # or: npm run local
cd ../app && npm ci && npm test
```

Not run by the script (need keys / funded accounts / mainnet RPC): `npm run bootstrap:rehearsal`,
`npm run multisig:rehearsal` (≈ 3 min; local validator + mainnet Squads v4 binary; needs the program keypair because
it runs a real `solana program deploy`), `npm run mainnet:rehearsal` (≈ 16 min; read-only mainnet fork), the devnet
scenario `services/scripts/devnet/*`. Their results are recorded in `services/MULTISIG.md` §6 (33/33) and
`services/LAUNCH-DAY.md` §9 (37/37).

### 5.1 Mainnet fixtures

| File | sha256 | What |
|---|---|---|
| `dbc_mainnet.so` | `4c26a8a5da99f8ce932fa0300c46675b527090021fbb74214c9486bedda9f23b` | DBC programdata payload (0.2.1) |
| `damm_v2_mainnet.so` | `4d5b920baebc090f89b2e8796a3452ed067c9667a143058c96a312f2c1e6848b` | DAMM v2 programdata payload (0.2.4) |
| `damm_v2_migration_config_mainnet.json` | `fc5c08462fc2d118b09353121112725a33aa684e0f255719575e09efbc1f4c2f` | account `A8gMrEPJ…Ctck` |
| `squads_v4_mainnet.so` | `dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c` | Squads v4 (multisig rehearsal only) |
| `squads_v4_program_config_mainnet.json` | `6dcbc4560e65bfc97dceb3bb75f801437568d3c417d9f716a332c654c8b9b81d` | Squads ProgramConfig |
| `pyth_sol_usd_mainnet.json` | `7c2ac8b0af827dd08fbcc1de88e1b619dd305d56355412a26729d4c787bc7e88` | SOL/USD `PriceUpdateV2` (attestation USD vectors) |
| `wsol_mint.json` | `11c50ae66cc2efb3b4965bab79ea6b1295f9cd9716c81861302156e015e6e7da` | WSOL mint account |

To check them against mainnet yourself (read-only):
```sh
solana program dump -u mainnet-beta dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN /tmp/dbc.so && shasum -a 256 /tmp/dbc.so
solana program dump -u mainnet-beta cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG /tmp/damm.so && shasum -a 256 /tmp/damm.so
solana account -u mainnet-beta A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck --output json   # compare the data field
# or all at once, with your own RPC (only get* methods are called; the URL is never printed):
cd services && MAINNET_RPC_URL=<rpc> npx tsx scripts/mainnet/fork.ts compare --tested scripts/mainnet/tested-programs.json
```
`services/scripts/mainnet/tested-programs.json` is the manifest of the last passing mainnet rehearsal (mainnet slot
456,589,591). Meteora can upgrade DBC / DAMM v2 at any time (D38): if mainnet differs from the fixtures, replace the
fixture and re-run the suites; `cargo test -p tests derive_exact_curves -- --ignored --nocapture` re-derives the
exact-8% curve configs for a new DBC binary.

---

## 6. Deployed program and reproducing its bytes

**Devnet** (only deployment; nothing is on mainnet):

| | |
|---|---|
| Program id | `5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb` |
| ProgramData | `x92CMm7ipxYGyE97UmNXWXRhq4nN54dWa2Qnnm57cik` (770,280 bytes allocated) |
| Upgrade authority | `9HXgtr92EMgXCYzDC1S3vh9pxvU1AbfygofkPdtMqHwJ` — a single hot key (devnet only; it is also admin and guardian there) |
| Last deployed slot | 510,746,597 |
| Global | `9FfSKTcQ5EiUs7JUtC7jMUcW8czCmi1D1ehqSvrTHLst`, `cluster_tag = 1`; test params (min sell $5, hold 60 s, challenge 1 h, oracle window 600 s / 28 samples, 0.85 SOL curve) — `services/DEPLOY-v07.md` §1 |
| Code | sha256 of the first 754,288 bytes = `0d28b661cfc3fc45c7a07988d67685fee6a6a1f69d4df1f93c06f95a5615e598`; the remaining 15,992 bytes are zero |

Reproduce (checked 2026-10-13 on the toolchain in §4; the local build at `aa137a9` matched byte for byte):
```sh
cd contracts && anchor build -p fumpad
shasum -a 256 target/deploy/fumpad.so                                     # 0d28b661…e598, 754,288 bytes
solana program dump -u devnet 5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb /tmp/devnet.so
head -c 754288 /tmp/devnet.so | shasum -a 256                            # same hash
tail -c +754289 /tmp/devnet.so | tr -d '\0' | wc -c                       # 0 (padding only)
```
Caveat: this is a host build (`cargo build-sbf` via Anchor on macOS arm64), not a Docker-pinned verifiable build.
Byte equality on a different machine / OS is **UNVERIFIED**; if your bytes differ, compare platform-tools
(v1.57), Rust, and that `contracts/.cargo/config.toml` (inliner flags) was picked up. A verifiable build
(`solana-verify build` / `anchor build --verifiable`) with a published hash is planned before mainnet and is not
done yet.

**Mainnet** (planned, `services/LAUNCH-DAY.md`): a fresh program keypair, `declare_id!` changed to it on a release
branch (`services/scripts/mainnet/build-program.ts` performs exactly that substitution in a temp copy and checks
the id is embedded), so the mainnet `.so` differs from the devnet one in the embedded id only. `initialize_global`
from the upgrade-authority key with `cluster_tag = 0`, the bootstrap keepers and the DBC config, `launch_signer` set;
then `propose_admin` → 48 h → `accept_admin` to the Squads vaults, then upgrade authority → admin vault
(`services/MULTISIG.md` §4).
