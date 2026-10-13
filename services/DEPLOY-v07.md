# FUMPAD v0.7 — devnet deploy runbook (fresh program, fresh Global, Railway + Vercel)

Program `5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb` (devnet id; keypair `~/fumpad-keys/devnet/fumpad-v07-program-keypair.json`).
Deployer / upgrade authority / admin / guardian (devnet): `~/.config/solana/id.json` = `9HXgtr92…`.
Railway project `fumpad-devnet` (linked in `~/fumpad/services`). Run every command from `~/fumpad/services` after this
branch is merged, unless stated otherwise. Nothing here prints a secret: keys are piped, never echoed.

Tools in this repo:
- `scripts/devnet/bootstrap-v07.ts` — keys, DBC config, `initialize_global`, funding, verification (plan by default,
  `--simulate` = simulateTransaction only, `--yes` = send; idempotent). Rehearsed end to end on a local validator by
  `npm run bootstrap:rehearsal` (real `initialize_global`, simulate → send → verify → second run sends nothing).
- `scripts/devnet/secrets-v07.ts` — `key <name>` (pipe-only), `pubkey <name>`, `db-sql` (board roles file, 600),
  `db-url <attestor-N>` (pipe-only).

Dry-run already done (2026-10-13, throwaway keys): `--step all --simulate` against devnet → `create_config` with the
devnet curve simulates OK on devnet DBC **0.2.2** (35k CU) and the simulated config passes every §5.4 check
`initialize_global` applies; funding simulates OK; `init` can only be simulated once the program is deployed.

## 1. Roles, keys, money

| key (`~/fumpad-keys/devnet/v07/`) | role | on chain | funded (SOL) |
|---|---|---|---|
| deployer `~/.config/solana/id.json` | upgrade authority, **admin**, **guardian** (devnet only: `initialize_global` sets guardian = admin; to split later: `propose_admin(admin, treasury, guardian)` → 48 h → `accept_admin`; `guardian.json` is generated for that. Mainnet: admin + guardian + upgrade authority go to Squads multisigs, `MULTISIG.md`) | — | pays everything below |
| `attestor-1.json` | keeper slot 1 **and the jobs keeper** | `Global.keepers[0]` | 2.00 |
| `attestor-2.json` | keeper slot 2 | `Global.keepers[1]` | 0.25 |
| `attestor-3.json` | keeper slot 3 | `Global.keepers[2]` | 0.25 |
| `launch-signer.json` | API launch co-signer (`LAUNCH_SIGNER_KEY`) | `Params.launch_signer` | 0 (never pays) |
| `treasury.json` | `Global.platform_treasury` | | 0.01 |
| `guardian.json` | spare (see deployer) | | 0 |
| `creator`, `alice`, `bob`, `whale` | test wallets (whale alone can complete a 0.85 SOL curve) | | 0.5 / 0.4 / 0.4 / 1.2 |
| `dbc-config.json` | the FUMPAD DBC config account | `Global.configs[0]` | rent 0.006 |

**Why the jobs keeper = attestor-1.** The contract has exactly 3 keeper slots and threshold 2-of-3. Everything the
jobs keeper does that is keeper-gated — keeper `record_samples` (fallback samples never count for claims), `claim_for`
(auto-claim), pre-graduation `execute_buyback`, and being the fee payer of `attest_*` — checks `Global.keepers`, so
the jobs key must be one of the three. A 4th slot would change the Global layout (not worth it for v1). Consequences:
attestor-1's balance pays both (keep ≥ 1 SOL; `MIN_KEEPER_LAMPORTS` alert), the jobs keeper's daily budget
(`KEEPER_DAILY_BUDGET_SOL`) also sees attestor-1's rent spend, and the two processes use different advisory locks
(jobs `7271002`, attestor per key) so they run side by side. Same layout planned for mainnet (put attestor-1 on the
most reliable infra); a separate jobs key would need a 4th keeper slot.

**Params (`bootstrapParams`)**: defaults except min sell **$5** (500 c), min hold **60 s**, ticket challenge
**3,600 s**, oracle window **600 s** with **28** samples (≥ 600/60, ≤ 600/10), `launch_signer` = launch-signer. All
inside `Params::is_valid` (checked by `paramsProblems` before sending). Cluster tag **1**.

**DBC config**: `fumpadConfigParams("devnet")` — 0.85 SOL threshold, same shape as mainnet (exact-8% leftover curve),
fee_claimer / leftover_receiver = our PDAs `HMuSRiSV…` / `GAMMBr8L…`, migration fee 1% (whole % only on DBC),
scheduler 99% → 1.25% over 8 × 1 slot, migrated pool fee 125 bps OnlyB, first swap min fee, 100% partner LP
permanently locked. Migrates to DAMM v2 via config `A8gMrEPJ…` (exists on devnet).

**Budget** (deployer has ~14.5 SOL): program data rent ≈ **3.81 SOL** (749,800-byte .so; the deploy buffer needs another
≈ 3.81 SOL transiently, refunded), config + Global ≈ 0.012, funding **5.01** → committed ≈ **8.83 SOL** (≤ 10; the
script refuses above `--budget-sol`, default 10, and keeps a 0.2 SOL reserve). Fund AFTER the deploy (peak ≈ 7.6 SOL).

## 2. Chain (order matters)

```sh
cd ~/fumpad/contracts
cp ~/fumpad-keys/devnet/fumpad-v07-program-keypair.json target/deploy/fumpad-keypair.json   # git-ignored
anchor build -p fumpad                                     # 0 warnings; same .so the tests ran on
cd ~/fumpad/services
npx tsx scripts/devnet/bootstrap-v07.ts --step keys        # creates ~/fumpad-keys/devnet/v07 (700, files 600); prints pubkeys
```
Deploy (RPC from the env file, never typed or echoed):
```sh
cd ~/fumpad/contracts
set -a; . ~/fumpad-keys/devnet/rpc.env; set +a
solana program deploy target/deploy/fumpad.so --program-id target/deploy/fumpad-keypair.json \
  --upgrade-authority ~/.config/solana/id.json --keypair ~/.config/solana/id.json --url "$RPC_URL" \
  --with-compute-unit-price 10000
# (a failed deploy leaves a buffer: `solana program show --buffers --url "$RPC_URL"` → `solana program close <buffer>`)
# later upgrades of a bigger .so: `solana program extend 5YMF… <bytes> --url "$RPC_URL"` first
```
Bootstrap:
```sh
cd ~/fumpad/services
npx tsx scripts/devnet/bootstrap-v07.ts --step all --simulate   # config sim + init sim (bundled) + fund sim; verify shows what's missing
npx tsx scripts/devnet/bootstrap-v07.ts --step config --yes     # DBC create_config (skips if it exists and matches)
npx tsx scripts/devnet/bootstrap-v07.ts --step init --yes       # initialize_global (keepers attestor-1/2/3, config, params)
npx tsx scripts/devnet/bootstrap-v07.ts --step fund             # prints the funding plan only
npx tsx scripts/devnet/bootstrap-v07.ts --step fund --yes       # sends it (one tx)
npx tsx scripts/devnet/bootstrap-v07.ts --step verify           # checklist; exit 1 on any ✗
```
`verify` checks: program deployed + upgrade authority + **deployed bytecode == local .so**, DBC/DAMM programs, DAMM
migration config, DBC pool authority flash rent, config §5.4 + devnet numbers, Global (cluster_tag 1, admin =
guardian = deployer, treasury, keepers = attestor-1/2/3 with `keeper_added_at = 0` and all 3 active NOW, configs =
[config], nothing pending, not paused, params field by field incl. `launch_signer`), wallet balances.

## 3. Postgres reset (fresh schema; keep the vanity pool)

The v0.6 tables describe the old program: reset the schema, keep the unused `…fmbL` mints (not in chain history; same
`MINT_POOL_KEY`). Postgres service name below = `Postgres` (check `railway status`; pass `--pg-service` to
`secrets-v07.ts` if different).

```sh
mkdir -p ~/fumpad-keys/devnet/v07/db && chmod 700 ~/fumpad-keys/devnet/v07/db
railway connect Postgres          # psql as the owner; then inside psql:
```
```sql
\copy (SELECT * FROM vanity_mints WHERE status = 'available') TO '~/fumpad-keys/devnet/v07/db/vanity_available.csv' CSV HEADER
SELECT count(*) FROM vanity_mints WHERE status = 'available';             -- remember N
DROP SCHEMA public CASCADE; CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO CURRENT_USER; GRANT USAGE ON SCHEMA public TO PUBLIC;
\q
```
(psql expands `~` in `\copy` only on some versions: use the absolute path `/Users/<you>/fumpad-keys/…` if it complains.)
Then deploy the indexer (§4 step 2: migrations 001–009 run at its start, advisory-locked), and restore the pool:
```sql
-- railway connect Postgres
\copy vanity_mints FROM '/Users/<you>/fumpad-keys/devnet/v07/db/vanity_available.csv' CSV HEADER
SELECT count(*) FROM vanity_mints WHERE status = 'available';             -- = N
```
Then the attestor board roles + RLS (V7-M1; needed for `ATTEST_BOARD_REQUIRE_RLS=1`):
```sh
npx tsx scripts/devnet/secrets-v07.ts db-sql      # writes ~/fumpad-keys/devnet/v07/db/roles.sql (600) + passwords.json (600)
railway connect Postgres                           # then:  \i /Users/<you>/fumpad-keys/devnet/v07/db/roles.sql
```
`roles.sql` (idempotent; tested on a throwaway Postgres: own-row insert OK, squatting a peer's key → RLS error, deleting
a peer's row → `DELETE 0`, reads see all) = the board DDL + `ATTEST_BOARD_RLS` from `keeper/src/attest/board.ts` +
roles `fumpad_attestor_1/2/3` (LOGIN, generated passwords) + grants (`SELECT/INSERT/UPDATE/DELETE` on
`attest_signatures, attest_hints`, `SELECT` on `attest_keeper_roles`) + `attest_keeper_roles` rows mapping each role
to its attestor pubkey. It ends with `relrowsecurity` (both `t`) and the role map. The watcher uses no database.
Alternative to the reset: `railway add --database postgres` (new service) and repoint every `DATABASE_URL` reference;
keeps the old DB for rollback, but then also restore the vanity CSV there.

## 4. Railway services

One image (`services/Dockerfile`, `SERVICE_ENTRY` picks the entry; `keeper/dist/main.js` reads `KEEPER_MODE` =
`jobs` (default) | `attestor` | `watcher`, verified in `keeper/src/main.ts`). The grinder has its own Dockerfile.

| service | new? | `SERVICE_ENTRY` / mode | env (★ = secret, piped) | RPC | public |
|---|---|---|---|---|---|
| `indexer` | existing | `indexer/dist/main.js` | `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `RPC_URL`★, (`WS_URL`★), Meteora indexing is on by default (`METEORA_INDEXER_ENABLED` must not be `false`); **unset** `BACKFILL_FROM_SLOT` (or set it to the deploy slot) and the Helius webhook vars unless you re-point the webhook at `5YMF…` | provider A (Helius, `rpc.env`) | no |
| `api` | existing | `api/dist/main.js` | `DATABASE_URL`, `RPC_URL`★, `CORS_ORIGINS` (unchanged), `API_SSR_SECRET`★ (unchanged, `~/fumpad-keys/api_ssr_secret`), `TRUST_PROXY_HOPS=2`, `MINT_POOL_KEY`★ (unchanged), **`LAUNCH_SIGNER_KEY`★ (new: launch-signer)**, `LAUNCH_REQUIRE_SIGNATURE=true`, `STATUS_KEEPER_URL=http://keeper.railway.internal:<PORT>/health` (optional) | A | yes (`api-production-66441.up.railway.app`) |
| `grinder` | existing | `grinder/Dockerfile` | unchanged (`DATABASE_URL`, `MINT_POOL_KEY`★, `POOL_TARGET`) | — | no |
| `keeper` | existing | `keeper/dist/main.js`, `KEEPER_MODE=jobs` | `DATABASE_URL=${{Postgres.DATABASE_URL}}` (owner: `meta` table + advisory lock), `RPC_URL`★, **`KEEPER_SECRET_KEY`★ = attestor-1** (replaces the v0.6 keeper key), `KEEPER_DAILY_BUDGET_SOL=3` (graduation setup ≈ 0.5 SOL/coin on devnet + attestor-1 rent), `TELEGRAM_BOT_TOKEN`★/`TELEGRAM_CHAT_ID`, `PORT=8082` | A | no |
| `attestor-1` | **new** | `keeper/dist/main.js`, `KEEPER_MODE=attestor` | `KEEPER_SECRET_KEY`★ = attestor-1, `DATABASE_URL`★ = role `fumpad_attestor_1`, `RPC_URL`★, `PYTH_SOURCE=hermes`, `PYTH_API_KEY`★, `ATTEST_BOARD_REQUIRE_RLS=1`, `TELEGRAM_*`, `PORT=8080` | A | no |
| `attestor-2` | **new** | same | attestor-2 key, role `fumpad_attestor_2`, … | **B** (second provider) | no |
| `attestor-3` | **new** | same | attestor-3 key, role `fumpad_attestor_3`, … | **C** (third provider) | no |
| `watcher` | **new** | `keeper/dist/main.js`, `KEEPER_MODE=watcher` | `RPC_URL`★, `PYTH_SOURCE=hermes`, `PYTH_API_KEY`★, `TELEGRAM_*` (guardian's chat), `PORT=8790`; no key, no DB | **D** (ideally 4th) | optional (`/v1/verification` public feed) |

**Program id + cluster (every service except the grinder).** `FUMPAD_PROGRAM_ID` (base58) and `FUMPAD_CLUSTER`
(`mainnet` | `devnet` | `localnet`) select the deployment; both **unset = the devnet deployment** (`5YMF…S9Fb`,
cluster `devnet`), so the devnet services need no new variables. At start, indexer, api, keeper, attestors and watcher
each check the chain behind their `RPC_URL` (`@fumpad/sdk` `requireFumpadDeployment`): the program account exists and
is executable, Global exists under it, and `Global.cluster_tag` = `FUMPAD_CLUSTER` (0 mainnet, 1 devnet, 2 localnet).
Any mismatch → one line `<service>: ✗ refusing to start: …` and exit 1 (Railway shows a crash loop; nothing ran). A
non-default `FUMPAD_PROGRAM_ID` without `FUMPAD_CLUSTER` is refused too. On success the log says
`FUMPAD deployment ok: program … (env|default), cluster … (env|default, cluster_tag n), Global …`.
Mainnet values: LAUNCH-DAY.md §1.13.

RPC per service (attestors must not share a provider, so one bad RPC can't make 2 of 3 sign the same wrong record):
A = Helius (`~/fumpad-keys/devnet/rpc.env`); B, C, D = other providers, e.g. a second Helius account / QuickNode /
Alchemy / Triton devnet endpoints; the public `https://api.devnet.solana.com` works for one attestor or the watcher
with `RPC_MIN_GAP_MS=250` (measured 2026-10-13: 150 ms still draws 429s, 250 ms none; see §8). Every attestor/watcher RPC must serve `getSignaturesForAddress` +
`getTransaction` (v1 txs) for the coins' whole history (the L8 check refuses coins older than the RPC's first block).
Put each extra URL in its own file (`~/fumpad-keys/devnet/rpc-b.env` with `RPC_URL=…`, mode 600). Which file feeds
which keeper, the checks every provider must pass, and today's results: §8.

**Pyth.** Hermes refuses unauthenticated requests since 2026-10. The engine now sends `Authorization: Bearer <key>`
(verified 2026-10-13 with the key in `~/fumpad-keys/devnet/pyth.env` on the historical endpoint: Bearer → 200,
`x-api-key` → 401, none → 401; fixed in `engine/src/pyth.ts`, default was `x-api-key`). Env `PYTH_API_KEY` (alias
`HERMES_API_KEY`); attestors refuse to start in production with `PYTH_SOURCE=hermes` and no key. **All three attestors
and the watcher must use the same price source** (or they disagree and never reach 2-of-3).

### Commands (in this order)

Helpers (paste once per shell; they read files and pipe, nothing is echoed):
```sh
cd ~/fumpad/services
S=scripts/devnet/secrets-v07.ts
envval() { sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$2=//p" "$1" | head -1 | sed 's/^["'\'']//; s/["'\'']$//' | tr -d '\n'; }
setsecret() { railway variables --service "$1" --skip-deploys --set-from-stdin "$2"; }   # stdin → variable
```
1. The running v0.6 services keep serving the old program until each is redeployed below (devnet: a short mixed
   period is harmless). Have §2 done (program deployed, Global initialized, wallets funded) first.
   **Except the indexer: stop it before the DB reset** (`railway down --service indexer`, or scale it to 0). A v0.6
   indexer that is still running when the schema is dropped crashes, Railway restarts it, and it re-runs its own
   migrations on the empty schema and backfills the OLD program from scratch. That is how the v0.6 coin
   `SM5k4…fmbL` came back after the first v0.7 reset (its rows carry v0.6 data: `pool_seeded` 80M, trades from
   `ASVE6…` transactions, `dbc_pool` NULL). Since then the v0.7 indexer binds the database to its program id
   (meta `fumpad_program_id`; another program's DB is refused at start), deletes cursors of other program
   versions instead of polling them, and logs an error listing coins it never registered. Leftovers:
   `scripts/ops/purge-coin.ts <mint>` (dry run first; `--yes` applies; one mint per run).
2. **DB reset** (§3), then **indexer**:
   ```sh
   railway variables --service indexer --skip-deploys --set "SERVICE_ENTRY=indexer/dist/main.js"
   railway up --service indexer --detach        # runs migrations 001–009; then restore the vanity CSV (§3)
   ```
3. **api** (+ launch co-signer):
   ```sh
   npx tsx $S key launch-signer | setsecret api LAUNCH_SIGNER_KEY
   railway variables --service api --skip-deploys --set "LAUNCH_REQUIRE_SIGNATURE=true" --set "TRUST_PROXY_HOPS=2"
   railway up --service api --detach
   railway up grinder --path-as-root --service grinder --detach      # unchanged; only if it was stopped
   ```
4. **keeper (jobs) = attestor-1's key**:
   ```sh
   npx tsx $S key attestor-1 | setsecret keeper KEEPER_SECRET_KEY
   railway variables --service keeper --skip-deploys --set "KEEPER_MODE=jobs" --set "KEEPER_DAILY_BUDGET_SOL=3" --set "SERVICE_ENTRY=keeper/dist/main.js"
   railway up --service keeper --detach          # optional first: --set "DRY_RUN=true" to review its plan, then unset
   ```
5. **Board roles** (§3 `db-sql` + `\i roles.sql`) — before the attestors start with `ATTEST_BOARD_REQUIRE_RLS=1`.
6. **attestor-1/2/3** (create, configure, deploy; RPC file per attestor):
   ```sh
   for i in 1 2 3; do
     railway add --service attestor-$i
     railway variables --service attestor-$i --skip-deploys \
       --set "SERVICE_ENTRY=keeper/dist/main.js" --set "KEEPER_MODE=attestor" --set "PYTH_SOURCE=hermes" \
       --set "ATTEST_BOARD_REQUIRE_RLS=1" --set "PORT=8080" --set "LOG_LEVEL=info"
     npx tsx $S key attestor-$i | setsecret attestor-$i KEEPER_SECRET_KEY
     npx tsx $S db-url attestor-$i | setsecret attestor-$i DATABASE_URL
     envval ~/fumpad-keys/devnet/pyth.env PYTH_API_KEY | setsecret attestor-$i PYTH_API_KEY
   done
   envval ~/fumpad-keys/devnet/rpc.env   RPC_URL | setsecret attestor-1 RPC_URL
   envval ~/fumpad-keys/devnet/rpc-b.env RPC_URL | setsecret attestor-2 RPC_URL
   envval ~/fumpad-keys/devnet/rpc-c.env RPC_URL | setsecret attestor-3 RPC_URL
   # Telegram (same bot/chat as the keeper): envval <file> TELEGRAM_BOT_TOKEN | setsecret attestor-$i TELEGRAM_BOT_TOKEN
   for i in 1 2 3; do railway up --service attestor-$i --detach; done
   ```
   `db-url` yields `postgresql://fumpad_attestor_N:<pw>@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}`
   (Railway resolves the references). Logs must show no "attest board has no row-level security".
7. **watcher**:
   ```sh
   railway add --service watcher
   railway variables --service watcher --skip-deploys --set "SERVICE_ENTRY=keeper/dist/main.js" --set "KEEPER_MODE=watcher" --set "PYTH_SOURCE=hermes" --set "PORT=8790"
   envval ~/fumpad-keys/devnet/pyth.env PYTH_API_KEY | setsecret watcher PYTH_API_KEY
   envval ~/fumpad-keys/devnet/rpc-d.env RPC_URL     | setsecret watcher RPC_URL
   railway up --service watcher --detach
   railway domain --service watcher               # optional: public /v1/verification
   ```
8. Check: `GET https://api-production-66441.up.railway.app/v1/status` (indexer up, vanity pool = N), keeper/attestor
   logs (attestors list 3 active keepers, board RLS on), `bootstrap-v07.ts --step verify` still green.

Old v0.6 leftovers: the old keeper key `~/fumpad-keys/devnet/keeper.json` (`25Yh2T71…`) is no longer a keeper of
anything: drain it to the deployer when convenient. The old program `ASVE6Nk8…` and locker stay deployed (can be
closed with `solana program close` to recover their rent ≈ 4–5 SOL — irreversible, ask first).

## 5. App (Vercel, project `fumpad`)

No Vercel env var has to change for v0.7 devnet:
- The program id is build-time config: `NEXT_PUBLIC_FUMPAD_PROGRAM_ID` + `NEXT_PUBLIC_FUMPAD_CLUSTER`, both **unset
  on devnet** (default `5YMF…S9Fb`; cluster inferred from `NEXT_PUBLIC_SOLANA_RPC`). `app/next.config.ts` inlines the
  same two values into the vendored SDK (as `FUMPAD_PROGRAM_ID` / `FUMPAD_CLUSTER`), and the silent-signing allow-list
  (`app/src/chain/allowlist.ts`) refuses to load if the SDK's id differs from the app's, and signs for that one id
  only. A set program id without `NEXT_PUBLIC_FUMPAD_CLUSTER`, or `mainnet` with a devnet/testnet RPC URL, fails the
  build. `NEXT_PUBLIC_*` are inlined at build time: changing them needs a redeploy (a rebuild), not just a restart.
- `NEXT_PUBLIC_FUMPAD_API` unchanged (same Railway API URL). `API_SSR_SECRET` unchanged.
- `NEXT_PUBLIC_SOLANA_RPC` unchanged as long as it is the domain-restricted **devnet** frontend key (the app infers
  the cluster from the URL: it must contain `devnet`).
- The DBC config and `launch_signer` are read from the chain's Global (no env).
- `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_X_URL`, `NEXT_PUBLIC_PRELAUNCH` / `PRELAUNCH_HOSTS`
  unchanged.
Action: redeploy the v0.7 app from main (`cd ~/fumpad/app && vercel deploy --prod`), after the API is on v0.7.

## 6. Smoke test (devnet)
1. App: launch with `creator` (signed prepare → `…fmbL` mint → `CoinRegistered`), buy with alice/bob, wait ≥ 60 s,
   sell ≥ $5 → ticket "verifying" → attested by 2 of 3 attestors (`TicketAttested`) → claimable after 1 h.
2. `whale` completes the curve (router buy with PartialFill) → keeper `migrate_pool` + `graduate` + observations +
   claim queue (attestor-1 pays ≈ 0.5 SOL) → samples → claims.
3. Watcher `/v1/verification` shows no mismatch.

## 7. Waitlist in its own database (`waitlist-db`)

Why: the waiting-room sign-ups lived in the backend's Postgres and the §3 schema reset wiped them. The API now
keeps them in a separate database (`api/src/waitlist.ts`): `WAITLIST_DATABASE_URL` → its own pool, its own
idempotent migration (only the `waitlist` table, advisory-locked) run in the background at API start.
- **Production** (`NODE_ENV=production`, the Docker image): without `WAITLIST_DATABASE_URL`, or with it equal to
  `DATABASE_URL`, or without `WAITLIST_IP_SALT`, `POST /v1/waitlist` answers **503** ("The waitlist is unavailable
  right now…", shown as-is by the waiting room) and the API logs `!!! WAITLIST DISABLED: … !!!` at start and every
  hour. Every other route keeps working. A waitlist DB that is down → 503 on sign-up only.
- **Outside production** it falls back to `DATABASE_URL` (and a fixed dev salt).
- `ip_hash` = HMAC(ip) under `WAITLIST_IP_SALT` only (no longer derived from any database URL).
- `GET /health` with the SSR header shows `"waitlist": "own-db" | "backend-db (dev)" | "disabled"`.
- Backups: `scripts/ops/waitlist-export.ts` (CSV `id,email,x_handle,created_at` [+ `ip_hash` with
  `--include-ip-hash`], dir 700 / file 600, never overwrites; prints only the count and the path).
- Tested: `api/test/waitlist.test.ts` (config modes) and `test/integration/waitlist.test.ts` (real Postgres: dev
  fallback; own DB gets only the `waitlist` table, sign-ups land there and not in the backend DB, concurrent
  migrations, survives a backend `DROP SCHEMA public CASCADE`, export mode/escaping/no-overwrite, production without
  the URL → 503 + loud log + `/health` 200, unreachable DB → 503).

**This database must never be reset with the devnet backend** (§3 resets touch only the `Postgres` service), and the
**mainnet API should later use the same `waitlist-db`** (same `WAITLIST_DATABASE_URL` and the same
`WAITLIST_IP_SALT`), so the list survives the devnet → mainnet move. The backend's old `waitlist` table (indexer
migration 007) stays but is no longer written.

**Order matters**: set the variables (steps 1–3) **before** the API is redeployed with this code, otherwise the
waitlist is off (503) until they are set.

Steps (from `~/fumpad/services`, helpers `envval` / `setsecret` from §4):
```sh
# 1. new Postgres service, then rename it
railway add --database postgres
#    Railway dashboard → project fumpad-devnet → the new "Postgres-…" service → Settings → Service Name: waitlist-db
railway service list                          # shows waitlist-db
#    (optional, Pro plan) waitlist-db → Settings → Backups: enable volume backups

# 2. point the API at it (literal ${{…}}: single quotes; Railway resolves the reference)
railway variables --service api --skip-deploys --set 'WAITLIST_DATABASE_URL=${{waitlist-db.DATABASE_URL}}'

# 3. the salt (LAUNCH.md says it is already set on the api). Keep a private copy for the future mainnet API:
mkdir -p ~/fumpad-keys/waitlist && chmod 700 ~/fumpad-keys/waitlist
railway variables --service api --kv | sed -n 's/^WAITLIST_IP_SALT=//p' > ~/fumpad-keys/waitlist/ip_salt; chmod 600 ~/fumpad-keys/waitlist/ip_salt
test -s ~/fumpad-keys/waitlist/ip_salt && echo "salt present" || {   # only if it was NOT set: generate one
  (umask 077; openssl rand -hex 32 | tr -d '\n' > ~/fumpad-keys/waitlist/ip_salt)
  setsecret api WAITLIST_IP_SALT < ~/fumpad-keys/waitlist/ip_salt; }

# 4. deploy the API (this branch merged)
railway up --service api --detach
railway logs --service api | grep -i waitlist  # expect "waitlist schema ready", and NO "WAITLIST DISABLED"
printf 'x-fumpad-ssr: %s\n' "$(cat ~/fumpad-keys/api_ssr_secret)" | curl -s -H @- https://api-production-66441.up.railway.app/health | grep -o '"waitlist":"[^"]*"'   # "own-db"

# 5. verify: a test sign-up, then an export
curl -s -X POST https://api-production-66441.up.railway.app/v1/waitlist -H 'content-type: application/json' \
  -d '{"contact":"ops-test+waitlistdb@fumpad.app"}'                       # {"ok":true}
railway variables --service waitlist-db --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p' \
  | npx tsx scripts/ops/waitlist-export.ts --url-stdin                    # "exported N sign-up(s) → ~/fumpad-keys/waitlist/waitlist-<ts>.csv (mode 600)"
grep -c 'ops-test+waitlistdb@fumpad.app' ~/fumpad-keys/waitlist/waitlist-*.csv   # 1
railway connect waitlist-db                   # then: DELETE FROM waitlist WHERE email = 'ops-test+waitlistdb@fumpad.app';
```
If anyone signed up between the reset and step 4 (rows in the backend DB), copy them over once:
```sh
railway variables --service Postgres --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p' \
  | npx tsx scripts/ops/waitlist-export.ts --url-stdin --include-ip-hash --out ~/fumpad-keys/waitlist/from-backend.csv
railway connect waitlist-db                   # then, in psql:
#   CREATE TEMP TABLE t (id bigint, email text, x_handle text, created_at timestamptz, ip_hash text);
#   \copy t FROM '/Users/<you>/fumpad-keys/waitlist/from-backend.csv' CSV HEADER
#   INSERT INTO waitlist (email, x_handle, created_at, ip_hash) SELECT email, x_handle, created_at, ip_hash FROM t ON CONFLICT DO NOTHING;
```
Routine backup: the step-5 export command (e.g. weekly); the files stay in `~/fumpad-keys/waitlist` (700/600).

## 8. One RPC provider per keeper

Attestors must not share a provider (one bad RPC must not make 2 of 3 sign the same wrong record); the watcher
should be on a fourth. Env file → service (devnet; mainnet = the same names under `~/fumpad-keys/mainnet/`):

| env file | provider | feeds | Railway vars |
|---|---|---|---|
| `rpc.env` | **A** | `attestor-1`, `keeper` (jobs = attestor-1's key), `indexer`, `api` | `RPC_URL` (+ `RPC_MIN_GAP_MS` if the file has one) |
| `rpc-b.env` | **B** | `attestor-2` | same |
| `rpc-c.env` | **C** | `attestor-3` | same |
| `rpc-d.env` | **D** | `watcher` | same |

Each file: `RPC_URL=…` and, when the provider rate-limits, `RPC_MIN_GAP_MS=…` (mode 600). Push both:
```sh
for pair in attestor-1:rpc attestor-2:rpc-b attestor-3:rpc-c watcher:rpc-d; do
  svc=${pair%%:*}; f=~/fumpad-keys/devnet/${pair#*:}.env
  envval "$f" RPC_URL | setsecret "$svc" RPC_URL
  gap=$(envval "$f" RPC_MIN_GAP_MS); [ -n "$gap" ] && railway variables --service "$svc" --skip-deploys --set "RPC_MIN_GAP_MS=$gap"
  railway redeploy --service "$svc" --yes
done
```
**Check every provider before use** (read-only; prints only redacted hosts):
```sh
npm run rpc-check -- --env ~/fumpad-keys/devnet/rpc.env --env ~/fumpad-keys/devnet/rpc-b.env \
  --env ~/fumpad-keys/devnet/rpc-c.env --env ~/fumpad-keys/devnet/rpc-d.env
npm run rpc-check -- --env ~/fumpad-keys/mainnet/rpc.env --env … --l8-slot <oldest live coin launch slot>   # mainnet
```
It checks: cluster; `getSignaturesForAddress` pagination on the DBC program (5 × 1000, contiguous, no duplicates)
and to the very first signature of the FUMPAD program; `getTransaction` (`maxSupportedTransactionVersion: 1`) for
the oldest, a recent and a **version-1** tx; the history floor (`getFirstAvailableBlock`, `minimumLedgerSlot`) vs
the L8 slot; `RPC_MIN_GAP_MS` under a ≥ 12 s sustained load (and the smallest spacing without 429 if it fails);
same-endpoint duplicates; and across providers byte-identical `parseMeteoraTrades` records for 20 finalized
signatures plus identical `getBlock` signature order.

**Results 2026-10-13** (to fix before mainnet):
- devnet `rpc.env` (Helius): everything PASS (archive from slot 0, v1 tx OK, no 429 at 30 concurrent).
- **`rpc-c.env` is the same endpoint (same Helius key) as `rpc.env`**: attestor-1 and attestor-3 would share a
  provider. Replace with a different provider/account.
- `rpc-b.env` and `rpc-d.env` are both the public `api.devnet.solana.com` (attestor-2 and the watcher share it) and
  have **no `RPC_MIN_GAP_MS`**: 429s. Measured: 150 ms → 51 of 80 requests 429; **250 ms → 0**. Add
  `RPC_MIN_GAP_MS=250` to those files (devnet only: the public endpoint is fine for one devnet keeper, not two).
- Cross-provider: Helius ↔ public devnet 20/20 byte-identical trade records, identical block order.
- mainnet, read-only: the current Helius key on `mainnet.helius-rpc.com` serves everything (archive from slot 0,
  pagination, old v0 + recent v1 txs) **but rate-limits even at 1 request/s** (429s at 1000 ms spacing): not
  usable for a mainnet keeper as is; mainnet needs paid plans. Public mainnet: same records (20/20, 1050-tx block
  order identical) but `minimumLedgerSlot` ≈ 6 h back and heavy rate limits: never for a keeper.

Recommended mainnet set (all must pass `rpc-check` with the real `--l8-slot`): A = Helius (paid, archive),
B = Triton One, C = QuickNode or Alchemy (archive add-on where needed), D = a fourth (e.g. a second Helius account on
another plan, or Chainstack). Different companies for A/B/C, not just different keys.

## 9. Rotating the Telegram bot token and the Pyth key

Files: `~/fumpad-keys/<cluster>/telegram.env` (`TELEGRAM_BOT_TOKEN=…`) and `~/fumpad-keys/<cluster>/pyth.env`
(`PYTH_API_KEY=…`), mode 600. Never `echo`/`cat` them; edit with an editor, push with `envval | setsecret`.

**Telegram** (keeper, attestor-1/2/3, watcher). `/revoke` kills the old token at once, so do it in one go:
1. Telegram → @BotFather → `/revoke` → pick the bot → copy the new token.
2. `(umask 077; ${EDITOR:-nano} ~/fumpad-keys/devnet/telegram.env)` → replace the `TELEGRAM_BOT_TOKEN=` value.
3. Check it without printing it:
   `curl -s -K <(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$(envval ~/fumpad-keys/devnet/telegram.env TELEGRAM_BOT_TOKEN)") | grep -o '"ok":true'`
   (verified 2026-10-13 with the current token: `"ok":true`)
4. Push + redeploy:
   ```sh
   for s in keeper attestor-1 attestor-2 attestor-3 watcher; do
     envval ~/fumpad-keys/devnet/telegram.env TELEGRAM_BOT_TOKEN | setsecret "$s" TELEGRAM_BOT_TOKEN
     railway redeploy --service "$s" --yes
   done
   ```
5. Logs: no `telegram alert failed`; the next alert arrives. (`TELEGRAM_CHAT_ID` doesn't change.)

**Pyth / Hermes** (attestor-1/2/3 and the watcher; all four must use the same source). No downtime: new key first,
old key revoked last.
1. Issue a new API key where the current one was issued (Pyth/Hermes dashboard).
2. `(umask 077; ${EDITOR:-nano} ~/fumpad-keys/devnet/pyth.env)` → replace `PYTH_API_KEY=`.
3. Check (the historical endpoint the attestors use; `200` = key accepted, `401` = not):
   ```sh
   t=$(( $(date +%s) - 60 ))
   curl -s -o /dev/null -w '%{http_code}\n' -K <(printf 'header = "Authorization: Bearer %s"\nurl = "https://hermes.pyth.network/v2/updates/price/%s?ids%%5B%%5D=ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d&parsed=true"\n' "$(envval ~/fumpad-keys/devnet/pyth.env PYTH_API_KEY)" "$t")
   ```
   (verified 2026-10-13 with the current key: `200`)
4. Push + redeploy:
   ```sh
   for s in attestor-1 attestor-2 attestor-3 watcher; do
     envval ~/fumpad-keys/devnet/pyth.env PYTH_API_KEY | setsecret "$s" PYTH_API_KEY
     railway redeploy --service "$s" --yes
   done
   ```
5. Logs show prices again (no Hermes 401), then revoke the old key in the dashboard.

Mainnet: same commands with `~/fumpad-keys/mainnet/…` and the mainnet Railway project linked. `curl -K <(…)` keeps the
secret out of the process list and the terminal.
