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
 keeper ── reads chain (status-filtered gPA + batched account reads), sends cranks;
            Postgres only for its single-instance lock + persisted lookup table / spend
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
  control chars, creator must be an on-curve wallet. Pool empty → `503` + `Retry-After`. Disabled (503) when
  `MINT_POOL_KEY` is unset.
  - **Proof of wallet control (M-2)**: the body carries `auth: { message, signature }`, the creator wallet's
    ed25519 `signMessage` over exactly
    `FUMPAD launch\ncreator: <creator>\nsymbol: <symbol>\nnonce: <16-64 [A-Za-z0-9_-]>\nissuedAt: <unix ms>`
    (signature base58 or base64; accepted for `LAUNCH_SIGNATURE_MAX_AGE_SECS`, 600). Missing/invalid → `401`,
    nothing reserved. `api/src/launch/auth.ts` (`launchAuthMessage`, `signLaunchAuth` for scripts/tests).
  - **Drain guards**: creator balance ≥ `LAUNCH_MIN_BALANCE_LAMPORTS` (0.01 SOL); per-IP route limit and max active
    reservations per IP (on the real client IP, see H-2 below); per-wallet window; one reservation per wallet; the
    last `LAUNCH_POOL_RESERVE` (5) available mints only go to wallets the indexer already knows (`users`).
  - **No RPC inside a DB transaction**: reserve (short tx) → build with RPC (`LAUNCH_RPC_TIMEOUT_MS`, 5 s) → sign
    (short tx). A fresh reservation whose build fails/times out goes straight back to the pool.
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
  `reconcile` re-scans the newest N signatures (gap detection); `logsSubscribe` pokes. The cursor never moves past a
  listed signature whose transaction couldn't be fetched (M-5): it waits just before it, the signature sits in a
  retry queue, and only after 10 min of "not found" (a dropped fork) is it skipped (logged as an error).
- **Webhook** `POST /helius` (only when `HELIUS_WEBHOOK_SECRET` is set; `HELIUS_WEBHOOK_ENABLED=true` without a
  secret refuses to boot): Authorization compared in constant time, body ≤ `WEBHOOK_MAX_BODY_BYTES` (1 MiB). The
  body is a **hint** (H-1): only signatures are taken from it (raw or enhanced shape, ≤ 100 per request), each is
  re-fetched from our own RPC and ingested only if the real transaction touches fumpad, the locker or a watched pool.
- **Reorgs**: ingest at `confirmed`; finalizer upgrades to `finalized`. A row is rolled back only after
  `FINALIZE_DROP_MISSES` (3) consecutive status checks found it unknown, it is older than `FINALIZE_DROP_AFTER_SECS`
  (180), **and** `getTransaction` also returns nothing (M-4); pending rows are paged (keyset, 10 × 200 per run). The
  affected mints are rebuilt from `events` (`replay.ts`; also `npm run migrate -w @fumpad/indexer -- replay <mint>`).
- **Coin metadata** (`uri` of any coin, M-3): https, `ipfs://` (via `IPFS_GATEWAY`) and `ar://` only; every DNS answer
  and every redirect hop (manual, ≤ 3) must be a public address (no loopback/private/CGNAT/link-local/metadata/
  NAT64/mapped forms), connection pinned to the checked address, 64 KiB, 5 s. Failures store a coarse code only.
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
cache cleared by the indexer's NOTIFY (targeted: the touched mints/wallets and the small cross-coin lists, L-11).
Per-IP rate limits (quote stricter), WS connection caps per IP and global (`MAX_WS_TOTAL`); every query/path param
is schema-validated (400, L-3).

- **Client IP (H-2)**: `trustProxy` trusts exactly `TRUST_PROXY_HOPS` hops (default 1 in production = Railway's
  edge; 0 locally) plus optional `TRUST_PROXY_CIDRS`; `req.ip` is the first untrusted address from the right, so a
  client-prepended `X-Forwarded-For` entry is never used. Verified live on Railway (Oct 12 2026): the edge discards
  client-sent `X-Forwarded-For` (spoofed values didn't change the rate-limit bucket) and request logs carry
  `xffHops` to re-check the hop count after platform changes. One derivation for everything (rate limits, WS caps,
  launch per-IP caps, waitlist).
- **SSR (replaces `RATE_LIMIT_ALLOW`)**: the app's server-side renderer sends `x-fumpad-ssr: <API_SSR_SECRET>`; such
  requests skip rate limits and get the detailed `/health`. IP allow-listing is gone (`RATE_LIMIT_ALLOW` is ignored).
- **Health (L-5)**: public `/health` = `{ ok }`; with the SSR header: version, indexer lag, WS/live/cache stats,
  vanity pool. `/v1/status` (public, levels only) is unchanged.
- **Coins by mint (H-3)**. Symbols are not unique, so mints are the coin id:
  - `GET /v1/coins/by-mint/:mint` → `CoinDetail` | 404.
  - `GET /v1/coins/by-symbol/:symbol?limit=` → `CoinSummary[]`, every case-insensitive match (leading `$` optional),
    **newest first**, `[]` when none.
  - `GET /v1/coins/:id` (legacy, what the app calls today): an exact mint wins; a symbol matching exactly one coin
    returns it; a symbol shared by several coins returns **`300`** `{ error, symbol, matches: CoinSummary[] }`
    (newest first, `Link` → by-symbol) instead of silently picking the oldest. Every other per-coin route
    (`/prices`, `/holders`, `/fumbles`, `/queue`, `/trades`, `/v1/quote`) only accepts a mint.

**App switch:** `app/src/data/api.ts` adds `ApiFumpadData` + `apiDataFromEnv()`. To enable, the app owner changes
`getFumpadData()` in `app/src/data/index.ts` to `return apiDataFromEnv() ?? mockData;` and sets
`NEXT_PUBLIC_FUMPAD_API` (optional `NEXT_PUBLIC_FUMPAD_WS`). (Left unchanged here: api.ts is the only app change.)

### Keeper
Jobs: sampling (heartbeat every graduated coin, full rate near triggers / pending buybacks, batches ≤5 legacy,
6–10 v0 + lookup table it manages, coins past half their interval ride along), graduate + post-graduation setup (init_observations, then 9× init_claim_queue in one tx: 1024-entry queue, 81,976 bytes, ~69k CU), auto-claim (D17),
execute_buyback (median/±3% pre-checked), process_queue, skim+settle
(NothingToSkim = skip), withdraw_platform_fees, execute_params after the 48 h timelock. Dynamic priority fee
(percentile of recent fees on written accounts, clamped to `PRIORITY_MAX_MICROLAMPORTS` and to
`PRIORITY_MAX_LAMPORTS_PER_TX` per transaction), retries on expiry, in-flight guards, `DRY_RUN=true`
(simulate only), `/health` (slim: ok, version, loop age, failing job names, over-budget flag), Telegram alerts
(job failing ×3, low balance, graduation failure, zero-pay queue runs, daily budget exceeded).
- **process_queue (H-4)**: the keeper simulates the program's skip-ahead walk on the live pool (per-claim cap of the
  shrinking pool) and passes account quadruples for exactly the entries that will be paid (≤ 13), so a head of
  non-fitting claims can't stall the queue. It no longer creates owner ATAs (an owner could close the ATA and farm the
  rent); a missing/closed ATA escrows the payout on chain (escrow rent refundable to the keeper via
  `withdraw_escrow`). A run that pays nothing alerts and backs off exponentially (up to 32 intervals).
- **Spend (M-7)**: `KEEPER_DAILY_BUDGET_SOL` (2) measured as keeper-balance decreases since 00:00 UTC (persisted);
  over budget → alert, and only `sample`, `graduate`, `params` keep sending until the next UTC day. The lookup
  table is reused across restarts (`KEEPER_LOOKUP_TABLE`, else the address persisted in `meta`); a full table is
  deactivated and closed later (rent back). Complete/graduated coins are scanned with a status filter every
  `SCAN_INTERVAL_SECS`; the full scan (incl. curve coins, only needed for platform fees) every
  `FULL_SCAN_INTERVAL_SECS` (600); curve coins are not re-read every loop.
- **Single instance (L-10)**: with `DATABASE_URL` (required in production) the keeper takes a Postgres advisory lock
  (`7271002`) before its first send; a second instance waits; losing the lock connection exits the process.

## Environment

Production (`NODE_ENV=production`, set by the Dockerfile) fails at boot when a required variable is missing. The
cluster is never inferred: no mainnet default from `HELIUS_API_KEY`; outside production an unset `RPC_URL` means the
local validator.

| var | service | notes |
|---|---|---|
| `DATABASE_URL` | indexer, api, keeper, grinder | **required**. Use a separate role per service (see "Database roles") |
| `RPC_URL` | indexer, api, keeper | **required in production** (explicit cluster). Separate Helius key per service |
| `WS_URL` | indexer | optional logsSubscribe endpoint (explicit; no longer derived from `HELIUS_API_KEY`) |
| `HELIUS_WEBHOOK_SECRET` | indexer | ≥ 24 chars; enables `POST /helius` (Authorization header, constant-time). Unset = no webhook route |
| `HELIUS_WEBHOOK_ENABLED` | indexer | `true` without a secret = boot failure |
| `WEBHOOK_MAX_BODY_BYTES` (1 MiB) | indexer | webhook body limit (413 above) |
| `IPFS_GATEWAY` (`https://ipfs.io/ipfs/`) | indexer | gateway for `ipfs://` metadata |
| `FINALIZE_DROP_MISSES` (3), `FINALIZE_DROP_AFTER_SECS` (180) | indexer | rollback only after N consecutive misses + age + getTransaction cross-check |
| `INDEXER_COMMITMENT`, `BACKFILL_FROM_SLOT`, `POLL_INTERVAL_MS`, `RECONCILE_*`, `FINALIZE_INTERVAL_MS`, `DERIVE_INTERVAL_MS`, `FETCH_METADATA` | indexer | tuning |
| `CORS_ORIGINS` | api | **required in production**, explicit comma-separated origins (`*` refused). Live: `https://fumpad.app,https://www.fumpad.app,https://fumpad.vercel.app,http://localhost:3100` |
| `API_SSR_SECRET` | api (+ app server env) | **required in production**, ≥ 32 chars, sealed. Sent by the app's SSR as `x-fumpad-ssr`: no rate limit, detailed `/health` |
| `TRUST_PROXY_HOPS` (prod 1, else 0) | api | reverse-proxy hops whose `X-Forwarded-For` entries are trusted (Railway edge = 1) |
| `TRUST_PROXY_CIDRS` | api | optional extra trusted proxy networks |
| `RATE_LIMIT_PER_MIN` (600), `QUOTE_RATE_LIMIT_PER_MIN` (120), `MAX_WS_PER_IP` (5), `MAX_WS_TOTAL` (5000) | api | per client IP; WS global cap |
| ~~`RATE_LIMIT_ALLOW`~~ | api | removed (ignored): use `API_SSR_SECRET` |
| `PYTH_SOL_USD_ACCOUNT`, `SOL_USD_FALLBACK` | api | |
| `MINT_POOL_KEY` | grinder, api | 32 bytes (64 hex or base64), **sealed**; same value in both. Unset on the API = launches disabled |
| `VANITY_SUFFIX` (`fmbL`) | grinder, api | must match |
| `LAUNCH_RESERVATION_MINUTES` (10), `LAUNCH_SWEEP_SECS` (15), `LAUNCH_RATE_LIMIT_PER_MIN` (10/IP), `LAUNCH_WALLET_LIMIT_PER_MIN` (6), `LAUNCH_MAX_ACTIVE_PER_IP` (3), `LAUNCH_MAX_INITIAL_BUY_LAMPORTS` (100 SOL), `LAUNCH_MAX_PRIORITY_MICROLAMPORTS` | api | D18 prepare |
| `LAUNCH_REQUIRE_SIGNATURE` (true), `LAUNCH_SIGNATURE_MAX_AGE_SECS` (600), `LAUNCH_MIN_BALANCE_LAMPORTS` (0.01 SOL), `LAUNCH_POOL_RESERVE` (5), `LAUNCH_RPC_TIMEOUT_MS` (5000) | api | M-2 drain guards |
| `WAITLIST_RATE_LIMIT_PER_MIN` (5), `WAITLIST_PER_IP_PER_DAY` (20), `WAITLIST_IP_SALT` | api | pre-launch waitlist |
| `KEEPER_KEYPAIR` (path) or `KEEPER_SECRET_KEY` (JSON array / base58) | keeper | **required**, sealed; must be a registered keeper (`set_keepers`) |
| `KEEPER_DAILY_BUDGET_SOL` (2) | keeper | over budget: alert, essential jobs only |
| `PRIORITY_MIN_MICROLAMPORTS` (1000), `PRIORITY_MAX_MICROLAMPORTS` (1,000,000), `PRIORITY_MAX_LAMPORTS_PER_TX` (200,000), `PRIORITY_PERCENTILE` (75) | keeper | priority fee clamps |
| `KEEPER_LOOKUP_TABLE` | keeper | reuse this ALT (else the one persisted in `meta`) |
| `FULL_SCAN_INTERVAL_SECS` (600), `SCAN_INTERVAL_SECS` (30), `TICKET_SCAN_INTERVAL_SECS` (60) | keeper | scan limits |
| `DRY_RUN` | keeper | simulate only |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | keeper | alerts (set them for mainnet) |
| `FULL_RATE_SECS` (15), `HEARTBEAT_SECS` (480), `BUYBACK_MIN_LAMPORTS`, `SKIM_INTERVAL_SECS`, `PLATFORM_FEES_MIN_LAMPORTS`, `USE_LOOKUP_TABLE`, `JOB_*` (=false to disable), `MIN_KEEPER_LAMPORTS` | keeper | policy |
| `JOB_AUTOCLAIM`, `AUTOCLAIM_INTERVAL_SECS` (15), `AUTOCLAIM_MAX_PER_RUN` (20) | keeper | D17 |
| `POOL_TARGET` (200), `GRINDER_THREADS` (cores), `POOL_POLL_SECS` (30) | grinder | |
| `DATABASE_SSL` (`prefer`), `DATABASE_SSL_ROOT_CERT` | grinder | `disable` / `prefer` / `require` (TLS, cert unverified: Railway's self-signed Postgres) / `verify-full` (+ CA bundle) |
| `PORT` | indexer, api, keeper | health (indexer/keeper; indexer also serves `/helius` when enabled) / HTTP (api) |
| `LIVE_COALESCE_MS` (250), `WS_MAX_BUFFERED_BYTES` (4 MiB) | api | WebSocket: per-coin coalescing window; drop clients with this much unsent |
| `STATUS_KEEPER_URL` | api | optional keeper `/health` (private network) probed by `/v1/status` |
| `GIT_SHA` | api, indexer, keeper | build shown on `/v1/status` (else `RAILWAY_GIT_COMMIT_SHA`) |
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

## Railway deployment (devnet: project `fumpad-devnet`)
One project, one Postgres (`postgres-ssl`), four services. Deploy from `services/`, in this order:
`railway up --service indexer --detach`, then `api`, then `keeper`, then
`railway up grinder --path-as-root --service grinder --detach`. Set new variables first with
`railway variables --service <name> --set … --skip-deploys` (secrets via `--set-from-stdin`).

| service | image | required env | notes |
|---|---|---|---|
| `indexer` | `Dockerfile`, `SERVICE_ENTRY=indexer/dist/main.js` | `DATABASE_URL`, `RPC_URL` (+ `WS_URL`, `HELIUS_WEBHOOK_SECRET` if the webhook is used) | 1 replica (cursors); private (only `/helius` would need a public domain) |
| `api` | same, `api/dist/main.js` | `DATABASE_URL`, `RPC_URL`, `CORS_ORIGINS`, `API_SSR_SECRET`, `TRUST_PROXY_HOPS=1`, `MINT_POOL_KEY` | public; horizontal OK |
| `keeper` | same, `keeper/dist/main.js` | `DATABASE_URL`, `RPC_URL`, `KEEPER_SECRET_KEY` | private; the advisory lock enforces one active instance |
| `grinder` | `grinder/Dockerfile` | `DATABASE_URL`, `MINT_POOL_KEY` | worker, no port |

Containers run as non-root (`node` / `grinder`, L-9). Migrations run on indexer start (advisory-locked; the grinder
waits for `vanity_mints`). Run a new keeper first with `DRY_RUN=true` to review its plan. Only the API (and `/helius`
if used) may be public; Postgres stays on the private network.

### Database roles (L-4)
All services currently share the Postgres owner role. Before mainnet create one role per service (grants below;
the indexer owns the schema and runs migrations):
```sql
CREATE ROLE fumpad_indexer LOGIN PASSWORD '…';                 -- owner of the schema (migrations), all tables
CREATE ROLE fumpad_api LOGIN PASSWORD '…';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO fumpad_api;
GRANT SELECT, UPDATE ON vanity_mints TO fumpad_api;             -- reserve / sign / sweep
GRANT INSERT, SELECT ON waitlist TO fumpad_api; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO fumpad_api;
CREATE ROLE fumpad_keeper LOGIN PASSWORD '…';
GRANT SELECT, INSERT, UPDATE ON meta TO fumpad_keeper;          -- ALT + spend; advisory locks need no grant
CREATE ROLE fumpad_grinder LOGIN PASSWORD '…';
GRANT SELECT, INSERT ON vanity_mints TO fumpad_grinder;         -- nothing else
```
(`LISTEN` needs no grant; re-run the API `SELECT` grant after migrations that add tables, or use
`ALTER DEFAULT PRIVILEGES FOR ROLE fumpad_indexer IN SCHEMA public GRANT SELECT ON TABLES TO fumpad_api`.)
The grinder connects with TLS by default (`DATABASE_SSL=prefer`; `require` on Railway's SSL Postgres).

## Runbooks

**Pause.** Admin (multisig) sends `set_pause(flags)` (`setPauseIx`: `PAUSE_LAUNCH`=1, `PAUSE_TRADE`=2,
`PAUSE_CLAIMS`=4, OR them). The keeper skips auto-claims and `process_queue` while claims are paused; the API keeps
serving reads. To stop new launches off-chain only: unset `MINT_POOL_KEY` on the API (prepare → 503). Unpause with
`set_pause(0)`.

**Keeper key rotation.** 1) `solana-keygen new` → fund it. 2) Admin `set_keepers([old, new])`. 3) Railway: set
`KEEPER_SECRET_KEY` (stdin) on `keeper`, redeploy; the new process waits for the lock until the old one exits.
4) Admin `set_keepers([new])`. 5) Drain the old key's SOL; its lookup table can be closed from the old key
(`deactivate` → wait ~513 slots → `close`). The new keeper creates and persists its own table
(`meta` key `keeper:<pubkey>:alt`). Suspected compromise: do step 4 first (the key can only bias sample timing).

**MINT_POOL_KEY rotation.** 1) `openssl rand -hex 32`. 2) Set it on **grinder and api together**
(`--skip-deploys`), deploy both. New rows carry the new fingerprint; the API only reserves rows it can decrypt.
3) Once no reservation under the old fingerprint is pending (`SELECT count(*) FROM vanity_mints WHERE status =
'reserved' AND key_fp = '<old>'` = 0), `DELETE FROM vanity_mints WHERE status = 'available' AND key_fp = '<old>'`.
The pool regrows from the grinder (watch `/v1/status` vanityPool).

**Webhook re-sync.** The webhook is an accelerator only; the poller + reconcile are complete without it. After a
graduation (new pool) or a Helius outage: update the Helius webhook's account list to
`fumpad, locker` + `SELECT amm_pool FROM coins WHERE amm_pool IS NOT NULL`; check the indexer's `rpc.hints*` stats on
`/health`. Rotating `HELIUS_WEBHOOK_SECRET`: set the new value on Helius and the indexer at the same time (401s in
between are harmless: the poller catches up).

**Re-backfill.** Rebuild one coin from stored events: `npm run migrate -w @fumpad/indexer -- replay <mint>`. Full
rebuild: stop indexer, `UPDATE cursors SET last_signature = NULL, backfill_done = false`, set `BACKFILL_FROM_SLOT`
(program deploy slot), start; ingestion is idempotent by signature (truncate `transactions` first for a clean slate
— it cascades to events and event tables). The vanity pool is not in chain history: never truncate `vanity_mints`.

**RPC outage.** Indexer: polls fail and retry; cursors don't advance past unfetched transactions; `/v1/status` shows
the indexer `degraded`/`down` from its heartbeat. Switch `RPC_URL` (and `WS_URL`) to the backup provider on
indexer/api/keeper and redeploy. Keeper: sends fail → job alerts after 3 failures; claims/samples resume on the next
loop. API: quotes/balances fail (5xx) while list pages keep serving from Postgres; prepare answers 503 after
`LAUNCH_RPC_TIMEOUT_MS`.

## Known gaps
- Vanity pool drain: now needs funded wallets that sign (M-2) and many real IPs; the last `LAUNCH_POOL_RESERVE` mints
  are kept for wallets with FUMPAD history. If the pool is empty the app shows "try again in a minute"; a fallback
  to a random (non-`fmbL`) mint is deliberately not offered.
- `sdk` `FumpadClient.buildProcessQueue` still passes the first 13 entries (the keeper no longer uses it; see H-4).
- Coin metadata JSON upload is still a placeholder in the app (`uri: ipfs://pending`).
- `escrowed` tickets map to the app's `claimed` state (the app types have no escrow state / withdraw action yet).
- Holders are FUMPAD-observed balances (trades + claims), not full SPL holder lists.
- Funding-graph heuristic is first-funder only; no exchange allow-list.
- Social counters (`replies`, `reposts`) and user names are always empty (no source yet).
- Expired tickets are derived by time in the API; on-chain `close_ticket` cranking is not done by the keeper.
