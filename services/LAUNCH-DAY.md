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
export FUMPAD_CLUSTER=mainnet     # with a non-default FUMPAD_PROGRAM_ID it is required (multisig.ts, services)
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
   `rpc.env` (A: indexer, api, keeper), `rpc-b.env` (attestor-1), `rpc-c.env` (attestor-2), `rpc-d.env` (attestor-3),
   `rpc-e.env` (watcher) — five different companies if you can, never one shared by two attestors or by an attestor
   and the watcher (DEPLOY-v07.md §1 topology) — `RPC_URL=…` (+ `RPC_MIN_GAP_MS` if rate-limited). The current shared Helius key 429s at 1 req/s on
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
    $B --step keys          # attestor-1/2/3, operator (jobs key), launch-signer, dbc-config, fumpad-program-keypair (700/600, never overwritten)
    ```
    **Back up `fumpad-program-keypair.json` offline now** (USB + paper/password manager), and the attestor /
    launch-signer keys to the secret store. `$K/pubkeys.json` lists every public key.
11. **Verifiable build for the mainnet id** (details + rationale: §10). No code edit: the default build declares the
    devnet id; `--features mainnet` compiles in the id committed in `contracts/program-ids/mainnet.txt`
    (`programs/fumpad/build.rs`; the build fails while the file says `UNSET` or holds the devnet id).
    ```sh
    # a) commit the program id (the PUBKEY only; the keypair never enters git)
    cd ~/fumpad && solana-keygen pubkey $K/fumpad-program-keypair.json      # = $FUMPAD_PROGRAM_ID
    #    replace the `UNSET` line of contracts/program-ids/mainnet.txt with it, then:
    git add contracts/program-ids/mainnet.txt && git commit -m "mainnet program id $FUMPAD_PROGRAM_ID"
    git tag fumpad-mainnet-v0.7 && git push origin HEAD --tags && REL=$(git rev-parse HEAD)
    # b) verifiable build of that commit (docker; mount = contracts/, the cargo workspace)
    cd ~/fumpad/contracts && solana-verify build --library-name fumpad --base-image <IMAGE> -- --features mainnet
    solana-verify get-executable-hash target/deploy/fumpad.so                # = H (record it)
    # c) cross-check with the local, non-docker path (same feature, platform-tools v1.57, sbpf v3)
    cd ~/fumpad/services && npm run mainnet:build-program -- --program-keypair $K/fumpad-program-keypair.json
    #    → "program-ids/mainnet.txt (committed) = <id>: this is the release build's input" + "executable hash H'"
    ```
    Deploy the docker-built `contracts/target/deploy/fumpad.so` (`--so` in §2). H ≠ H' means the image's toolchain
    differs from ours (§10): pick the image that matches before day 0. `$B --step program` on mainnet refuses unless
    the committed `mainnet.txt` holds `$FUMPAD_PROGRAM_ID`.
12. **Plan + simulate** against mainnet (read-only):
    ```sh
    $B --step all              # plan: costs, keys, what's missing
    $B --step config,fund --simulate
    ```
13. **Railway mainnet projects** (core project, e.g. `fumpad-mainnet`; nothing shared with devnet except
    `waitlist-db`) **+ one project per attestor** (`fumpad-attestor-1/2/3`, attestor-2 and attestor-3 under other
    Railway accounts — ideally other people's — and attestor-3 ideally on another cloud; DEPLOY-v07.md §1 topology:
    one cloud-account compromise must never yield two attestation keys, and the operator key never sits next to an
    attestor key). Services as DEPLOY-v07.md §4, differences:
    | service | mainnet env |
    |---|---|
    | all except grinder | **`FUMPAD_PROGRAM_ID=<mainnet id>`** + **`FUMPAD_CLUSTER=mainnet`** (the SDK's id comes from these; each service checks at start that the program exists behind its `RPC_URL` and `Global.cluster_tag` = 0, else logs `✗ refusing to start` and exits 1 — so they can only start after `--step init`) |
    | `Postgres` | new, empty (migrations run at the indexer's start) |
    | `indexer` | `RPC_URL` = A, `BACKFILL_FROM_SLOT` = the deploy slot (from `$B --step verify` / Solscan) |
    | `api` | `RPC_URL` = A, `LAUNCH_SIGNER_KEY` = `npx tsx …` pipe of `$K/launch-signer.json`, `LAUNCH_REQUIRE_SIGNATURE=true`, new `MINT_POOL_KEY` (`openssl rand -hex 32`, also on the grinder), new `API_SSR_SECRET` (also on Vercel), `CORS_ORIGINS=https://fumpad.app,https://www.fumpad.app`, `TRUST_PROXY_HOPS=2`, **`WAITLIST_DATABASE_URL`** = the existing devnet project's `waitlist-db` public URL (same DB: the list survives) and **the same `WAITLIST_IP_SALT`** (`~/fumpad-keys/waitlist/ip_salt`) |
    | `grinder` | `DATABASE_URL`, `MINT_POOL_KEY`, `POOL_TARGET` (≥ 20 before T0) |
    | `keeper` (core) | `KEEPER_MODE=jobs`, `KEEPER_SECRET_KEY` = **operator** (`$K/operator.json`; refuses an attestor key), `RPC_URL` = A, `KEEPER_DAILY_BUDGET_SOL=2`, `MIN_KEEPER_LAMPORTS=500000000`, `TELEGRAM_*` (mainnet) |
    | `attestor-1/2/3` (own projects) | `KEEPER_MODE=attestor`, own key (refuses the operator key), own DB role (`secrets-v07.ts db-sql` adapted to `$K`; `db-url attestor-N --public <board TCP proxy>` from its project), `RPC_URL` = B / C / D, `PYTH_SOURCE=hermes`, `PYTH_API_KEY`, `ATTEST_BOARD_REQUIRE_RLS=1`, `TELEGRAM_*` |
    | `watcher` | `KEEPER_MODE=watcher`, `RPC_URL` = E, `PYTH_*`, `TELEGRAM_*` (guardians' chat) |
    Create them with env set but **don't deploy the keeper/attestors before day 0** (no Global yet). Grinder +
    Postgres can start early (the vanity pool fills).
14. **App (Vercel)**: no code change, no SDK repack — build-time env only (Production; `NEXT_PUBLIC_*` are inlined at
    build, so set them before the deploy and redeploy after any change):
    | variable | mainnet value |
    |---|---|
    | `NEXT_PUBLIC_FUMPAD_PROGRAM_ID` | the mainnet id (`$FUMPAD_PROGRAM_ID`) |
    | `NEXT_PUBLIC_FUMPAD_CLUSTER` | `mainnet` (required once the id is set: the build fails without it) |
    | `NEXT_PUBLIC_SOLANA_RPC` | a **mainnet frontend key** restricted to our domains (no `devnet`/`testnet` in the URL: with cluster `mainnet` such a URL fails the build) |
    | `NEXT_PUBLIC_FUMPAD_API` | the mainnet API URL |
    | `API_SSR_SECRET` | the new one (= the mainnet API's) |
    | `NEXT_PUBLIC_SITE_URL` | `https://fumpad.app` |
    `app/next.config.ts` hands the id/cluster to the vendored SDK; the silent-signing allow-list signs for that id only
    and the app refuses to load if the SDK and the app disagree (`app/src/chain/deployment.test.ts`). Check on the
    preview: the footer's program link = `$FUMPAD_PROGRAM_ID`, no "Devnet" badge. Keep `NEXT_PUBLIC_PRELAUNCH` unset
    (gate on) until T0. Preview deployment first; check CSP (app/LAUNCH.md).

## 2. Day 0 (T−3 d): program, config, Global, keepers, propose_admin

Each `--send` prints a summary and asks you to type the phrase it shows (e.g. `program 7xKX9a`).
```sh
$B --step verify                                     # pre-check: everything missing is listed, nothing ✗ besides that
$B --step program       $SPEND --so ~/fumpad/contracts/target/deploy/fumpad.so   # the §1.11 docker build (≈ 760 write txs; resumable, see §8)
solana-verify get-program-hash -u "$(sed -n 's/^RPC_URL=//p' $K/rpc.env)" $FUMPAD_PROGRAM_ID   # must = H (§1.11); then §10 (verify + OtterSec) today, while the deployer is upgrade authority
$B --step config        $SPEND                       # DBC create_config (mainnet vector bytes checked first)
$B --step init          $SPEND                       # initialize_global: IRREVERSIBLE params/cluster_tag/keepers — read the summary
$B --step fund          $SPEND                       # operator 2 SOL, attestor-1/2/3 0.3 SOL
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
   keeper/attestor balances (operator ≥ 1 SOL), Telegram heartbeat, watcher feed clean, Railway services healthy,
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
- Balances: operator (jobs keeper) ≥ 1 SOL, attestor-1/2/3 ≥ 0.1 SOL each; top up from the treasury. Graduations
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
  attestor key: guardian `PAUSE_ATTEST`, admin `set_keepers` (48 h Squads lock, then the 6 h freeze for the new key).
  A compromised operator (jobs) key: stop the `keeper` service; it can't attest — at worst it times samples / pre-grad
  buybacks within the guards; admin `set_operators` to a fresh key (48 h Squads lock, no freeze), then redeploy the
  keeper with it. A pause isn't needed for an operator compromise (`PAUSE_TRADE` stops pre-grad buybacks if wanted).
- Unpause: `--bits 0` the same way.

## 8. Rollback / recovery

- **Before `initialize_global`**: nothing user-facing exists. A bad deploy: the deployer is still upgrade authority —
  `solana program deploy --program-id <id> <fixed.so>` (upgrade) or close the program (`solana program close`,
  recovers ≈ 3.8 SOL, the id can never be reused).
- **Interrupted deploy**: `solana program show --buffers` → resume with `solana program deploy --buffer <B> …` or
  `solana program close <B>` to recover the buffer rent.
- **After `initialize_global`, before the handover**: params can only change via `queue_params` (48 h);
  keepers via `set_keepers` (immediate, 6 h freeze per new key), operators via `set_operators` (immediate); a wrong `propose_admin` → `cancel_admin` by the
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

## 10. Verifiable build (program id per cluster without code edits)

**Mechanism.** `declare_id!` must equal the deployed id, and the mainnet program keypair only exists from launch day
(`--step keys`). So the id is data, not code:
- `contracts/program-ids/devnet.txt` = `5YMF…S9Fb` = the `declare_id!` of the default build (`anchor build`; a unit
  test in `lib.rs` and `test/ops/mainnet.test.ts` keep them equal). Devnet/local builds are unchanged (same 754,288 B).
- `contracts/program-ids/mainnet.txt` = `UNSET` until launch day. Cargo feature `mainnet` (`programs/fumpad/build.rs`)
  reads it and compiles in `declare_id!("<it>")` instead; the build **fails** while it is `UNSET`, not a 32-byte
  base58 key, or the devnet id. No environment variable is involved: the bytes depend only on the commit + the
  feature, which is what makes the build reproducible by anyone.
- Services and the app take the id from env (`FUMPAD_PROGRAM_ID`/`FUMPAD_CLUSTER`, `NEXT_PUBLIC_FUMPAD_*`, §1.13/§1.14).

**Launch-day sequence** (commands in §1.11 / §2):
1. `$B --step keys` generates `fumpad-program-keypair.json` (back it up offline).
2. Commit its **pubkey** into `contracts/program-ids/mainnet.txt` (the keypair never enters git), tag, push. `REL` =
   that commit. The release commit = the one the services/app are built from too.
3. Verifiable build of `REL`: `cd contracts && solana-verify build --library-name fumpad --base-image <IMAGE> --
   --features mainnet` (args after `--` go to cargo). `solana-verify get-executable-hash target/deploy/fumpad.so` = H.
4. Compare: `npm run mainnet:build-program -- --program-keypair $K/fumpad-program-keypair.json` (local, non-docker,
   same feature) prints its executable hash H′. `$B --step program` prints the sha256 of what it deploys.
5. Deploy that .so (`$B --step program … --so contracts/target/deploy/fumpad.so`), then
   `solana-verify get-program-hash -u <rpc> $FUMPAD_PROGRAM_ID` must print H.
6. Verify against the repo and publish (day 0, **while the deployer is still the upgrade authority**: the
   verification PDA is signed by the upgrade authority):
   ```sh
   RPC="$(sed -n 's/^RPC_URL=//p' $K/rpc.env)"
   solana-verify verify-from-repo -u "$RPC" --program-id $FUMPAD_PROGRAM_ID https://github.com/<org>/fumpad \
     --commit-hash $REL --library-name fumpad --mount-path contracts --base-image <IMAGE> \
     -k $K/deployer.json -- --features mainnet        # rebuilds in docker, compares with the chain, asks to upload the PDA: yes
   solana-verify remote submit-job --program-id $FUMPAD_PROGRAM_ID --uploader $(solana-keygen pubkey $K/deployer.json)
   solana-verify remote get-job-status --job-id <id from the previous command>   # OtterSec API → verified
   ```
   The repo must be public at `REL` for OtterSec / explorers to rebuild it (otherwise keep steps 3–5 as the record
   and publish H + `REL`). Later upgrades (upgrade authority = admin vault): build the new commit the same way and
   `solana-verify export-pda-tx … --uploader <admin vault>` → a Squads proposal next to the upgrade (MULTISIG.md).

**Status of this procedure (2026-10-13).** Tested here: the default `anchor build` (devnet id, 0 warnings, 754,288 B,
contracts suite green) and the non-docker mainnet path (`build-program.ts`, `cargo build-sbf --features mainnet`,
platform-tools v1.57, sbpf v3) with a stand-in id: the .so embeds the stand-in and not the devnet id; the build
refuses `UNSET`, a malformed key and the devnet id. **UNVERIFIED: the docker steps** (3, 5's hash equality, 6) —
docker and solana-verify are not installed on the build machine. Before T−3 d, on a machine with docker, rehearse
steps 3–4 on a throwaway branch with a stand-in id in `mainnet.txt` and choose `<IMAGE>` (a
`solanafoundation/solana-verifiable-build:<agave version>` tag) such that H = H′. Watch: our builds use platform-tools
v1.57 + `--arch v3` (Anchor 1.2.1 defaults, CONTRACTS.md "Build profile"); an image whose `cargo build-sbf` defaults
differ produces different bytes (use a solana-verify release that accepts `--arch v3` if needed, or
`anchor build --verifiable -- --features mainnet`, which runs Anchor's image with Anchor's own flags, and compare
again). `contracts/.cargo/config.toml` (inliner flags) is inside the mount, so docker builds read it too.
