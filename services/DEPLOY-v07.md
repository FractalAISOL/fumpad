# FUMPAD v0.7 — devnet deploy runbook (fresh program, fresh Global, Railway + Vercel)

Program `5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb` (devnet id; keypair `~/fumpad-keys/devnet/fumpad-v07-program-keypair.json`).
Deployer / upgrade authority / admin / guardian (devnet): `~/.config/solana/id.json` = `9HXgtr92…`.
Railway project `fumpad-devnet` (linked in `~/fumpad/services`). Run every command from `~/fumpad/services` after this
branch is merged, unless stated otherwise. Nothing here prints a secret: keys are piped, never echoed.

Tools in this repo:
- `scripts/devnet/bootstrap-v07.ts` — keys, DBC config, `initialize_global`, operators, funding, verification (plan by default,
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
| deployer `~/.config/solana/id.json` | upgrade authority, **admin**, **guardian** (devnet only: `initialize_global` sets guardian = admin; to split later: `propose_admin(admin, treasury, guardian)` → 6 h → `accept_admin`; `guardian.json` is generated for that. Mainnet: admin + guardian + upgrade authority go to Squads multisigs, `MULTISIG.md`) | — | pays everything below |
| `operator.json` | **the jobs keeper** (samples, `claim_for`, pre-grad buybacks, cranks; pays graduation setup) | `Global.operators[0]` | 2.00 |
| `attestor-1.json` | attestor 1 (attestations only) | `Global.keepers[0]` | 0.25 |
| `attestor-2.json` | attestor 2 | `Global.keepers[1]` | 0.25 |
| `attestor-3.json` | attestor 3 | `Global.keepers[2]` | 0.25 |
| `launch-signer.json` | API launch co-signer (`LAUNCH_SIGNER_KEY`) | `Params.launch_signer` | 0 (never pays) |
| `treasury.json` | `Global.platform_treasury` | | 0.01 |
| `guardian.json` | spare (see deployer) | | 0 |
| `creator`, `alice`, `bob`, `whale` | test wallets (whale alone can complete a 0.85 SOL curve) | | 0.5 / 0.4 / 0.4 / 1.2 |
| `dbc-config.json` | the FUMPAD DBC config account | `Global.configs[0]` | rent 0.006 |

**Jobs key ≠ attestor keys (2026-10-13 d).** The jobs keeper runs with its own key, `Global.operators[0]`
(`operator.json`): keeper samples, `claim_for` and pre-graduation buybacks check `Global.operators`; the three
`Global.keepers` are attestors ONLY (they sign + submit `attest_sell` / `attest_rebuy`). The program refuses a key in
both sets (`KeeperOperatorOverlap`), the jobs keeper refuses to start with a key that isn't (only) an operator, and an
attestor refuses to start with an operator key (`keeper/src/role.ts`). So one compromised box holds either the jobs
key or ONE attestation key, never both. (Before this change the jobs keeper reused attestor-1's key; a devnet Global
from then is migrated in place — §10.)

**Recommended topology (devnet now, mainnet required — THREAT-MODEL G6).** 2-of-3 only means something if no single
account, provider or person can reach two attestation keys:
| unit | Railway project / account | owner | RPC provider | services |
|---|---|---|---|---|
| core | `fumpad-devnet` (your account) | you | A | indexer, api, grinder, keeper (jobs, `operator` key), Postgres (board + data) |
| attestor-1 | `fumpad-attestor-1` (**separate project**; separate account if possible) | you | B | attestor-1 |
| attestor-2 | `fumpad-attestor-2`, **another Railway account** | ideally a second person | C | attestor-2 |
| attestor-3 | `fumpad-attestor-3`, **another account, ideally another cloud** (Fly / Render / a VPS) | ideally a third person | D | attestor-3 |
| watcher | anywhere except an attestor's project | guardian side | E (≠ every attestor's) | watcher → guardian Telegram chat |
Rules: each attestor key exists only in its own project's variables (and the offline backup); no project member can
read another attestor's variables; the jobs `operator` key never lives in an attestor project. Attestors in other
projects reach the shared signature board over the board Postgres's TCP proxy with their own role + RLS + TLS:
`secrets-v07.ts db-url attestor-N --public <proxy-host:port>` (an attestor's DB role can only write its own signature
rows, V7-M1; the board is signatures + hints only, every attestor re-verifies from its own RPC). The watcher uses a
5th provider so a provider shared with an attestor can't hide the attestation it serves wrongly. Until the second /
third people exist, at minimum: 3 separate Railway projects, 3 different RPC companies, attestor-3 on a different cloud.

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
npx tsx scripts/devnet/bootstrap-v07.ts --step init --yes       # initialize_global (keepers attestor-1/2/3, operators [operator], config, params)
npx tsx scripts/devnet/bootstrap-v07.ts --step operators --yes  # existing pre-operators Global only: migrate_global + set_operators (§10)
npx tsx scripts/devnet/bootstrap-v07.ts --step fund             # prints the funding plan only
npx tsx scripts/devnet/bootstrap-v07.ts --step fund --yes       # sends it (one tx)
npx tsx scripts/devnet/bootstrap-v07.ts --step verify           # checklist; exit 1 on any ✗
```
`verify` checks: program deployed + upgrade authority + **deployed bytecode == local .so**, DBC/DAMM programs, DAMM
migration config, DBC pool authority flash rent, config §5.4 + devnet numbers, Global (cluster_tag 1, admin =
guardian = deployer, treasury, keepers = attestor-1/2/3 with `keeper_added_at = 0` and all 3 active NOW, operators =
[operator] disjoint from the keepers, configs =
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
| `indexer` | existing | `indexer/dist/main.js` | `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `RPC_URL`★, (`WS_URL`★), Meteora indexing is on by default (`METEORA_INDEXER_ENABLED` must not be `false`); **unset** `BACKFILL_FROM_SLOT` (or set it to the deploy slot) and the Helius webhook vars unless you re-point the webhook at `5YMF…`; `PINATA_GATEWAY` (optional, same value as the api: coin metadata JSON is fetched through it first) | provider A (Helius, `rpc.env`) | no |
| `api` | existing | `api/dist/main.js` | `DATABASE_URL`, `RPC_URL`★, `CORS_ORIGINS` (unchanged), `API_SSR_SECRET`★ (unchanged, `~/fumpad-keys/api_ssr_secret`), `TRUST_PROXY_HOPS=2`, `MINT_POOL_KEY`★ (unchanged), **`LAUNCH_SIGNER_KEY`★ (new: launch-signer)**, `LAUNCH_REQUIRE_SIGNATURE=true`, `LAUNCH_FIRST_COIN=false` (true only to launch the first coin, §11 / LAUNCH-DAY §5), `LAUNCHES_OPEN` (unset = open on devnet; **mainnet defaults to closed**: set `false` until the public opening, then `true`, LAUNCH-DAY §1/§5), `STATUS_KEEPER_URL=http://keeper.railway.internal:<PORT>/health` (optional), **`PINATA_JWT`★ (new: coin metadata to IPFS, `POST /v1/launch/metadata`; required with `FUMPAD_CLUSTER=mainnet`, else uploads answer 503 and the app can't launch; devnet without it = placeholder uri `ipfs://pending`)**, `PINATA_GATEWAY` (optional, dedicated gateway domain `<name>.mypinata.cloud`: our image proxy tries it before `IPFS_GATEWAY`) | A | yes (`api-production-66441.up.railway.app`) |
| `grinder` | existing | `grinder/Dockerfile` | unchanged (`DATABASE_URL`, `MINT_POOL_KEY`★, `POOL_TARGET`) | — | no |
| `keeper` | existing | `keeper/dist/main.js`, `KEEPER_MODE=jobs` | `DATABASE_URL=${{Postgres.DATABASE_URL}}` (owner: `meta` table + advisory lock), `RPC_URL`★, **`KEEPER_SECRET_KEY`★ = operator** (never an attestor key: it refuses to start), `KEEPER_DAILY_BUDGET_SOL=3` (graduation setup ≈ 0.5 SOL/coin on devnet), `TELEGRAM_BOT_TOKEN`★/`TELEGRAM_CHAT_ID`, `PORT=8082` | A | no |
| `attestor-1` | **new**, own project (§1 topology) | `keeper/dist/main.js`, `KEEPER_MODE=attestor` | `KEEPER_SECRET_KEY`★ = attestor-1, `DATABASE_URL`★ = role `fumpad_attestor_1` (`db-url … --public` from another project), `RPC_URL`★, `PYTH_SOURCE=onchain`, `PYTH_RPC_URL`★ (provider B's **mainnet** endpoint), `ATTEST_BOARD_REQUIRE_RLS=1`, `TELEGRAM_*`, `PORT=8080` | **B** | no |
| `attestor-2` | **new**, own project + account | same | attestor-2 key, role `fumpad_attestor_2`, … | **C** | no |
| `attestor-3` | **new**, own project + account (+ cloud) | same | attestor-3 key, role `fumpad_attestor_3`, … | **D** | no |
| `watcher` | **new** | `keeper/dist/main.js`, `KEEPER_MODE=watcher` | `RPC_URL`★, `PYTH_SOURCE=onchain`, `PYTH_RPC_URL`★ (provider E's mainnet endpoint), `TELEGRAM_*` (guardian's chat), `PORT=8790`; no key, no DB | **E** (5th, ≠ every attestor's) | optional (`/v1/verification` public feed) |

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

**Pyth (SOL/USD for the $50 minimum) — `PYTH_SOURCE=onchain`, free.** Hermes needs a paid plan since 2026-10
($500/mo Starter), so the default source (with `NODE_ENV=production`) is chain-native (`engine/src/pyth-onchain.ts`):
the prices WRITTEN to Pyth's sponsored SOL/USD push account `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`
(= PDA of the push oracle `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT`, shard 0; owner = receiver
`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`), i.e. the receiver's `post_update` CPIs in successful finalized txs.
For a sell at block time T: among writes landing in [T − 90 s, T + 30 s], the greatest `publish_time` ≤ T, null if
older than `max_pyth_delta_secs` (60). A sell is priced once T + 30 s is ≥ 20 s behind the RPC's finalized head
(~65 s after the sell; until then the coin is retried next tick, never "no price").
- **Always mainnet.** The devnet copy of the account updates only every ~5 min (measured 2026-10-13), too stale for
  60 s, so **devnet keepers read the mainnet feed**: `PYTH_RPC_URL` = the same provider's *mainnet* endpoint (Helius:
  the devnet URL with host `devnet` → `mainnet`, same key; others: add `PYTH_RPC_URL=<mainnet url>` to that keeper's
  `rpc-*.env`). The source checks the genesis hash at start and refuses a non-mainnet RPC. On mainnet `PYTH_RPC_URL`
  can stay unset (defaults to `RPC_URL`). Public `https://api.mainnet-beta.solana.com` works for one keeper with
  `PYTH_RPC_MIN_GAP_MS=1100` (its `getTransaction` limit is 10 per 10 s).
- **Determinism**: verified 2026-10-13 on 120 sample times: Helius mainnet and the public RPC gave identical prices
  and identical write sets; every on-chain write equals Hermes' update for the same publish_time (24/24). Fixture
  + replay: `engine/test/pyth-onchain.test.ts`.
- **Cadence risk**: the feed is written every ~53 s (heartbeat), so a price is typically 0–55 s old; in 24 h measured
  there was one 17-min pusher gap (1.1% of the day) during which sells get no ticket (stale > 60 s), where Hermes
  would still have had a price.
- **Switching** (devnet ran Hermes): switch all four (attestor-1/2/3 + watcher) together. Tickets attested earlier
  with Hermes prices can show as watcher mismatches (different `pyth_publish_time` / `usd_cents`) while their
  challenge window is open; that's expected, don't void them for that.
- `PYTH_SOURCE=hermes` stays available (paid key: `PYTH_API_KEY`, sent as `Authorization: Bearer`; production refuses
  to start without it; rotation §9). **All three attestors and the watcher must use the same price source** (or they
  disagree and never reach 2-of-3).

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
4. **keeper (jobs) = the operator key** (never an attestor's):
   ```sh
   npx tsx $S key operator | setsecret keeper KEEPER_SECRET_KEY
   railway variables --service keeper --skip-deploys --set "KEEPER_MODE=jobs" --set "KEEPER_DAILY_BUDGET_SOL=3" --set "SERVICE_ENTRY=keeper/dist/main.js"
   railway up --service keeper --detach          # optional first: --set "DRY_RUN=true" to review its plan, then unset
   ```
5. **Board roles** (§3 `db-sql` + `\i roles.sql`) — before the attestors start with `ATTEST_BOARD_REQUIRE_RLS=1`.
6. **attestor-1/2/3** (create, configure, deploy; RPC file per attestor). Shown in the core project for brevity;
   for the §1 topology run each block with that attestor's own project linked (`railway link`), and set its
   `DATABASE_URL` with `npx tsx $S db-url attestor-N --public <board-proxy-host:port> | setsecret attestor-N DATABASE_URL`:
   ```sh
   for i in 1 2 3; do
     railway add --service attestor-$i
     railway variables --service attestor-$i --skip-deploys \
       --set "SERVICE_ENTRY=keeper/dist/main.js" --set "KEEPER_MODE=attestor" --set "PYTH_SOURCE=onchain" \
       --set "ATTEST_BOARD_REQUIRE_RLS=1" --set "PORT=8080" --set "LOG_LEVEL=info"
     npx tsx $S key attestor-$i | setsecret attestor-$i KEEPER_SECRET_KEY
     npx tsx $S db-url attestor-$i | setsecret attestor-$i DATABASE_URL
   done
   envval ~/fumpad-keys/devnet/rpc.env   RPC_URL | setsecret attestor-1 RPC_URL
   envval ~/fumpad-keys/devnet/rpc-b.env RPC_URL | setsecret attestor-2 RPC_URL
   envval ~/fumpad-keys/devnet/rpc-c.env RPC_URL | setsecret attestor-3 RPC_URL
   # SOL/USD is read on MAINNET (devnet's feed is ~5 min stale): Helius = same key, host devnet → mainnet;
   # other providers: put PYTH_RPC_URL=<their mainnet url> in that rpc-*.env and pipe it the same way
   envval ~/fumpad-keys/devnet/rpc.env   RPC_URL | sed 's#//devnet\.#//mainnet.#' | setsecret attestor-1 PYTH_RPC_URL
   envval ~/fumpad-keys/devnet/rpc-b.env PYTH_RPC_URL | setsecret attestor-2 PYTH_RPC_URL
   envval ~/fumpad-keys/devnet/rpc-c.env PYTH_RPC_URL | setsecret attestor-3 PYTH_RPC_URL
   # Telegram (same bot/chat as the keeper): envval <file> TELEGRAM_BOT_TOKEN | setsecret attestor-$i TELEGRAM_BOT_TOKEN
   for i in 1 2 3; do railway up --service attestor-$i --detach; done
   ```
   `db-url` yields `postgresql://fumpad_attestor_N:<pw>@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}`
   (Railway resolves the references). Logs must show no "attest board has no row-level security".
7. **watcher**:
   ```sh
   railway add --service watcher
   railway variables --service watcher --skip-deploys --set "SERVICE_ENTRY=keeper/dist/main.js" --set "KEEPER_MODE=watcher" --set "PYTH_SOURCE=onchain" --set "PORT=8790"
   envval ~/fumpad-keys/devnet/rpc-d.env RPC_URL      | setsecret watcher RPC_URL
   envval ~/fumpad-keys/devnet/rpc-d.env PYTH_RPC_URL | setsecret watcher PYTH_RPC_URL   # its provider's mainnet url
   # REQUIRED (governance timelocks are 1 h / 6 h, SPEC v0.7 clarification 29): the watcher alerts the guardian chat on
   # every pending params / config / admin change — without these it only logs.
   envval ~/fumpad-keys/devnet/telegram.env TELEGRAM_BOT_TOKEN | setsecret watcher TELEGRAM_BOT_TOKEN
   envval ~/fumpad-keys/devnet/telegram.env TELEGRAM_CHAT_ID   | setsecret watcher TELEGRAM_CHAT_ID
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
   claim queue (the operator pays ≈ 0.5 SOL) → samples → claims.
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

**One bot, one chat, both clusters.** The devnet and mainnet services use the same bot token and the same
`TELEGRAM_CHAT_ID` (a DM to the user). Every message from the keeper (jobs), attestors and watcher starts with a
cluster tag taken from `FUMPAD_CLUSTER`: `[MAINNET]`, `[DEVNET]` (unset = devnet), `[LOCALNET]`, then the service
prefix as before, e.g. `[MAINNET] [fumpad-watcher] …`. Optional `TELEGRAM_PREFIX` replaces the tag with a custom label
(e.g. `[MAINNET-canary]`). Because the token is shared, a `/revoke` breaks both clusters' alerts until the new token
is pushed to the devnet **and** the mainnet services (repeat step 4 in each Railway project, from
`~/fumpad-keys/mainnet/telegram.env` there).

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

**Pyth / Hermes** — only if `PYTH_SOURCE=hermes` (paid plan; the default `onchain` source has no key). Attestor-1/2/3
and the watcher; all four must use the same source. No downtime: new key first, old key revoked last.
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

## 10. Operators split — upgrading the existing devnet deployment (2026-10-13 d)

The devnet Global was initialized before `Global.operators` existed (those 64 bytes were `reserved`, all zero) and its
jobs keeper runs with attestor-1's key. The new program reads that Global as "no operators" (so samples, `claim_for`
and pre-grad buybacks refuse everyone) until the operators step runs — do the steps back to back.

```sh
# 0. build (same .so the tests ran on) — contracts/
cd ~/fumpad/contracts && anchor build -p fumpad          # target/deploy/fumpad.so = 804,472 bytes
# 1. the program data account is 770,280 bytes: extend first (≈ +0.28 SOL rent), then upgrade
set -a; . ~/fumpad-keys/devnet/rpc.env; set +a
solana program extend 5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb 40000 --url "$RPC_URL" --keypair ~/.config/solana/id.json
solana program deploy target/deploy/fumpad.so --program-id target/deploy/fumpad-keypair.json \
  --upgrade-authority ~/.config/solana/id.json --keypair ~/.config/solana/id.json --url "$RPC_URL" --with-compute-unit-price 10000
# 2. operator key + Global: ONE tx = migrate_global (operators[0] := keepers[0]) + set_operators([operator])
cd ~/fumpad/services
npx tsx scripts/devnet/bootstrap-v07.ts --step keys                 # creates operator.json (others kept)
npx tsx scripts/devnet/bootstrap-v07.ts --step operators --simulate
npx tsx scripts/devnet/bootstrap-v07.ts --step operators --yes
npx tsx scripts/devnet/bootstrap-v07.ts --step fund --yes           # operator → 2 SOL (attestor-1 target is now 0.25)
npx tsx scripts/devnet/bootstrap-v07.ts --step verify               # operators = [operator], disjoint; bytecode = local .so
# 3. services (this branch merged): the jobs keeper switches to the operator key
npx tsx scripts/devnet/secrets-v07.ts key operator | railway variables --service keeper --skip-deploys --set-from-stdin KEEPER_SECRET_KEY
for s in keeper attestor-1 attestor-2 attestor-3 watcher indexer api; do railway up --service $s --detach; done
```
Between step 1 and step 2 (seconds) the old jobs keeper's samples are refused (`Unauthorized` pre-graduation; fallback
post-graduation) — harmless. After step 2 attestor-1's key is no longer an operator, so the old jobs keeper's
samples / auto-claims / pre-grad buybacks fail until step 3 redeploys it with the operator key (do it right away; the
new binary refuses attestor-1's key, and permissionless jobs — fees, graduation, queue — never stopped). Attestors need no key change (their keys stay in `Global.keepers`, no freeze). Old
attestor-1 SOL beyond its 0.25 target can be drained to the deployer. Then move the attestors to the §1 topology
(separate projects / accounts / providers) one at a time: an attestor that is down only costs liveness while the other
two sign.

## 11. 2026-10-14 upgrade of the existing devnet deployment: timelocks 1 h / 6 h + fee policies / first-coin config + on-chain Pyth

One program upgrade carries both contract changes: the timelock constants (SPEC v0.7 clarification 29:
`PARAMS_TIMELOCK_SECS` = `CONFIG_TIMELOCK_SECS` = 1 h, `ADMIN_TIMELOCK_SECS` = 6 h, were 48 h; constants only) and
the per-config fee policies (clarification 30, INTERFACE §5.9 / §8 2026-10-14 b: Global 1,044 → 1,491 bytes, grown by
`migrate_global`). The new program reads Global as 1,491 bytes, so every instruction that loads Global fails from the
upgrade until step 2 — run it right after. Coins need nothing (their `fee_policy_kind` byte was reserved = 0 =
standard; their accounts keep 546 bytes). The operators step (§10) is unchanged and already done on devnet. Devnet
runs the local `anchor build` (its deployed hash = the local macOS build, LAUNCH-DAY §10); only mainnet uses the
docker build (`scripts/verify-build.sh`). A config change pending before the upgrade keeps its stored eta.

```sh
# 0. build — contracts/ (keypair: cp ~/fumpad-keys/devnet/fumpad-v07-program-keypair.json target/deploy/fumpad-keypair.json)
cd ~/fumpad/contracts && anchor build -p fumpad
ls -l target/deploy/fumpad.so                                # new size
set -a; . ~/fumpad-keys/devnet/rpc.env; set +a
solana program show 5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb --url "$RPC_URL"   # "Data Length"
# 1. extend iff Data Length < the new .so (bytes = difference + ~10,000 headroom), then ONE upgrade
solana program extend 5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb <bytes> --url "$RPC_URL" --keypair ~/.config/solana/id.json
solana program deploy target/deploy/fumpad.so --program-id target/deploy/fumpad-keypair.json \
  --upgrade-authority ~/.config/solana/id.json --keypair ~/.config/solana/id.json --url "$RPC_URL" --with-compute-unit-price 10000
# 2. right away: grow Global (migrate_global, admin = deployer) — services/
cd ~/fumpad/services
npx tsx scripts/devnet/bootstrap-v07.ts --step keys                    # creates dbc-config-first-coin.json + first-coin-wallet.json
npx tsx scripts/devnet/bootstrap-v07.ts --step policies --simulate
npx tsx scripts/devnet/bootstrap-v07.ts --step policies --yes          # migrate_global (1,044 → 1,491; ≈ 0.0023 SOL rent)
# 3. the first-coin config: create it, queue its add with the wallet-split policy (1 h timelock), fund the fee wallet
npx tsx scripts/devnet/bootstrap-v07.ts --step config --yes            # create_config (first coin: 99% → 3% / 25 slots, 3% DAMM v2)
npx tsx scripts/devnet/bootstrap-v07.ts --step policies --yes          # queue_config(first-coin config, add, {1, 100, 140, max 1, first-coin-wallet})
npx tsx scripts/devnet/bootstrap-v07.ts --step fund --yes              # first-coin-wallet → 0.01 SOL (claims refuse to leave it below rent)
# 4. services (this branch merged; indexer migration 011 runs at start). Attestors + watcher switch to the on-chain
#    Pyth source TOGETHER (§4 "Pyth"): PYTH_SOURCE=onchain + PYTH_RPC_URL = each one's provider's MAINNET endpoint;
#    the watcher alerts the guardian chat on pending governance changes (1 h / 6 h timelocks) — set its TELEGRAM_*.
for s in attestor-1 attestor-2 attestor-3 watcher; do railway variables --service $s --skip-deploys --set "PYTH_SOURCE=onchain"; done
envval ~/fumpad-keys/devnet/rpc.env   RPC_URL | sed 's#//devnet\.#//mainnet.#' | setsecret attestor-1 PYTH_RPC_URL
envval ~/fumpad-keys/devnet/rpc-b.env PYTH_RPC_URL | setsecret attestor-2 PYTH_RPC_URL
envval ~/fumpad-keys/devnet/rpc-c.env PYTH_RPC_URL | setsecret attestor-3 PYTH_RPC_URL
envval ~/fumpad-keys/devnet/rpc-d.env PYTH_RPC_URL | setsecret watcher PYTH_RPC_URL
envval ~/fumpad-keys/devnet/telegram.env TELEGRAM_BOT_TOKEN | setsecret watcher TELEGRAM_BOT_TOKEN
envval ~/fumpad-keys/devnet/telegram.env TELEGRAM_CHAT_ID   | setsecret watcher TELEGRAM_CHAT_ID
railway variables --service api --skip-deploys --set "LAUNCH_FIRST_COIN=false"
for s in indexer api keeper attestor-1 attestor-2 attestor-3 watcher; do railway up --service $s --detach; done
# 5. after the 1 h config timelock: execute the add, verify; redeploy the app (Vercel)
npx tsx scripts/devnet/bootstrap-v07.ts --step policies --yes          # execute_config
npx tsx scripts/devnet/bootstrap-v07.ts --step verify                  # bytecode = local .so, Global 1,491 B, standard + first-coin configs + policies
```
Until step 5 the API offers no first-coin config (`/v1/launch/options` → `firstCoin: null`; prepare `first_coin` → 409)
and standard launches work as before. To try a first-coin launch on devnet: api `LAUNCH_FIRST_COIN=true`, then
`fumpad.vercel.app/launch?config=first-coin`; afterwards `bootstrap-v07.ts --step first-coin-done --yes` (queues the
removal), rerun after 1 h (executes), api `LAUNCH_FIRST_COIN=false`. Tickets attested earlier with Hermes prices may
show as watcher mismatches (§4 "Pyth", Switching).

## 12. 2026-10-15 devnet upkeep: program to main + alert noise

**Program upgrade.** Contract diff vs the previously deployed build: one line, `DEFAULT_MAX_PRICE_AGE_SECS` 60 → 120
(commit 635e3ce, `constants.rs`; only used by `Params::default()`, i.e. `initialize_global` and the pending-params
reset). The devnet Global already stores `params.max_price_age_secs = 120`, so no `set_params` was needed.
Local `anchor build -p fumpad` (830,248 B; fits the 830,760 B program data account, no extend), contracts tests
23 lib + 109 integration pass, one `solana program deploy` (§11 step 1 command). Executable hash
before `6da802ef26db…e89d` → after `88d345d5ca12…679c` (= local .so; `bootstrap-v07.ts --step verify` ✓).
Upgrade tx `2CsxaqmDrH8MGS6VRhij5cy5TVW7ZW4PVikn6eV5PeU8GzYVzf3kshEw3Ma552Yjthk4yDrufdrNaL3VoAFo4Fb6`.

**Alert noise — attestor-2 + watcher on the public RPC (TEMPORARY measure, devnet only).** §8 wants one provider
per keeper; on devnet attestor-2 and the watcher ran on `api.devnet.solana.com` (429s → derivation-failed alerts)
and their `PYTH_RPC_URL` on public mainnet (history only ≈ 6 h back → `oracle_unavailable` for older sells, which is
what makes the watcher flag the two Oct 13 `$LIVE7` tickets every ~30 min). Until the QuickNode / Alchemy keys
arrive (→ `rpc-b.env` / `rpc-d.env`, then the §8 loop), point both at provider A (Helius) — this shares one
provider between attestor-1/2/3 and the watcher, acceptable on devnet only, never on mainnet:
```sh
for s in attestor-2 watcher; do
  envval ~/fumpad-keys/devnet/rpc.env RPC_URL | setsecret $s RPC_URL
  envval ~/fumpad-keys/devnet/rpc.env RPC_URL | sed 's#//devnet\.#//mainnet.#' | setsecret $s PYTH_RPC_URL
  railway variables --service $s --skip-deploys --set "RPC_MIN_GAP_MS=0"
  railway redeploy --service $s --yes
done
```

**The two `$LIVE7` tickets** (mint `HAwjL35B…fmbL`): `DQn5aHjw…Upp57` (alice) and `EJQQbYzv…bhEx` (owner `6uCk7vSe…`),
attested Oct 13 15:40 / 15:49 UTC. They can NOT be voided: both are `queued` (void needs `open`) and their 1 h
challenge windows closed Oct 13 16:40 / 16:49 UTC (`scripts/ops/void-ticket.ts` simulation → `TicketNotOpen`).
Guardian tool for future cases (simulates by default, refuses mainnet):
`npx tsx scripts/ops/void-ticket.ts <ticket> … [--reopen] [--reason n] [--yes]`.
