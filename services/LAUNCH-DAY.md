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
| T−7 d … T−1 d | providers, keys, multisigs, build, rehearsal, Railway mainnet project (services stopped) | no |
| **Day 0, morning (H0)** | deploy program → DBC configs (standard + first-coin) → `initialize_global` → fund keepers → `propose_admin` | program id + Global params/cluster_tag: yes |
| H0 … H0 + 6 h | 6 h: voters approve `accept_admin` in Squads (right away — the Squads 6 h lock starts at the 2nd approval); services run against mainnet with the app still gated | no (guardian = deployer can `cancel_admin`) |
| **≥ H0 + 6 h (same day)** | execute `accept_admin` (admin/guardian → vaults) → upgrade authority → admin vault → guardian drill | **yes** |
| **T0 (same evening or next morning)** | pre-flight re-check → first coin on the first-coin config (app still gated) → set the mint: fumpad.app's page goes live (coin + checker) → remove that config → open the app (gate off) | the first coin's 3% fee + routing: yes (snapshotted) |

(Was a 3-day schedule with the 48 h timelocks; since SPEC v0.7 clarification 29 the handover is 6 h on chain and the
recommended Squads time lock is 6 h, so day 0 fits in one working day if 2 of the 3 members approve within ~an hour of
`propose_admin`.)

Opening the app only after the handover means no hot key holds admin power while users have money in.

## 1. Pre-flight (T−7 d … T−1 d)

1. **Release commit.** Tag it. Gates on that commit: `npm run typecheck`, `npm test`, `npm run local` (20/20),
   `npm run multisig:rehearsal`, `npm run mainnet:rehearsal` (must end `✓ mainnet rehearsal passed`).
2. **Meteora / Squads / Token-2022 / Pyth programs = what we tested.** Re-dump mainnet read-only and compare with
   `scripts/mainnet/tested-programs.json` (written by the last passing rehearsal; DBC 0.2.2 `e2bfc853…`, DAMM v2
   0.2.5 `967ff9fb…` since the 2026-10-16 Meteora upgrade, was 0.2.1 `4c26a8a5…` / 0.2.4 `4d5b920b…`; Squads v4 `dec8d3e0…` + their upgrade authorities and the DAMM v2 migration config):
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
4. **SOL/USD (Pyth, free)**: attestors + watcher run `PYTH_SOURCE=onchain` (the default with `NODE_ENV=production`):
   the price comes from Pyth's sponsored SOL/USD push account on mainnet via each one's own `RPC_URL` (no key, $0;
   `PYTH_RPC_URL` only if the price should come from another mainnet endpoint). Nothing to buy. Check one provider
   reads it: `FUMPAD_RPC_ENV_FILE=$K/rpc-b.env npx tsx engine/scripts/record-pyth-onchain.ts 600 8` must end with
   `determinism: N/N identical across providers` (it compares with the public RPC; it rewrites the test fixture, so
   `git checkout engine/test/fixtures/pyth-onchain.mainnet.json.gz` afterwards). All three attestors and the watcher
   must use the same source (`hermes` remains an option with a paid key in `$K/pyth.env`, DEPLOY-v07.md §9).
5. **Telegram**: `$K/telegram.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) — the **same bot and chat as devnet**
   (a DM to the user); check `getMe` → `"ok":true` (DEPLOY-v07.md §9). Every message from the keeper, attestors and
   watcher starts with the cluster tag from `FUMPAD_CLUSTER` — `[MAINNET]` here, `[DEVNET]` from the devnet stack —
   so set `FUMPAD_CLUSTER=mainnet` on every mainnet service (it is required anyway) and tell them apart by the tag.
   Optional `TELEGRAM_PREFIX` replaces the tag with a custom label (e.g. `[MAINNET-canary]`).
6. **Governance parties** (MULTISIG.md §2–3; decision 2026-10-16): the same 3 member wallets (normal wallets,
   MULTISIG.md "Hot-wallet hygiene") in admin (2-of-3, 6 h Squads time lock) and guardian (2-of-3, no time lock)
   + the ops key (`$K/ops.json`, initiate + execute only). Create both multisigs
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
    #    = cd contracts && solana-verify build --library-name fumpad \
    #        --base-image solanafoundation/solana-verifiable-build:4.3.0 --arch v3 -- --features mainnet
    #    ~17 min on Apple Silicon (amd64 emulation), a few min on x86_64 Linux
    cd ~/fumpad && scripts/verify-build.sh --mainnet                          # prints "HASH: <H>" (record it)
    # c) cross-check with the local, non-docker path (same feature, platform-tools v1.57, sbpf v3)
    cd ~/fumpad/services && npm run mainnet:build-program -- --program-keypair $K/fumpad-program-keypair.json
    #    → "program-ids/mainnet.txt (committed) = <id>: this is the release build's input" + "executable hash H'"
    ```
    Deploy the docker-built `contracts/target/deploy/fumpad.so` (`--so` in §2), never the local one. H ≠ H' is
    **expected** (§10 "Rehearsal": the docker build embeds `/home/runner/...` panic paths, the macOS one
    `/Users/runner/...`); H is the hash of record, H' only confirms the id/feature plumbing. `$B --step program` on mainnet refuses unless
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
    | `api` | `RPC_URL` = A, `LAUNCH_SIGNER_KEY` = `npx tsx …` pipe of `$K/launch-signer.json`, `LAUNCH_REQUIRE_SIGNATURE=true`, new `MINT_POOL_KEY` (`openssl rand -hex 32`, also on the grinder), new `API_SSR_SECRET` (also on Vercel), `CORS_ORIGINS=https://fumpad.app,https://www.fumpad.app`, `TRUST_PROXY_HOPS=2`, **`LAUNCHES_OPEN=false`** (the mainnet default, set it explicitly: no standard launch before T0, even through `fumpad.vercel.app` — every launch needs the API's co-signature; the first coin's `LAUNCH_FIRST_COIN` path isn't affected), **`WAITLIST_DATABASE_URL`** = the existing devnet project's `waitlist-db` public URL (same DB: the list survives) and **the same `WAITLIST_IP_SALT`** (`~/fumpad-keys/waitlist/ip_salt`) |
    | `grinder` | `DATABASE_URL`, `MINT_POOL_KEY`, `POOL_TARGET` (≥ 20 before T0) |
    | `keeper` (core) | `KEEPER_MODE=jobs`, `KEEPER_SECRET_KEY` = **operator** (`$K/operator.json`; refuses an attestor key), `RPC_URL` = A, `KEEPER_DAILY_BUDGET_SOL=2`, `MIN_KEEPER_LAMPORTS=500000000`, `TELEGRAM_*` (mainnet) |
    | `attestor-1/2/3` (own projects) | `KEEPER_MODE=attestor`, own key (refuses the operator key), own DB role (`secrets-v07.ts db-sql` adapted to `$K`; `db-url attestor-N --public <board TCP proxy>` from its project), `RPC_URL` = B / C / D, `PYTH_SOURCE=onchain` (no key; price read via the same `RPC_URL`), `ATTEST_BOARD_REQUIRE_RLS=1`, `TELEGRAM_*` |
    | `watcher` | `KEEPER_MODE=watcher`, `RPC_URL` = E, `PYTH_SOURCE=onchain`, `TELEGRAM_*` (guardians' chat) |
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
    and `NEXT_PUBLIC_CHECKER_MINT` unset (fumpad.app = the launch page, "The first coin launches soon.") until T0. Preview deployment first; check CSP (app/LAUNCH.md).
15. **Verified program on explorers** (OtterSec / solana-verify, §10 step 6): needs a **PUBLIC GitHub repo** containing
    the release commit `REL` (mount path `contracts`), so `solana-verify verify-from-repo` can rebuild it and the
    remote job (`solana-verify remote submit-job`) can publish the "verified" badge. Create/publish the repo before
    day 0; the verification itself is done **on day 0, right after `--step program`, while the deployer is still the
    upgrade authority** (the verification PDA is signed by the upgrade authority; after the handover it needs a
    Squads proposal). ☐ public repo at `REL` ☐ `verify-from-repo` matches the chain ☐ remote job → verified.

## 2. Day 0 morning (H0): program, config, Global, keepers, propose_admin

Each `--send` prints a summary and asks you to type the phrase it shows (e.g. `program 7xKX9a`).
```sh
$B --step verify                                     # pre-check: everything missing is listed, nothing ✗ besides that
$B --step program       $SPEND --so ~/fumpad/contracts/target/deploy/fumpad.so   # the §1.11 docker build (≈ 760 write txs; resumable, see §8)
solana-verify get-program-hash -u "$(sed -n 's/^RPC_URL=//p' $K/rpc.env)" $FUMPAD_PROGRAM_ID   # must = H (§1.11); then §10 (verify + OtterSec) today, while the deployer is upgrade authority
$B --step config        $SPEND                       # DBC create_config ×2: standard + first-coin (vector bytes `mainnet` / `first_coin_mainnet` checked first)
$B --step init          $SPEND                       # initialize_global: IRREVERSIBLE params/cluster_tag/keepers + both configs with their fee
                                                     # policies (first coin: 1.0% buyback / 1.4% → firstCoin.feeWallet, max 1) — read the summary
$B --step fund          $SPEND                       # operator 2 SOL, attestor-1/2/3 0.3 SOL
$B --step propose-admin $SPEND                       # admin → admin vault, guardian → guardian vault (6 h)
$B --step verify                                     # all ✓; "next: after <eta> … accept-admin"
$B --step accept-admin  $SPEND                       # ops key creates the accept_admin vault tx (no approval)
$M show-tx $C --config $K/multisig/admin.json --index <N>   # voters check: accept_admin, signer = admin vault
```
Then deploy the Railway services in DEPLOY-v07.md §4 order (indexer → api → keeper → board roles → attestors →
watcher). Check: API `/v1/status`, attestor logs "3 active keepers", board RLS on, watcher `/v1/verification` empty,
keeper heartbeat in Telegram. The app stays gated; the team can test on `fumpad.vercel.app` (a small real coin —
remember it costs real SOL and is permanent).

## 3. H0 … H0 + 6 h: approvals

2 of the 3 admin members approve tx `N` in the Squads app (member wallets). The Squads 6 h time lock starts at the 2nd
approval, so approve right after `propose_admin` (the FUMPAD eta is H0 + 6 h; both must pass). `$B --step verify` / `$B --step accept-admin` (plan) show approvals and when it can
execute. Any doubt → the guardian (still the deployer) cancels: `npx tsx scripts/ops/multisig.ts` is not needed,
the deployer signs `cancel_admin` directly (rehearsed in MULTISIG.md §6).

## 4. Day 0, ≥ H0 + 6 h: handover

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
2. fumpad.app stays the pre-launch page ("The first coin launches soon.", `NEXT_PUBLIC_PRELAUNCH` and
   `NEXT_PUBLIC_CHECKER_MINT` unset) while the first coin launches; the app is reachable on
   `https://fumpad.vercel.app` (never gated), but with the api's `LAUNCHES_OPEN=false` its `/launch` shows
   "Launches open soon." and `POST /v1/launch/prepare` refuses standard launches (403 `launches_closed`); check:
   `curl -s https://<api>/v1/launch/options` → `"launchesOpen":false`. The API runs the build with
   `GET /v1/wallets/:wallet/fumbles` (the checker).
3. **First coin, on the one-off first-coin config** (user decision 2026-10-14; SPEC Clarification 30): 3% fee
   (99% → 3% over ~10 s, 3% after graduation too), of FUMPAD's 2.4%: 1.0% → its reward pool, 1.4% + FUMPAD's whole
   launch-window share → `firstCoin.feeWallet` (`7eXG…jFa3`); no platform / creator share.
   1. Before: `$B --step verify` shows the first-coin config allow-listed (`coins 0/1`, wallet = the config file's).
      The fee wallet holds ≥ 0.001 SOL (claims refuse to leave it below rent exemption — `FeeWalletNotRentExempt`).
   2. API: Railway `api` variable `LAUNCH_FIRST_COIN=true` (leave `LAUNCHES_OPEN=false`: the first-coin path works
      while standard launches are closed), redeploy; `curl -s https://<api>/v1/launch/options` shows
      `"launchesOpen":false` and `firstCoin` with that config and wallet.
   3. Launch through the app at `https://fumpad.vercel.app/launch?config=first-coin` (Privy wallet, first buy below;
      fumpad.app is still gated). The
      review must show **Trading fee 3%, first-coin config** and the wallet; the app refuses to sign unless the chain
      lists that config with the wallet-split policy and its fee is 3%.

      **First coin details** (user, 2026-10-16):
      | field | value |
      |---|---|
      | name | `Fumble Pad` |
      | ticker | `FMBL` |
      | image | `marketing/brand/logo/png/fumpad-mark-on-dark-1024.png` (copy: `~/Desktop/FUMPAD-X-assets/first-coin/FUMPAD-logo-1024.png`) |
      | description | FUMPAD's own coin. Fumble Pad pays you for selling too early: sell $50+ of a FUMPAD coin on any app and you get a Fumble Ticket. If the coin graduates and holds 10× your sell price, you can claim back 10% of what you sold. |
      | creator wallet | `EiwHzSkty4mD1463dvbr7o1fHMNaA8xQPgk4PyXpnVGc` — must be the wallet **logged into the app** when launching; needs ≥ ~1.05 SOL (first buy + launch fees/rent) |
      | first buy | 1 SOL |
   4. Check in order: Solscan tx (DBC init on the first-coin config + swap + `register_coin`, launch-signer
      co-signed), the Coin account is 593 bytes (policy tail), API coin page shows 3% and the wallet split, WS feed,
      trades indexed; after ~10 s the keeper's first `claim_fees` pays the launch window to the wallet (`FeesClaimed`
      `to_wallet = claimed`); later claims split 1.0 / 1.4; a matured ≥ $50 sell → `TicketAttested` by 2 of 3, watcher
      `match`.
   5. **Right after it (same hour)**: Railway `api` `LAUNCH_FIRST_COIN=false`, redeploy (the API stops offering it;
      `max_coins = 1` already makes the program refuse a second coin, even with the launch co-signature). Then take the
      config off the allow-list: `$B --step remove-first-coin-config $SPEND` — the admin is the admin vault by now, so
      it creates the vault tx `queue_config(<first-coin config>, remove)` with the ops key (or
      `$M propose $C --config $K/multisig/admin.json --member-key $K/ops.json --action remove-config --config <first-coin config> --yes`);
      voters approve in the Squads app; execute it (`$M execute … --index <N> --yes`); after the config timelock
      (`CONFIG_TIMELOCK_SECS`) rerun `$B --step remove-first-coin-config $SPEND` → `execute_config` (permissionless).
      `$B --step verify`: "first-coin config … not allow-listed (removed)". The first coin keeps its 3% routing (its
      snapshot is in its own account).
   6. **Coin live on fumpad.app (app/LAUNCH.md "the 3-step flip", step 2), right after the coin registers** (its
      `https://fumpad.vercel.app/coin/<mint>` page loads): Vercel Production `NEXT_PUBLIC_CHECKER_MINT=<mint>`, optionally
      `NEXT_PUBLIC_APP_OPENS_AT=<ISO>` (leave `NEXT_PUBLIC_PRELAUNCH` unset) → redeploy. The same page at fumpad.app now
      shows the first coin live + the Fumble Checker (read-only; nothing to sign). Check `https://fumpad.app/?wallet=<first seller>`: its sells,
      "Verifying" then "6-hour check" with the countdown once `TicketAttested` lands, and the claim target.
4. **Open the app** (~30–60 min after the coin went live, step 3 of the flip), both at the same time:
   - Railway `api` variable `LAUNCHES_OPEN=true` → redeploy → `curl -s https://<api>/v1/launch/options` shows
     `"launchesOpen":true` (standard launches open; until then `/launch` says "Launches open soon.").
   - Vercel Production `NEXT_PUBLIC_PRELAUNCH=off` → redeploy → `curl -sI https://fumpad.app/launches` = `200`.

   The checker stays in the app at `/checker`.
5. Re-run `rpc-check … --l8-slot <first coin's launch slot>`.
6. Announce.

## 6. Monitoring (first 72 h, then daily)

- Telegram (only `[MAINNET]` messages are this deployment; `[DEVNET]` ones come from the devnet stack): keeper
  heartbeat (every 8 min), low balance (`MIN_KEEPER_LAMPORTS`), daily budget, attestor disagreements, watcher
  mismatches. Watcher `/v1/verification`: any `mismatch` = page the guardians.
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
- App: `NEXT_PUBLIC_PRELAUNCH` back on (unset) + redeploy hides the app behind the launch page (the read-only first-coin page while `NEXT_PUBLIC_CHECKER_MINT` is set; the chain keeps running).
- Stop new launches only, without touching trading (no multisig, ~1 min): Railway `api` `LAUNCHES_OPEN=false` →
  redeploy. The API refuses standard launches (403 `launches_closed`, `/launch` shows "Launches open soon.") and, since
  every launch needs its co-signature, no launch lands on chain either; buys, sells, tickets and claims keep working.
  Back: `LAUNCHES_OPEN=true` + redeploy. (On chain the same is `PAUSE_LAUNCH`, `--bits 1`, through the guardians.)
- Keeper/attestor misbehaving: stop the Railway service (attestations need 2 of 3; one down is fine). A compromised
  attestor key: guardian `PAUSE_ATTEST`, admin `set_keepers` (6 h Squads lock, then the 6 h freeze for the new key).
  A compromised operator (jobs) key: stop the `keeper` service; it can't attest — at worst it times samples / pre-grad
  buybacks within the guards; admin `set_operators` to a fresh key (6 h Squads lock, no freeze), then redeploy the
  keeper with it. A pause isn't needed for an operator compromise (`PAUSE_TRADE` stops pre-grad buybacks if wanted).
- Unpause: `--bits 0` the same way.

## 8. Rollback / recovery

- **Before `initialize_global`**: nothing user-facing exists. A bad deploy: the deployer is still upgrade authority —
  `solana program deploy --program-id <id> <fixed.so>` (upgrade) or close the program (`solana program close`,
  recovers ≈ 3.8 SOL, the id can never be reused).
- **Interrupted deploy**: `solana program show --buffers` → resume with `solana program deploy --buffer <B> …` or
  `solana program close <B>` to recover the buffer rent.
- **After `initialize_global`, before the handover**: params can only change via `queue_params` (1 h);
  keepers via `set_keepers` (immediate, 6 h freeze per new key), operators via `set_operators` (immediate); a wrong `propose_admin` → `cancel_admin` by the
  guardian (= deployer). A wrong Global (cluster_tag/params) can't be re-initialized: redeploy under a new program id.
- **After the handover**: every fix is a Squads proposal — program upgrade (MULTISIG.md "Program upgrades
  afterwards": buffer → hash check by every approver → 3 approvals → 6 h → execute), params (6 h Squads + 1 h
  FUMPAD), config allow-list (same), authority changes (6 h Squads + 6 h FUMPAD). Emergencies are the guardian's pause (§7).
- **Services**: Railway "Redeploy" of the previous deployment; DB restore from Railway backups; the chain is the
  source of truth (the indexer re-derives from `BACKFILL_FROM_SLOT`).

## 9. Rehearsal (what was proven locally)

`npm run mainnet:rehearsal` (≈ 16 min; `scripts/mainnet/rehearsal.ts`). **Result 2026-10-14 (1 h / 6 h timelocks, 6 h Squads
lock): 37/37 ✓ in 854 s** (2026-10-13 with 48 h: 37/37; mainnet read at slot 456,668,770 with 23 read-only requests; DBC, DAMM v2 and Squads v4 on mainnet = the fixtures every test
suite runs; manifest committed as `scripts/mainnet/tested-programs.json`). Other stacks on the machine: set
`FUMPAD_RPC_PORT`, `FUMPAD_API_PORT`, `FUMPAD_GOSSIP_PORT`, `FUMPAD_PG_PORT`. It reads mainnet only through `get*` calls (spaced, rate-limit aware), builds a validator with the
exact mainnet DBC / DAMM v2 / Squads v4 / Token-2022 / Pyth-receiver bytes, the DAMM v2 migration config, Squads
ProgramConfig, the DBC/DAMM pool authorities' real balances and mainnet's feature-gate set; deploys fumpad with the
same `solana program deploy` call; runs every bootstrap step through the library and the CLI (incl. the refusals
and a typed confirmation); runs the full service stack on mainnet params (600 s hold, $50 minimum, 85 SOL curve);
and completes the handover with a clock warp past 6 h. Differences from mainnet that remain: the local rent rate is
~37% higher than mainnet's (costs measured locally are upper bounds), prices are frozen at the dump's Pyth value,
the smoke runs inside the 6 h window (the warp puts the chain ~6 h ahead of the services' clocks), and the Squads
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
  test in `lib.rs` and `test/ops/mainnet.test.ts` keep them equal). Devnet/local builds are unchanged by the feature.
- `contracts/program-ids/mainnet.txt` = `UNSET` until launch day. Cargo feature `mainnet` (`programs/fumpad/build.rs`)
  reads it and compiles in `declare_id!("<it>")` instead; the build **fails** while it is `UNSET`, not a 32-byte
  base58 key, or the devnet id. No environment variable is involved: the bytes depend only on the commit + the
  feature, which is what makes the build reproducible by anyone.
- Services and the app take the id from env (`FUMPAD_PROGRAM_ID`/`FUMPAD_CLUSTER`, `NEXT_PUBLIC_FUMPAD_*`, §1.13/§1.14).

**Launch-day sequence** (commands in §1.11 / §2):
1. `$B --step keys` generates `fumpad-program-keypair.json` (back it up offline).
2. Commit its **pubkey** into `contracts/program-ids/mainnet.txt` (the keypair never enters git), tag, push. `REL` =
   that commit. The release commit = the one the services/app are built from too.
3. Verifiable build of `REL` (clean checkout of the tag; `IMAGE=solanafoundation/solana-verifiable-build:4.3.0`):
   `scripts/verify-build.sh --mainnet` = `cd contracts && solana-verify build --library-name fumpad --base-image
   $IMAGE --arch v3 -- --features mainnet` (args after `--` go to cargo), then prints size, sha256 and
   `solana-verify get-executable-hash target/deploy/fumpad.so` = **H**. Record H + `REL`.
4. Cross-check (optional): `npm run mainnet:build-program -- --program-keypair $K/fumpad-program-keypair.json` (local,
   non-docker, same feature) prints H′. **H′ ≠ H is expected** (see "Rehearsal" below): H′ only confirms that the id
   was compiled in; the docker bytes (H) are what gets deployed and verified. `$B --step program` prints the sha256
   of what it deploys (= the docker .so's sha256).
5. Deploy the docker-built .so (`$B --step program … --so contracts/target/deploy/fumpad.so`; copy it somewhere
   safe first, a later `anchor build` overwrites it), then `solana-verify get-program-hash -u <rpc>
   $FUMPAD_PROGRAM_ID` must print H (or rebuild and compare in one go: `scripts/verify-build.sh --mainnet
   --program-id $FUMPAD_PROGRAM_ID -u <rpc>`, exit 3 on mismatch).
6. Verify against the repo and publish (day 0, **while the deployer is still the upgrade authority**: the
   verification PDA is signed by the upgrade authority):
   ```sh
   RPC="$(sed -n 's/^RPC_URL=//p' $K/rpc.env)"
   solana-verify verify-from-repo -u "$RPC" --program-id $FUMPAD_PROGRAM_ID https://github.com/<org>/fumpad \
     --commit-hash $REL --library-name fumpad --mount-path contracts --base-image $IMAGE --arch v3 \
     -k $K/deployer.json -- --features mainnet        # rebuilds in docker, compares with the chain, asks to upload the PDA: yes
   solana-verify remote submit-job --program-id $FUMPAD_PROGRAM_ID --uploader $(solana-keygen pubkey $K/deployer.json)
   solana-verify remote get-job-status --job-id <id from the previous command>   # OtterSec API → verified
   ```
   The repo must be public at `REL` for OtterSec / explorers to rebuild it (otherwise keep steps 3–5 as the record
   and publish H + `REL`). Later upgrades (upgrade authority = admin vault): build the new commit the same way and
   `solana-verify export-pda-tx … --uploader <admin vault>` → a Squads proposal next to the upgrade (MULTISIG.md).

**Rehearsal (2026-10-13 — before the 2026-10-14 timelock change, which changes the bytes, so re-run steps 3–5 for
the release commit; Apple M1, colima vz + qemu-user amd64 emulation, solana-verify 0.5.2, commit = main after
the pre-audit hardening).** Steps 3–5 rehearsed read-only (no deploy, no transaction):

| Build | Command | Size | Executable hash |
|---|---|---|---|
| docker, devnet id | `scripts/verify-build.sh` (image 4.3.0) | 806,584 | `f1e6a0d05294dec0bc6830353522be319112c6921d4114bbf5803e053e3f94fb` |
| docker, devnet id | same, image 4.1.2 + `--cargo-build-sbf-args="--tools-version v1.57"` | 806,584 | `f1e6a0d0…94fb` (identical) |
| docker, stand-in id `CKGq…9VfC` | `--features mainnet`, throwaway copy of `contracts/` outside the repo tree | 806,472 | `f95aec7e0075423bd4fcc8264f89c8ed3d22a7ef22a9cca33594fe887fde3d6e` |
| local macOS, devnet id | `anchor build` / `cargo build-sbf --tools-version v1.57 --arch v3` | 805,648 | `7a5f424eee50be32928d2fa29ff460bac195537dcb1788e06587536957e47c37` |
| deployed devnet `5YMF…S9Fb` | `solana-verify get-program-hash -u devnet` | | `7a5f424e…7c37` (= the local build) |

- **Works.** The docker build reproduces across images (4.3.0 and 4.1.2 + v1.57: same bytes); `get-executable-hash`
  of the output = the hash solana-verify prints. The mainnet feature build embeds the stand-in id and not the devnet
  id. The full LiteSVM suite (`cargo test -p tests`, 94 passed / 1 ignored) passes against the docker-built devnet .so.
- **H ≠ H′ (docker vs local macOS) is structural, not a misconfiguration:** `.rodata` is byte-identical in size,
  `.text` is +936 B in docker (same delta before the hardening merge), and the precompiled std embeds
  `/home/runner/…` vs `/Users/runner/…` paths: the Linux-x86_64 and macOS-arm64 platform-tools v1.57 builds generate
  slightly different code. A Mac can never reproduce the docker hash natively, so **only the docker .so is deployed**
  and H′ (step 4) is just a sanity check of the id plumbing.
- **Image:** `solanafoundation/solana-verifiable-build:4.3.0` (platform-tools v1.57 baked in, so no download in the
  container; amd64 only). Always pass `--arch v3` (solana-verify defaults to v0). The 4.1.x images default to v1.54.
- **Duration:** cold (empty `contracts/target`) ~17 min on the M1 under emulation; warm (deps cached in
  `contracts/target`, only fumpad recompiled) ~1.5 min. Pre-pull the image (~40 s). On x86_64 Linux: a few minutes.
- **Pitfalls found:** (1) qemu-user can deadlock (a forked `cargo` child that never execs, 0% CPU forever; 2 of 6
  runs here): if the log stops at `Compiling fumpad` with an idle container for > 5 min, stop it and rerun, or enable
  Rosetta (`colima stop && colima start --vm-type vz --vz-rosetta`) / build on x86_64. (2) solana-verify builds the
  first crate named `fumpad` anywhere under the mount, `target/` included: never keep copies of the program under
  `contracts/` (`scripts/verify-build.sh` refuses). (3) The build writes `contracts/target/deploy/fumpad.so`, the same
  path as `anchor build`: copy the docker .so aside before running anything else.
- **Devnet:** the deployed devnet program is the local macOS build (`7a5f…`), so it cannot be verified with
  solana-verify. Recommended: redeploy devnet from the docker .so (`f1e6…`, fits the current 810,280 B ProgramData)
  so devnet = verifiable bytes and launch day uses the same artefact path; not done here (no deploys).
- Still UNVERIFIED: step 6 (`verify-from-repo` + OtterSec remote job) needs the public repo and a deployed docker
  build.
