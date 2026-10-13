# FUMPAD mainnet — launch-day runbook

The exact, ordered path from "nothing on mainnet" to "first coin live", and what to do when something goes wrong.
Every chain write goes through `scripts/mainnet/bootstrap-mainnet.ts` (plan by default; `--send` needs
`--cluster mainnet --i-understand-this-spends-real-sol` **and** a typed phrase per step) or `scripts/ops/multisig.ts`
(simulate first, `--yes` to send, `--cluster` must match the RPC's genesis). The whole sequence was rehearsed on a local
copy of mainnet by `npm run mainnet:rehearsal` (results: §9). Costs: `MAINNET-COSTS.md`. Governance: `MULTISIG.md`.
Railway/env details: `DEPLOY-v07.md` (devnet) — this file says what changes for mainnet.

Run every command from `~/fumpad/services` on the release commit unless stated otherwise. Secrets are piped, never
echoed (`envval` / `setsecret` helpers from DEPLOY-v07.md §4).

```sh
cd ~/fumpad/services
K=~/fumpad-keys/mainnet
export FUMPAD_PROGRAM_ID=$(solana-keygen pubkey $K/fumpad-program-keypair.json)   # after `--step keys`; multisig.ts needs it
B="npx tsx scripts/mainnet/bootstrap-mainnet.ts --config $K/bootstrap.json --cluster mainnet"
M="npx tsx scripts/ops/multisig.ts"; C="--cluster mainnet --rpc-env $K/rpc.env"
SPEND="--send --i-understand-this-spends-real-sol"
```

## Timeline at a glance

| when | what | irreversible? |
|---|---|---|
| T−7 d … T−3 d | providers, keys, multisigs, build, rehearsal, Railway mainnet project (services stopped) | no |
| **T−3 d (day 0)** | deploy program → DBC config → `initialize_global` → fund keepers → `propose_admin` | program id + Global params/cluster_tag: yes |
| T−3 d … T−1 d | 48 h: voters approve `accept_admin` in Squads; services run against mainnet with the app still gated | no (guardian = deployer can `cancel_admin`) |
| **T−1 d (day 2)** | execute `accept_admin` (admin/guardian → vaults) → upgrade authority → admin vault → guardian drill | **yes** |
| **T0** | pre-flight re-check → open the app (prelaunch gate off) → first coin | — |

Opening the app only after the handover means no hot key holds admin power while users have money in.

## 1. Pre-flight (T−7 d … T−3 d)

1. **Release commit.** Tag it. Gates on that commit: `npm run typecheck`, `npm test`, `npm run local` (20/20),
   `npm run multisig:rehearsal`, `npm run mainnet:rehearsal` (must end `✓ mainnet rehearsal passed`).
2. **Meteora / Squads / Token-2022 / Pyth programs = what we tested.** Re-dump mainnet read-only and compare with
   `scripts/mainnet/tested-programs.json` (written by the last passing rehearsal; DBC 0.2.1 `4c26a8a5…`, DAMM v2
   0.2.4 `4d5b920b…`, Squads v4 `dec8d3e0…` + their upgrade authorities and the DAMM v2 migration config):
   ```sh
   npm run mainnet:compare            # exit 1 + the list if any program/account changed
   ```
   Any difference (Meteora upgrades DBC/DAMM v2 regularly) → re-run `npm run mainnet:rehearsal` (it re-dumps
   mainnet) and the contracts' mainnet-binary tests before going on. Run it again on T0 morning.
3. **RPC providers** (MAINNET-COSTS.md §5): four different companies, env files mode 600 in `$K`:
   `rpc.env` (A: indexer, api, keeper, attestor-1), `rpc-b.env` (attestor-2), `rpc-c.env` (attestor-3), `rpc-d.env`
   (watcher) — `RPC_URL=…` (+ `RPC_MIN_GAP_MS` if rate-limited). The current shared Helius key 429s at 1 req/s on
   mainnet: **not usable** for any service. Check all four (archive history, v1 txs, pagination, rate limit,
   cross-provider identical records):
   ```sh
   npm run rpc-check -- --env $K/rpc.env --env $K/rpc-b.env --env $K/rpc-c.env --env $K/rpc-d.env
   ```
   After the first coin exists, re-run with `--l8-slot <its launch slot>`.
4. **Pyth / Hermes**: mainnet key in `$K/pyth.env` (`PYTH_API_KEY=…`); check `200` with the curl of DEPLOY-v07.md §9
   (path `$K/pyth.env`). All three attestors and the watcher use the same source.
5. **Telegram**: `$K/telegram.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) — a separate mainnet chat; check
   `getMe` → `"ok":true` (DEPLOY-v07.md §9). Guardians and the ops person are in the chat.
6. **Governance parties** (MULTISIG.md §2–3): 5 admin Ledger voters (3-of-5, 48 h Squads time lock) + 3 guardian
   Ledgers (2-of-3, no time lock) + the ops key (`$K/ops.json`, initiate + execute only). Create both multisigs
   (deployer pays ≈ 0.004 SOL rent; Squads creation fee is 0 today):
   ```sh
   $M create $C --config $K/multisig/admin.json    --payer $K/deployer.json --yes
   $M create $C --config $K/multisig/guardian.json --payer $K/deployer.json --yes
   $M status $C --admin-config $K/multisig/admin.json --guardian-config $K/multisig/guardian.json   # → multisig PDAs + vault[0]
   ```
   Every voter adds the multisig in app.squads.so and checks members/threshold/time lock.
7. **Treasury**: a Squads vault (e.g. the admin vault or a 3rd multisig) or a hardware wallet — public key only.
8. **Deployer** `$K/deployer.json` (hot, yours): fund with the amount from MAINNET-COSTS.md §7 (≈ 10 SOL incl. the
   transient deploy buffer). After the handover it holds no power; drain it.
9. **Config file** `$K/bootstrap.json` from `scripts/mainnet/mainnet-config.example.json`: `deployerKeypair`,
   `admin`/`guardian` (`kind: "squads"`, `multisig` = PDA, `address` = vault[0]), `treasury`, `opsKeypair`,
   `computeUnitPriceMicroLamports` (20,000 default; raise if `getRecentPrioritizationFees` p75 is higher), `fund`.
10. **Hot keys + program id** (offline is fine):
    ```sh
    $B --step keys          # attestor-1/2/3, launch-signer, dbc-config, fumpad-program-keypair (700/600, never overwritten)
    ```
    **Back up `fumpad-program-keypair.json` offline now** (USB + paper/password manager), and the attestor /
    launch-signer keys to the secret store. `$K/pubkeys.json` lists every public key.
11. **Build for the mainnet id** (the devnet id `5YMF…` is compiled in; the mainnet .so needs its own `declare_id!`,
    INTERFACE-v0.7.md): on a release branch set `declare_id!("<mainnet id>")` in `contracts/programs/fumpad/src/lib.rs`
    (+ `Anchor.toml`), commit, and build that commit; `build-program.ts` does exactly this transformation in a temp
    copy and verifies the .so embeds the id:
    ```sh
    npm run mainnet:build-program -- --program-keypair $K/fumpad-program-keypair.json
    # → .local/program-build/<id>/deploy/fumpad.so  (749,800 B today; record the sha256)
    ```
    (Better: `anchor build --verifiable` on the committed change, so anyone can reproduce the hash; pass it with `--so`.)
12. **Plan + simulate** against mainnet (read-only):
    ```sh
    $B --step all              # plan: costs, keys, what's missing
    $B --step config,fund --simulate
    ```
13. **Railway mainnet project** (new project, e.g. `fumpad-mainnet`; nothing shared with devnet except
    `waitlist-db`). Services as DEPLOY-v07.md §4, differences:
    | service | mainnet env |
    |---|---|
    | all except grinder | **`FUMPAD_PROGRAM_ID=<mainnet id>`** (the SDK's id comes from this; missing = devnet id = sees nothing) |
    | `Postgres` | new, empty (migrations run at the indexer's start) |
    | `indexer` | `RPC_URL` = A, `BACKFILL_FROM_SLOT` = the deploy slot (from `$B --step verify` / Solscan) |
    | `api` | `RPC_URL` = A, `LAUNCH_SIGNER_KEY` = `npx tsx …` pipe of `$K/launch-signer.json`, `LAUNCH_REQUIRE_SIGNATURE=true`, new `MINT_POOL_KEY` (`openssl rand -hex 32`, also on the grinder), new `API_SSR_SECRET` (also on Vercel), `CORS_ORIGINS=https://fumpad.app,https://www.fumpad.app`, `TRUST_PROXY_HOPS=2`, **`WAITLIST_DATABASE_URL`** = the existing devnet project's `waitlist-db` public URL (same DB: the list survives) and **the same `WAITLIST_IP_SALT`** (`~/fumpad-keys/waitlist/ip_salt`) |
    | `grinder` | `DATABASE_URL`, `MINT_POOL_KEY`, `POOL_TARGET` (≥ 20 before T0) |
    | `keeper` | `KEEPER_MODE=jobs`, `KEEPER_SECRET_KEY` = attestor-1, `RPC_URL` = A, `KEEPER_DAILY_BUDGET_SOL=2`, `MIN_KEEPER_LAMPORTS=500000000`, `TELEGRAM_*` (mainnet) |
    | `attestor-1/2/3` | `KEEPER_MODE=attestor`, own key, own DB role (`secrets-v07.ts db-sql` adapted to `$K`), `RPC_URL` = A / B / C, `PYTH_SOURCE=hermes`, `PYTH_API_KEY`, `ATTEST_BOARD_REQUIRE_RLS=1`, `TELEGRAM_*` |
    | `watcher` | `KEEPER_MODE=watcher`, `RPC_URL` = D, `PYTH_*`, `TELEGRAM_*` (guardians' chat) |
    Create them with env set but **don't deploy the keeper/attestors before day 0** (no Global yet). Grinder +
    Postgres can start early (the vanity pool fills).
14. **App (Vercel)**: the app has the devnet program id compiled in (`app/src/chain/cluster.ts`
    `FUMPAD_PROGRAM_ADDRESS` + the vendored SDK `app/vendor/fumpad-sdk-0.7.0.tgz`): the mainnet release changes that
    constant and re-packs the SDK with `DEFAULT_FUMPAD_PROGRAM_ID` = the mainnet id (or reads
    `NEXT_PUBLIC_FUMPAD_PROGRAM` — not built yet, see open questions). Production env: `NEXT_PUBLIC_SOLANA_RPC` =
    a **mainnet frontend key** restricted to our domains (no `devnet` in the URL: the app infers the cluster from
    it), `NEXT_PUBLIC_FUMPAD_API` = the mainnet API URL, `API_SSR_SECRET` = the new one, `NEXT_PUBLIC_SITE_URL=https://fumpad.app`.
    Keep `NEXT_PUBLIC_PRELAUNCH` unset (gate on) until T0. Preview deployment first; check CSP (app/LAUNCH.md).

## 2. Day 0 (T−3 d): program, config, Global, keepers, propose_admin

Each `--send` prints a summary and asks you to type the phrase it shows (e.g. `program 7xKX9a`).
```sh
$B --step verify                                     # pre-check: everything missing is listed, nothing ✗ besides that
$B --step program       $SPEND --so <the .so>        # solana program deploy (≈ 760 write txs; resumable, see §8)
$B --step config        $SPEND                       # DBC create_config (mainnet vector bytes checked first)
$B --step init          $SPEND                       # initialize_global: IRREVERSIBLE params/cluster_tag/keepers — read the summary
$B --step fund          $SPEND                       # attestor-1 2 SOL, attestor-2/3 0.3 SOL
$B --step propose-admin $SPEND                       # admin → admin vault, guardian → guardian vault (48 h)
$B --step verify                                     # all ✓; "next: after <eta> … accept-admin"
$B --step accept-admin  $SPEND                       # ops key creates the accept_admin vault tx (no approval)
$M show-tx $C --config $K/multisig/admin.json --index <N>   # voters check: accept_admin, signer = admin vault
```
Then deploy the Railway services in DEPLOY-v07.md §4 order (indexer → api → keeper → board roles → attestors →
watcher). Check: API `/v1/status`, attestor logs "3 active keepers", board RLS on, watcher `/v1/verification` empty,
keeper heartbeat in Telegram. The app stays gated; the team can test on `fumpad.vercel.app` (a small real coin —
remember it costs real SOL and is permanent).

## 3. T−3 d … T−1 d: approvals

3 admin voters approve tx `N` in the Squads app on their Ledgers. The Squads 48 h time lock starts at the 3rd
approval, so approve on day 0. `$B --step verify` / `$B --step accept-admin` (plan) show approvals and when it can
execute. Any doubt → the guardian (still the deployer) cancels: `npx tsx scripts/ops/multisig.ts` is not needed,
the deployer signs `cancel_admin` directly (rehearsed in MULTISIG.md §6).

## 4. Day 2 (T−1 d): handover

```sh
$B --step accept-admin      $SPEND     # executes once BOTH the FUMPAD eta and the Squads time lock passed
$B --step upgrade-authority $SPEND     # refused unless Global.admin = admin vault; IRREVERSIBLE
$B --step verify                       # "✓ governance handover complete"
$M status $C --admin-config $K/multisig/admin.json --guardian-config $K/multisig/guardian.json
# guardian drill (harmless): set_pause(0) proposed by ops, 2 guardian approvals, execute
$M propose $C --config $K/multisig/guardian.json --member-key $K/ops.json --action set-pause --bits 0 --yes
$M execute $C --config $K/multisig/guardian.json --index <G> --member-key $K/ops.json --yes
```
Drain the deployer (`solana transfer` to the treasury) once nothing else needs it.

## 5. T0: open

1. Morning re-checks: `npm run mainnet:compare` (✓), `$B --step verify` (✓), `rpc-check` on the four providers,
   keeper/attestor balances (attestor-1 ≥ 1 SOL), Telegram heartbeat, watcher feed clean, Railway services healthy,
   vanity pool ≥ 20, `/v1/status` green.
2. Prelaunch gate release (app/LAUNCH.md "Open the app"): Vercel Production `NEXT_PUBLIC_PRELAUNCH=off` → redeploy →
   `curl -sI https://fumpad.app/launches` = `200`.
3. **First coin**: the team launches through the app (Privy wallet, small first buy) → check in order: Solscan tx
   (DBC init + swap + `register_coin`, launch-signer co-signed), API coin page, WS feed, trades indexed, then a
   matured ≥ $50 sell → `TicketAttested` by 2 of 3 within minutes, watcher verdict `match`.
4. Re-run `rpc-check … --l8-slot <first coin's launch slot>`.
5. Announce.

## 6. Monitoring (first 72 h, then daily)

- Telegram: keeper heartbeat (every 8 min), low balance (`MIN_KEEPER_LAMPORTS`), daily budget, attestor
  disagreements, watcher mismatches. Watcher `/v1/verification`: any `mismatch` = page the guardians.
- Balances: attestor-1 (jobs + attestations) ≥ 1 SOL, attestor-2/3 ≥ 0.1 SOL; top up from the treasury. Graduations
  are paid from the 0.85 SOL migration fee (rehearsed: the keeper's net cost per graduation is fees only).
- `/v1/status`: indexer lag, vanity pool. Railway metrics: memory/CPU of indexer + api.
- Weekly: `npm run mainnet:compare` (Meteora upgrades), waitlist export (DEPLOY-v07.md §7).

## 7. Incident: pause (minutes)

Guardian multisig, no time lock (MULTISIG.md §4):
```sh
$M propose $C --config $K/multisig/guardian.json --member-key $K/ops.json --action set-pause --bits 31 --yes   # PAUSE_ALL; or 1 launch, 2 trade, 4 claims, 8 graduate, 16 attest
# 2 guardians approve in the Squads app, then:
$M execute $C --config $K/multisig/guardian.json --index <G> --member-key $K/ops.json --yes
```
- `set_pause` lapses after 7 days (re-pause to extend). Trading on Meteora itself can't be paused by us (DBC/DAMM
  pools are permissionless); `PAUSE_TRADE` stops the FUMPAD router only.
- Bad attestation: `PAUSE_ATTEST` (16) + `void_ticket` by the guardian (Squads transaction builder).
- App: `NEXT_PUBLIC_PRELAUNCH` back on + redeploy hides the app (the chain keeps running).
- Keeper/attestor misbehaving: stop the Railway service (attestations need 2 of 3; one down is fine). A compromised
  keeper key: guardian `PAUSE_ATTEST`, admin `set_keepers` (48 h Squads lock, then the 6 h freeze for the new key).
- Unpause: `--bits 0` the same way.

## 8. Rollback / recovery

- **Before `initialize_global`**: nothing user-facing exists. A bad deploy: the deployer is still upgrade authority —
  `solana program deploy --program-id <id> <fixed.so>` (upgrade) or close the program (`solana program close`,
  recovers ≈ 3.8 SOL, the id can never be reused).
- **Interrupted deploy**: `solana program show --buffers` → resume with `solana program deploy --buffer <B> …` or
  `solana program close <B>` to recover the buffer rent.
- **After `initialize_global`, before the handover**: params can only change via `queue_params` (48 h);
  keepers via `set_keepers` (immediate, 6 h freeze per new key); a wrong `propose_admin` → `cancel_admin` by the
  guardian (= deployer). A wrong Global (cluster_tag/params) can't be re-initialized: redeploy under a new program id.
- **After the handover**: every fix is a Squads proposal — program upgrade (MULTISIG.md "Program upgrades
  afterwards": buffer → hash check by every approver → 3 approvals → 48 h → execute), params (48 h FUMPAD + 48 h
  Squads), config allow-list. Emergencies are the guardian's pause (§7).
- **Services**: Railway "Redeploy" of the previous deployment; DB restore from Railway backups; the chain is the
  source of truth (the indexer re-derives from `BACKFILL_FROM_SLOT`).

## 9. Rehearsal (what was proven locally)

`npm run mainnet:rehearsal` (≈ 16 min; `scripts/mainnet/rehearsal.ts`). **Result 2026-10-13: 37/37 ✓** (mainnet
read at slot 456,589,591 with 23 read-only requests; DBC, DAMM v2 and Squads v4 on mainnet = the fixtures every test
suite runs; manifest committed as `scripts/mainnet/tested-programs.json`). Other stacks on the machine: set
`FUMPAD_RPC_PORT`, `FUMPAD_API_PORT`, `FUMPAD_GOSSIP_PORT`, `FUMPAD_PG_PORT`. It reads mainnet only through `get*` calls (spaced, rate-limit aware), builds a validator with the
exact mainnet DBC / DAMM v2 / Squads v4 / Token-2022 / Pyth-receiver bytes, the DAMM v2 migration config, Squads
ProgramConfig, the DBC/DAMM pool authorities' real balances and mainnet's feature-gate set; deploys fumpad with the
same `solana program deploy` call; runs every bootstrap step through the library and the CLI (incl. the refusals
and a typed confirmation); runs the full service stack on mainnet params (600 s hold, $50 minimum, 85 SOL curve);
and completes the handover with a clock warp past 48 h. Differences from mainnet that remain: the local rent rate is
~37% higher than mainnet's (costs measured locally are upper bounds), prices are frozen at the dump's Pyth value,
the smoke runs inside the 48 h window (the warp puts the chain ~2 days ahead of the services' clocks), and the Squads
voters are generated keys rather than Ledgers.

Found and fixed while rehearsing: (1) the SDK resolved the IDL's pinned `program` account of `initialize_global` to
the devnet id even with `FUMPAD_PROGRAM_ID` set (`InvalidProgramId`) — now follows the override; (2) a freshly
deployed program is not callable in the same slot (simulating right after the deploy gave `UnsupportedProgramId`):
leave a few slots between `program` and `init` (on mainnet the commands are minutes apart anyway); (3) the local
validator's default `--limit-ledger-size` (10,000 shreds) purged history after a ~1,500-shred deploy and broke
`getSignaturesForAddress` for every service ("Transaction … not found"): the harness now keeps 50M shreds. Mainnet
providers keep full history; `rpc-check` verifies it.
