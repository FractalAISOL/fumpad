# FUMPAD off-chain services

TypeScript (Node 22, strict, ESM), npm workspaces. Built against contract **v0.3**
(`contracts/target/idl`, synced into `sdk/src/idl`).

```
services/
  sdk/       @fumpad/sdk      typed client: PDAs, instruction builders, PumpSwap pass-through, math, quotes, events
  indexer/   @fumpad/indexer  chain → Postgres (events, current state, derived game/safety layer)
  api/       @fumpad/api      REST + WebSocket implementing the app's FumpadData contract
  keeper/    @fumpad/keeper   cranks per SPEC §5.4/§7
  scripts/   local validator harness, e2e, IDL/vector/type generators
  test/integration/           indexer↔db↔api (no chain) and the full local e2e
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
 keeper ── reads chain only (gPA + batched account reads), sends cranks
```

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
6–10 v0 + lookup table it manages, coins past half their interval ride along), graduate + post-graduation setup,
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
| `LOG_LEVEL` | all | |

## Run locally

Prereqs: `anchor build` in `contracts/`, Solana CLI (`solana-test-validator`), Postgres (`DATABASE_URL`, or
`docker compose up -d postgres`, or Homebrew `initdb`/`pg_ctl` which the scripts use automatically).

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
```
The validator loads `fumpad` as upgradeable (authority = `.local/upgrade-authority.json`, needed by
`initialize_global`), the locker **immutable**, PumpSwap + pump-fees + GlobalConfig + FeeConfig from
`contracts/tests/fixtures`, and a Pyth SOL/USD account at $150 with a future publish time. Local Global params:
2 s hold, 60 s oracle window, 3 min samples, 2 s spacing (`scripts/local/actors.ts`).

## Railway deployment plan (not deployed)
One Railway project, one Postgres plugin, three services from this monorepo (root directory `services/`):

| service | build | start | env | notes |
|---|---|---|---|---|
| `indexer` | `npm ci && npm run build` | `node indexer/dist/main.js` | `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `HELIUS_API_KEY`, `HELIUS_WEBHOOK_SECRET`, `PORT` | 1 replica (cursors); health `/health`; public URL for the Helius webhook (`/helius`, raw type, accounts = fumpad, locker, + pools: re-sync from `SELECT amm_pool FROM coins`) |
| `api` | same | `node api/dist/main.js` | `DATABASE_URL`, `HELIUS_API_KEY`, `CORS_ORIGINS=https://fumpad.fun`, `PORT` | horizontal OK (cache per instance); health `/health`; custom domain `api.fumpad.fun` |
| `keeper` | same | `node keeper/dist/main.js` | `HELIUS_API_KEY` (or dedicated RPC), `KEEPER_SECRET_KEY` (sealed variable), `TELEGRAM_*`, `PORT` | **exactly 1 replica**; health `/health` with restart policy; fund the keeper and register it via `set_keepers` (multisig) |

Migrations run on indexer start (advisory-locked). No volumes needed (state is Postgres + chain). Run the keeper
first with `DRY_RUN=true` against mainnet to review its plan. Backups: Railway Postgres snapshots; the DB can always be
rebuilt from chain (`BACKFILL_FROM_SLOT` = program deploy slot).

## Known gaps
- **D17** (8% pool, queue capacity 1024, keeper auto-claim) is spec-only on main; no contract interface yet.
  Curve constants come from `Global` so they need no SDK change; `CLAIM_QUEUE_CAPACITY` (256) is a constant in the
  SDK decoders / `buildPostGraduation` and must follow the contract; auto-claim needs the new instruction/account.
- `escrowed` tickets map to the app's `claimed` state (the app types have no escrow state / withdraw action yet).
- Holders are FUMPAD-observed balances (trades + claims), not full SPL holder lists.
- Funding-graph heuristic is first-funder only; no exchange allow-list.
- Social counters (`replies`, `reposts`) and user names are always empty (no source yet).
- Expired tickets are derived by time in the API; on-chain `close_ticket` cranking is not done by the keeper.
