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
| deployer `~/.config/solana/id.json` | upgrade authority, **admin**, **guardian** (devnet only: `initialize_global` sets guardian = admin; to split later: `propose_admin(admin, treasury, guardian)` → 48 h → `accept_admin`; `guardian.json` is generated for that) | — | pays everything below |
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

RPC per service (attestors must not share a provider, so one bad RPC can't make 2 of 3 sign the same wrong record):
A = Helius (`~/fumpad-keys/devnet/rpc.env`); B, C, D = other providers, e.g. a second Helius account / QuickNode /
Alchemy / Triton devnet endpoints; the public `https://api.devnet.solana.com` works for one attestor or the watcher
with `RPC_MIN_GAP_MS=150` (rate limits). Every attestor/watcher RPC must serve `getSignaturesForAddress` +
`getTransaction` (v1 txs) for the coins' whole history (the L8 check refuses coins older than the RPC's first block).
Put each extra URL in its own file (`~/fumpad-keys/devnet/rpc-b.env` with `RPC_URL=…`, mode 600).

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
- The program id is **not configurable**: `5YMF…S9Fb` is compiled into `app/src/chain/cluster.ts`
  (`FUMPAD_PROGRAM_ADDRESS`) and the vendored SDK (`app/vendor/fumpad-sdk-0.7.0.tgz`, repacked on this branch).
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
