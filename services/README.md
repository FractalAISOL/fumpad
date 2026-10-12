# FUMPAD off-chain services

TypeScript (Node 22, strict, ESM), npm workspaces, plus one Rust binary. Built against contract **v0.5**
(D19 snipe tax, D20 graduation fee split, `migrate_global`; D17: 8% pool, 1024-entry queue, keeper auto-claim; `contracts/target/idl`, synced into `sdk/src/idl`).

```
services/
  sdk/       @fumpad/sdk      typed client: PDAs, instruction builders, PumpSwap pass-through, math, quotes, events
  indexer/   @fumpad/indexer  chain → Postgres (events, current state, derived game/safety layer)
  api/       @fumpad/api      REST + WebSocket implementing the app's FumpadData contract (+ D18 launch prepare)
  keeper/    @fumpad/keeper   cranks per SPEC §5.4/§7 (+ D17 auto-claim)
  grinder/   fumpad-grinder   Rust: pre-grinds `…fmbL` vanity mint keypairs into Postgres (D18)
  scripts/   local validator harness, e2e, IDL/vector/type generators
  test/integration/           indexer↔db↔api (no chain), vanity pool (grinder↔db↔api), and the full local e2e
```

## Architecture

```
 solana (fumpad, fumpad_lp_locker, PumpSwap pools)
    │  getSignaturesForAddress/getTransaction (canonical, gap-detecting)
    │  + Helius raw webhooks / logsSubscribe (latency only)
    ▼
 indexer ── decode emit_cpi inner-ix events + locker log events ──► Postgres
    │        idempotent per signature, confirmed → finalized, rollback + per-mint replay
    │        chain sync (exact Coin/vault/pool snapshot), derive job (levels, flags)
    │  NOTIFY fumpad_live
    ▼
 api (Fastify) ── REST /v1/* + WS /v1/ws ──► app (app/src/data/api.ts)
     └─ POST /v1/launch/prepare ◄── vanity_mints ◄── grinder (Rust, all cores, AES-256-GCM at rest)
 keeper ── reads chain only (gPA + batched account reads), sends cranks
```

### D18 vanity mints (`…fmbL`)
Every coin launched from the app gets a mint address ending in **`fmbL`** (case-sensitive; app-level only, the
program accepts any fresh mint, like pump.fun's `pump`).

- **grinder** keeps `vanity_mints` topped up to `POOL_TARGET` (200) available keys and sleeps when full. Each match
  needs ~58⁴ = 11.3M random ed25519 keys; the suffix is tested as `n mod 58⁴` on the raw 32-byte key (no base58 encode
  per try) and confirmed with a real encode. The 32-byte seed is stored **AES-256-GCM** encrypted under
  `MINT_POOL_KEY` (nonce ‖ ct ‖ tag, AAD = pubkey so ciphertexts can't be swapped between rows) with a key
  fingerprint so the API only reserves rows it can decrypt (key rotation). `--once N` (tests/seeding), `--bench SECS`.
  Benchmark on an 8-core M1 (4P+4E): **~400k keys/s → ~28 s per `fmbL` key** on a quiet machine (190k–350k/s,
  33–59 s, while other jobs shared the CPU)
  (single thread ~45–67k/s); filling 200 keys ≈ 1.5–3 h, then it only replaces what launches use.
- **API `POST /v1/launch/prepare`** `{creator, name, symbol, uri, initialBuyLamports?, slippageBps?, priorityMicroLamports?}`
  → `{mint, transaction (base64 v0), lastValidBlockHeight, expiresAt, suffix, firstBuy?}`. The server reserves one
  mint (`FOR UPDATE SKIP LOCKED` inside a per-creator advisory lock: concurrent prepares never share a mint, a wallet
  holds at most one), builds `[compute budget] create_coin [+ creator's first buy]` with the creator as fee payer,
  and signs **only as the mint**. The secret is decrypted into an opaque node `KeyObject` for that one signature and
  never returned or logged. Preparing again (e.g. the blockhash expired in the review dialog) returns the same mint.
  Validation mirrors the program (UTF-8 bytes: name ≤ 32, symbol ≤ 10, uri ≤ 200, non-empty) + https/ipfs/ar URIs, no
  control chars, creator must be an on-curve wallet. Limits: per-IP route limit, per-wallet window, max active
  reservations per IP. Pool empty → `503` + `Retry-After`. Disabled (503) when `MINT_POOL_KEY` is unset.
  - *Why prepare (server-built) and not cosign (client-built)?* The server only ever signs bytes it assembled, so
    there is no transaction parser to get wrong (smuggled instructions, lookup tables, a different fee payer or extra
    writable accounts riding on the mint signature). The mint signature also pins the message: neither the client nor
    a wallet can alter it afterwards. The app still checks the returned tx (`app/src/chain/program.ts`
    `checkPreparedLaunch`: fee payer = wallet, only ComputeBudget + FUMPAD create_coin[+buy], advertised `…fmbL` mint)
    before asking the wallet to sign, so a compromised API can't get anything else signed.
- **Lifecycle**: `available → reserved → used`. The indexer marks a mint `used` (and wipes its secret) on
  `CoinCreated`. The API sweeper (`LAUNCH_SWEEP_SECS`) returns a reservation to the pool only when it is older than
  `LAUNCH_RESERVATION_MINUTES` (10) **and** the chain is past the `lastValidBlockHeight` of every tx co-signed for it
  **and** the mint account doesn't exist (if it does, it becomes `used`). `/health` reports `vanityPool` counts.
- SDK: `isFumpadVanityMint(pubkey, suffix = "fmbL")`, `launchMetadataError`, `inspectLaunchTx`; `buildLaunch` accepts a
  mint `PublicKey` (co-signed elsewhere) as well as a `Keypair`.

### D19 / D20 (v0.5) — and the still-live v0.4 devnet program
- **Older layouts decode.** `decodeTransactionEvents` / `decodeEventRaw` accept pre-v0.5 `Trade`, `Graduated`,
  `ParamsQueued`/`ParamsUpdated` (fields appended in v0.5 read as 0; `FumpadEvent.legacy = true`), with a strict length
  check (Anchor's decoder silently accepts short u64 tails). `decodeGlobal` reads the 672-byte Global (`legacyLayout`).
- **Indexer** (migration 005): `trades.snipe_tax/snipe_tax_bps`; per coin `snipe_tax_lamports`, `snipe_taxed_buys`,
  `pool_inflow_lamports` (pool fee share + snipe tax) and the graduation split (`graduation_caller_refund`,
  `_setup_prefunded`, `_platform_fee`; NULL for a v0.4 `Graduated`). Buy cost basis (positions, ledger) includes the tax.
- **API**: `TradeRow.snipeTaxSol/snipeTaxBps`, `CoinSummary.snipeTaxSol/snipeTaxedBuys`, `CoinDetail.poolInflowSol`,
  `FeedLaunch.snipeTaxSol`, `/v1/params` `snipeWindowSlots`, `snipeStartBps`, `graduationFeeSol`; `/v1/quote` buys inside
  the launch window carry `snipeTaxSol/snipeTaxBps` (quoted at the current slot; the creator's launch-slot buy is exempt).
- **Upgrade**: after the program upgrade run `npx tsx scripts/devnet/migrate-global.ts` (admin key) — see CONTRACTS.md.

### D17 auto-claim (v0.4)
Keeper job `autoclaim` (`JOB_AUTOCLAIM`, on): for each graduated coin whose covered keeper median reaches its lowest
open trigger, `claim_for` every Open ticket that triggers, oldest sell first, unless the owner opted out
(`Position.auto_claim_opt_out`, `set_auto_claim`), skipping wallets at the D16 limit unless the claim pays now; each tx
first creates the owner's ATA (keeper-paid, idempotent) so payouts don't escrow. Respects the claims pause. "Not now"
errors (TriggerNotMet, InsufficientSamples, WalletQueueLimit, AutoClaimDisabled, …) are skips, not failures. Indexer:
`claims.triggered_by` + generated `auto`, `queue_entries.triggered_by`, `tickets.auto_claimed`,
`positions.auto_claim_opt_out` (AutoClaimSet); the feed's claim posts carry `auto` ("Auto-claimed …"), tickets carry
`autoClaim` / `autoClaimed` (app: per-coin toggle on My Fumbles).

### Stack choices
- **@solana/web3.js v1** (not @solana/kit): the app's wallet adapter and Anchor's TS client both speak v1
  `Transaction`/`VersionedTransaction`/`PublicKey`; one type family end to end.
- **@anchor-lang/core 1.2.1** `BorshCoder` only (matches anchor-cli 1.2.1 that generated the IDL) for
  instruction/event/account encoding; account **order** comes from the IDL (`sdk/src/instructions/metas.ts`), so a
  contract change that reorders/renames accounts fails loudly in `idlMetas` and in `sdk/test/instructions.test.ts`.
  All builders live in `sdk/src/instructions/` (the one module to touch on contract changes).
- SDK is browser-safe (no `node:` imports; uses `Buffer`, which Next polyfills as for web3.js).
- **pg** + plain SQL migrations (`indexer/migrations`), **Fastify** (+rate-limit, websocket, cors), **pino** JSON logs, **vitest**.

### SDK
- `pda.ts` every PDA (coin, vaults, position, ticket, observations, queue, escrow, graduation WSOL, pool, LP mint, lock…).
- `instructions/` builders for **every** fumpad (22) + locker (2) instruction; PumpSwap v2 17-account venue slice,
  15-account withdraw slice, buyback-fee-recipient from GlobalConfig, WSOL wrap helpers, compute budgets (`CU`, measured).
- `math/` bigint port of curve/fees/price/reference (touch kinds)/rewards (R-L2 unseen arrivals)/median (keeper-only,
  5-of-6 buckets). **Tested against numbers produced by the program's own Rust functions**: `sdk/test-vectors` is a
  tiny Rust crate depending on `contracts/programs/fumpad`; `npm run vectors` regenerates `sdk/test/vectors.json`.
- `quote.ts` curve quotes exact (verified equal to on-chain `Trade` events), PumpSwap CP approximation using the live
  Pump Fees `FeeConfig.flat_fees` (30 bps on the devnet dump; observed error ~2e-9), D10/D12 ticket preview, rebuy preview.
- `events.ts` emit_cpi decoding (authority-checked, failed txs ignored) + locker `Program data:` logs via the invoke stack.
- `client.ts` `FumpadClient`: reads chain state and returns ready instruction lists (`buildBuy/Sell/Launch/Claim/...`,
  cranks), polling confirmation (no websocket dependency).

### Indexer
Tables (`migrations/001_init.sql`): raw `transactions`/`events` (with re-decodable `raw`), `coins`, `trades`,
`tickets`, `ticket_debits`, `claims`, `queue_entries`, `samples`, `buybacks`, `fee_withdrawals`, `lp_locks`,
`lp_skims`, `lp_settlements`, `holdings_registered`, `positions`, `users`, `feed_events`, `external_trades`,
`wallet_funding`, `wallet_clusters`, `wallet_flags`, `user_stats`.
- **Sources**: per-address cursors (fumpad, locker, every graduated pool); backfill from `BACKFILL_FROM_SLOT`;
  `reconcile` re-scans the newest N signatures (gap detection); Helius raw webhook `POST /helius`; `logsSubscribe` pokes.
- **Reorgs**: ingest at `confirmed`; finalizer upgrades to `finalized`, deletes transactions unknown after 3 min and
  rebuilds affected mints from `events` (`replay.ts`; also `npm run migrate -w @fumpad/indexer -- replay <mint>`).
- **Flags** (public, leaderboard-excluding, never blocking): `rebuy_elsewhere` (seller rebuys directly on the coin's
  PumpSwap pool within the rebuy window — from pool tx token deltas), `creator_linked` (ticket holder in the creator's
  funding cluster), `linked_wallets` (≥2 wallets of one cluster with tickets on a coin). Funding graph = first funder of
  each wallet; funders of > 25 wallets are hubs (exchanges) and ignored.
- Levels/XP/achievements in `user_stats` (same achievement ids as the mock).

### Performance at mainnet volume (migration 006, `scripts/loadtest.ts`)
- Lists pick their page from plain columns, then build only those rows. 24 h volume = whole hours from
  `coin_hourly` + the partial edge hour from `trades`; holder counts from `coin_holders`. Both tables are kept
  exact by row triggers on `trades` / `positions` (so ingest, replay and rollback maintain them);
  `SELECT fumpad_rebuild_aggregates()` recomputes them.
- Sparklines are batched (quiet coins: one range scan; busy coins: 48 index probes) and memoized 15 s per coin;
  the trending rank is shared for 5 s. Neither is dropped on every trade (the response cache is).
- Live: every NOTIFY invalidates the cache at once; WebSocket clients get one `coins` + one `coin` message per
  touched mint per 250 ms window, serialized once for all clients.
- `/v1/status`: indexer lag (heartbeat in `meta`, every 15 s), keeper last-sample age, vanity pool, versions.

### API
Routes map 1:1 to `FumpadData` (see `/openapi.json`; schemas generated from the app types). `api/src/contract-check.ts`
fails `tsc` if any route payload type differs from the app interface; `api/test/contract.test.ts` fails if the copied
app types drift (`npm run api-types`). Quotes/balances read chain (RPC, 2 s cache); everything else Postgres with a TTL
cache cleared by the indexer's NOTIFY. Per-IP rate limits (quote stricter), WS connection cap per IP.

**App switch:** `app/src/data/api.ts` adds `ApiFumpadData` + `apiDataFromEnv()`. To enable, the app owner changes
`getFumpadData()` in `app/src/data/index.ts` to `return apiDataFromEnv() ?? mockData;` and sets
`NEXT_PUBLIC_FUMPAD_API` (optional `NEXT_PUBLIC_FUMPAD_WS`). (Left unchanged here: api.ts is the only app change.)

### Keeper
Jobs: sampling (heartbeat every graduated coin, full rate near triggers / pending buybacks, batches ≤5 legacy,
6–10 v0 + lookup table it manages, coins past half their interval ride along), graduate + post-graduation setup (init_observations, then 9× init_claim_queue in one tx: 1024-entry queue, 81,976 bytes, ~69k CU), auto-claim (D17),
execute_buyback (median/±3% pre-checked), process_queue (owner ATAs created first, ≤13 entries), skim+settle
(NothingToSkim = skip), withdraw_platform_fees, execute_params after the 48 h timelock. Dynamic priority fee
(percentile of recent fees on written accounts, clamped), retries on expiry, in-flight guards, `DRY_RUN=true`
(simulate only), `/health`, Telegram alerts (job failing ×3, low balance, graduation failure).

## Environment

| var | service | notes |
|---|---|---|
| `DATABASE_URL` | indexer, api | Postgres |
| `RPC_URL` | all | defaults to Helius mainnet if `HELIUS_API_KEY` set, else `http://127.0.0.1:8899` |
| `HELIUS_API_KEY` | all | builds RPC + WS URLs |
| `WS_URL` | indexer | optional logsSubscribe endpoint |
| `HELIUS_WEBHOOK_SECRET` | indexer | expected `Authorization` header on `POST /helius` |
| `INDEXER_COMMITMENT`, `BACKFILL_FROM_SLOT`, `POLL_INTERVAL_MS`, `RECONCILE_*`, `FINALIZE_INTERVAL_MS`, `DERIVE_INTERVAL_MS`, `FETCH_METADATA` | indexer | tuning |
| `KEEPER_KEYPAIR` (path) or `KEEPER_SECRET_KEY` (JSON array / base58) | keeper | must be a registered keeper (`set_keepers`) |
| `DRY_RUN` | keeper | simulate only |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | keeper | optional alerts |
| `FULL_RATE_SECS` (15), `HEARTBEAT_SECS` (480), `BUYBACK_MIN_LAMPORTS`, `SKIM_INTERVAL_SECS`, `PLATFORM_FEES_MIN_LAMPORTS`, `PRIORITY_*`, `USE_LOOKUP_TABLE`, `JOB_*` (=false to disable), `MIN_KEEPER_LAMPORTS` | keeper | policy |
| `PORT` | all | health (indexer/keeper; indexer also serves `/helius`) / HTTP (api) |
| `CORS_ORIGINS`, `RATE_LIMIT_PER_MIN`, `QUOTE_RATE_LIMIT_PER_MIN`, `RATE_LIMIT_ALLOW`, `MAX_WS_PER_IP`, `PYTH_SOL_USD_ACCOUNT`, `SOL_USD_FALLBACK` | api | |
| `MINT_POOL_KEY` | grinder, api | 32 bytes (64 hex or base64), **sealed**; same value in both. Unset on the API = launches disabled |
| `VANITY_SUFFIX` (`fmbL`) | grinder, api | must match |
| `LAUNCH_RESERVATION_MINUTES` (10), `LAUNCH_SWEEP_SECS` (15), `LAUNCH_RATE_LIMIT_PER_MIN` (10/IP), `LAUNCH_WALLET_LIMIT_PER_MIN` (6), `LAUNCH_MAX_ACTIVE_PER_IP` (3), `LAUNCH_MAX_INITIAL_BUY_LAMPORTS` (100 SOL), `LAUNCH_MAX_PRIORITY_MICROLAMPORTS` | api | D18 prepare |
| `POOL_TARGET` (200), `GRINDER_THREADS` (cores), `POOL_POLL_SECS` (30) | grinder | |
| `JOB_AUTOCLAIM`, `AUTOCLAIM_INTERVAL_SECS` (15), `AUTOCLAIM_MAX_PER_RUN` (20) | keeper | D17 |
| `LIVE_COALESCE_MS` (250), `WS_MAX_BUFFERED_BYTES` (4 MiB) | api | WebSocket: per-coin coalescing window; drop clients with this much unsent |
| `STATUS_KEEPER_URL` | api | optional keeper `/health` (private network) probed by `/v1/status` |
| `GIT_SHA` | api, indexer | build shown on `/v1/status` (else `RAILWAY_GIT_COMMIT_SHA`; Railway's deployment id is always shown) |
| `LOG_LEVEL` | all | |

## Run locally

Prereqs: `anchor build` in `contracts/`, Solana CLI (`solana-test-validator`), Rust (`cargo`, for the grinder),
Postgres (`DATABASE_URL`, or `docker compose up -d postgres`, or Homebrew `initdb`/`pg_ctl` which the scripts use
automatically). `npm run local` builds and starts the grinder (pool target 2) first, then launches the scenario's coin
through `POST /v1/launch/prepare` and checks the mint ends in `fmbL`; alice is auto-claimed by the keeper while eve
opts out and claims by hand.

```
cargo build --release --manifest-path grinder/Cargo.toml
grinder/target/release/fumpad-grinder --bench 30            # keys/s on this machine
DATABASE_URL=… MINT_POOL_KEY=$(openssl rand -hex 32) grinder/target/release/fumpad-grinder --once 5
cargo test --release --manifest-path grinder/Cargo.toml    # suffix fast path vs bs58, crypto format vector
```

```
npm install
npm run typecheck          # all packages + scripts/tests
npm test                   # unit: SDK math vs Rust vectors, builders vs IDL, events, keeper policy, API contract
npm run local              # full e2e (validator + Postgres + indexer + API + keeper), ~5 min, stops everything
npm run test:integration   # indexer↔db↔api (synthetic events) + the same e2e under vitest
npm run validator          # long-running dev chain + Postgres; prints how to start the services
npm run smoke              # SDK-only lifecycle on the validator (`-- --indexer` adds a backfill check)
npm run sync-idl           # after `anchor build`: copy IDLs/types into the SDK
npm run vectors            # regenerate math vectors from the Rust crate
npx tsx scripts/loadtest.ts # seed a scratch Postgres at mainnet volume (5k coins, 2M trades, 200k tickets,
                            # 50k wallets), p50/p95 per endpoint (cache off) + a 200 trades/s WebSocket burst
```
The validator loads `fumpad` as upgradeable (authority = `.local/upgrade-authority.json`, needed by
`initialize_global`), the locker **immutable**, PumpSwap + pump-fees + GlobalConfig + FeeConfig from
`contracts/tests/fixtures`, and a Pyth SOL/USD account at $150 with a future publish time. Local Global params:
2 s hold, 60 s oracle window, 3 min samples, 2 s spacing (`scripts/local/actors.ts`).

## Railway deployment plan (not deployed)
One Railway project, one Postgres plugin, four services from this monorepo (root directory `services/`):

| service | build | start | env | notes |
|---|---|---|---|---|
| `indexer` | `npm ci && npm run build` | `node indexer/dist/main.js` | `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `HELIUS_API_KEY`, `HELIUS_WEBHOOK_SECRET`, `PORT` | 1 replica (cursors); health `/health`; public URL for the Helius webhook (`/helius`, raw type, accounts = fumpad, locker, + pools: re-sync from `SELECT amm_pool FROM coins`) |
| `api` | same | `node api/dist/main.js` | `DATABASE_URL`, `HELIUS_API_KEY`, `CORS_ORIGINS=https://fumpad.fun`, `MINT_POOL_KEY` (sealed), `PORT` | horizontal OK (cache per instance; reservations are DB-atomic); health `/health` (incl. `vanityPool`); custom domain `api.fumpad.fun` |
| `keeper` | same | `node keeper/dist/main.js` | `HELIUS_API_KEY` (or dedicated RPC), `KEEPER_SECRET_KEY` (sealed variable), `TELEGRAM_*`, `PORT` | **exactly 1 replica**; health `/health` with restart policy; fund the keeper and register it via `set_keepers` (multisig); budget SOL for owner-ATA rent on auto-claims |
| `grinder` | Dockerfile/Nixpacks with Rust: `cargo build --release --manifest-path grinder/Cargo.toml` | `grinder/target/release/fumpad-grinder` | `DATABASE_URL=${{Postgres.DATABASE_URL}}` (private network: the binary connects without TLS), `MINT_POOL_KEY` (sealed, same as api), `POOL_TARGET=200`, `GRINDER_THREADS` = vCPUs | worker, no port; 1 replica (more just fill faster); CPU-bound only while topping up, then sleeps. Use a CPU-heavy plan briefly to fill the first 200, then scale down |

Migrations run on indexer start (advisory-locked; the grinder waits for `vanity_mints`). No volumes needed (state is
Postgres + chain). Run the keeper first with `DRY_RUN=true` against mainnet to review its plan. Backups: Railway Postgres
snapshots; the DB can always be rebuilt from chain (`BACKFILL_FROM_SLOT` = program deploy slot) — except the vanity
pool, which is just regrown. Rotating `MINT_POOL_KEY`: deploy the new key to grinder + api together; rows under the
old key fingerprint are ignored (delete them once no reservation uses them).

## Known gaps
- Vanity pool drain: someone with many IPs + wallets can reserve the pool faster than it regrows (rate limits, 1
  reservation per wallet, 3 per IP, 10-min expiry bound it). If the pool is empty the app shows "try again in a
  minute"; a fallback to a random (non-`fmbL`) mint is deliberately not offered.
- Coin metadata JSON upload is still a placeholder in the app (`uri: ipfs://pending`).
- `escrowed` tickets map to the app's `claimed` state (the app types have no escrow state / withdraw action yet).
- Holders are FUMPAD-observed balances (trades + claims), not full SPL holder lists.
- Funding-graph heuristic is first-funder only; no exchange allow-list.
- Social counters (`replies`, `reposts`) and user names are always empty (no source yet).
- Expired tickets are derived by time in the API; on-chain `close_ticket` cranking is not done by the keeper.
