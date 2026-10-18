# FUMPAD governance on Squads v4 multisigs (admin + guardian + upgrade authority)

Tools: `scripts/ops/multisig.ts` (CLI + library, `@sqds/multisig` 2.1.4 = latest), rehearsal
`npm run multisig:rehearsal` (local validator, see §6). Nothing here has touched devnet or mainnet: the live devnet
Global is unchanged. Every write simulates first and only sends with `--yes`; `--cluster` must match the RPC's genesis
(a wrong env file can't hit the wrong cluster); RPC URLs are read from env files and never printed.

## 0. Single-wallet admin (user decision 2026-10-18)

**For the mainnet launch the admin and the guardian are ONE fresh wallet held only in the user's wallet app**
(Phantom / Solflare / Backpack), not the Squads multisigs below. The program upgrade authority follows the admin (no
`upgradeAuthority` in `bootstrap.json`). The rest of this file stays as the documented alternative (e.g. moving to
Squads later: `propose_admin` to the vaults, signed by the wallet through the page with `--action ix-json`).

- **The wallet**: newly created in the wallet app (own recovery phrase, offline backup), used for nothing but FUMPAD
  admin; its key never touches the ops machine. `bootstrap.json`: `admin` and `guardian` both
  `{ "kind": "hardware", "address": "<ADMIN_WALLET>" }` (the same address is accepted only when both are `hardware`).
- **Fees**: the wallet pays its own transactions: keep **~0.02 SOL** on it (each action ≈ 0.00001 SOL).
- **How it signs**: `scripts/mainnet/admin-sign.ts` prepares one action as a proposal file (no secrets; refused with
  the reason if its simulation with the wallet as signer fails, e.g. the 6 h eta not reached), then
  `scripts/mainnet/admin-sign-server.ts` serves a local page on `127.0.0.1` where the wallet connects (any other
  address is refused) and signs; a fresh blockhash is taken at the click, the page simulates, the wallet asks for
  approval, the page sends through a proxy that forwards only six read/send RPC methods and only that signed
  transaction, and shows the signature until finalized. Actions: `accept-admin`, `set-pause` (`--bits 0` = the
  harmless drill), `queue-config-remove` (the first-coin config; `execute_config` is permissionless and run by
  `bootstrap --step remove-first-coin-config`), `cancel-admin`, and `ix-json` (any instruction the wallet alone signs).
- **Upgrade authority**: `bootstrap --step upgrade-authority` with `kind: "hardware"` needs **no signature from the
  wallet**: the deployer signs BPF loader `SetAuthority` (tag 4, the unchecked variant: keys = program data
  (writable), current authority (signer), new authority (read-only), `scripts/ops/multisig.ts setUpgradeAuthorityIx`),
  refused until `Global.admin` is the wallet; the target must be on-curve (`partyProblems`).
- **Flow + exact commands**: LAUNCH-DAY.md §4a. Day 0 is shorter (no approvals to collect): `propose_admin` by the
  deployer → 6 h → `accept-admin` on the page → upgrade authority by the deployer → drill on the page.
- **Trade-off**: one key holds every power (immediate `set_keepers` / `set_operators`, 1 h params and configs,
  program upgrades) — the multisig recommendations in §2 are what this gives up.

## 1. What moves where

| power (INTERFACE-v0.7) | today | after the handover |
|---|---|---|
| **admin**: `queue_params`/`execute_params` (1 h), `queue_config`/`execute_config` (1 h), `set_keepers` (immediate), `set_operators` (immediate), `propose_admin` (6 h), everything guardian can do | deployer key | **admin multisig vault** (2-of-3, 6 h Squads time lock) |
| **guardian**: `set_pause` (immediate, lapses after 7 d), `cancel_params`, `cancel_config`, `cancel_admin`, `void_ticket` | deployer key | **guardian multisig vault** (2-of-3, no time lock) |
| **program upgrade authority** (BPF loader) | deployer key | **admin multisig vault** |
| `platform_treasury` | unchanged unless you pass `--treasury` | |

The two-step handover is FUMPAD's own: `propose_admin(new_admin, treasury, guardian)` by the current admin, 6 h,
then `accept_admin` signed by `new_admin`. Here `new_admin` is a Squads **vault PDA**, so `accept_admin` is executed
*through* the admin multisig (vault transaction → proposal → threshold approvals → time lock → execute; Squads signs
for the vault by CPI). The guardian can `cancel_admin` during the 6 h.
(On-chain timelocks per SPEC v0.7 clarification 29, user decision 2026-10-14: 1 h routine, 6 h authority; were 48 h.)

Squads v4: program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, verified 2026-10-13 on mainnet with
`solana program show`: **Authority: none** (immutable), last deployed slot 302582236; the SDK's `PROGRAM_ID` is
checked against it at load. The rehearsal runs the exact mainnet bytecode (dumped read-only, sha256
`dec8d3e0…a01d34c`, `contracts/tests/fixtures/squads_v4_mainnet.so`) and its mainnet `ProgramConfig` (creation fee 0).

## 2. Recommendations

**Governance decision (user, 2026-10-16): 3 members — the same 3 wallets in both multisigs, normal (non-hardware)
wallets:**
`GMtPrH3fhyVPFh5hEHsBhfS6W2hQdcQtv2xLfsDBhTgn`, `CrJD8AptfHPEnqfu2FnBmiPLcdaVxB53UuLFDH7oQQNk`,
`6K3ybxa3Gtbe3cZ5bKayteX35NVxEqtd3PzFxjKVgjBx`. Admin **2-of-3 with a 6 h Squads time lock**; guardian **2-of-3, no
time lock**. Config files: `~/fumpad-keys/mainnet/multisig/admin.json` / `guardian.json` (§3). Hardware wallets were
the original recommendation; the user chose software wallets, so the hygiene rules below are mandatory, not optional.

**Admin multisig: 2-of-3 voters, Squads time lock 6 h (21,600 s), no config authority.** (Was ≥ 48 h; lowered with
the on-chain timelocks, clarification 29. `multisig.ts` warns below 6 h: `ADMIN_TIMELOCK_SECS`.)
- 3 voters = 3 dedicated member wallets (see "Hot-wallet hygiene"), ideally held by **different people in different
  places**; nobody holds 2. Each voter has all permissions (initiate / vote / execute). One lost key still leaves
  the multisig working (2 of the remaining 2); replace it at once (§5).
- Optional **ops key** (hot, on the ops laptop): permissions `initiate` + `execute` only, **no vote**. It can create
  proposals and press "execute" after the threshold + time lock, but can never approve: losing it is harmless.
  This is what lets our CLI drive the flow while every approval happens in a member wallet in the Squads app.
  It must be in the members list **at creation** (adding it later is a config transaction: vote + 6 h).
- **6 h time lock** covers program upgrades (otherwise instant) and every admin action: users get 6 h to see an
  approved upgrade before it can land, and ≥ 7 h (6 h Squads + 1 h on chain) for a param / config change, ≥ 12 h for
  an authority change. Trade-off: admin's immediate tools (`set_keepers`, `set_operators`, `void_ticket`) also wait
  6 h; the guardian (no lock) covers incidents meanwhile (`set_pause` incl. `PAUSE_ATTEST`, `void_ticket`). An
  upgrade can't be cancelled by the FUMPAD guardian — only rejected / left unexecuted in Squads — so the 6 h is the
  whole review window for it. Alternative if that's wrong for you: a third multisig with the same members holding
  only the upgrade authority (longer lock) and the admin multisig at 0 (FUMPAD timelocks params/configs 1 h and
  admin 6 h on chain). Not built; say so if you want it.
- **Alerts are essential with these windows**: the watcher (`KEEPER_MODE=watcher`, `TELEGRAM_BOT_TOKEN` +
  `TELEGRAM_CHAT_ID` = the guardians' chat) alerts on every pending params / config / admin change (eta, diff),
  re-sent every 30 min until executed or cancelled. Guardian signers must be reachable within the hour.
- `configAuthority: null` (autonomous): adding/removing members, the threshold and the time lock themselves need a
  vote **and** the time lock. Our `create` always sets this.

**Guardian multisig: 2-of-3, time lock 0.** The same three member wallets as the admin multisig (decision above;
the earlier advice to keep one guardian who is not an admin voter is waived), reachable fast — ideally in
different time zones: a pause should take minutes. All permissions, plus the same **ops key** (initiate + execute,
no vote): in an incident the ops laptop proposes the exact `set_pause` with the CLI in seconds, two guardians
approve in their member wallets in the Squads app, the ops key executes.

**Never**: threshold 1, a voter key on a server, two voter keys with one person, a time lock on the guardian.
The CLI prints warnings for these (`checkMultisigConfig`).

### Hot-wallet hygiene (members use normal wallets, not Ledgers)

With software wallets the multisig is only as strong as the weakest two member wallets. Each member:
- **Dedicated wallet, used only for Squads.** A fresh seed phrase created for this; never used for trading, dapps,
  airdrops, mints or signing anything other than FUMPAD Squads proposals. Keep only a little SOL in it (fees).
- **Separate browser profile or, better, a separate device** for that wallet: no other extensions besides the wallet,
  no other wallets, only `app.squads.so` (bookmarked; never via links from chat/email/search ads).
- **Seed phrase offline only** (paper/metal, stored safely); never typed into a computer except to restore that same
  wallet, never photographed, never in a password manager synced to the cloud, never in chat.
- **Never imported elsewhere**: the seed/private key lives in exactly one wallet app on one profile/device; no copies
  in other wallets, scripts, servers or `~/fumpad-keys`.
- Before approving, read what Squads decodes (and `multisig.ts show-tx`): the expected FUMPAD instruction with the
  vault as signer, nothing else. If unsure, don't approve; ask in the guardians' chat.
- A member who suspects their wallet/device is compromised says so immediately: the other two replace that member
  (config transaction, §5) and, if needed, the guardian pauses.

## 3. What you must provide

Public keys only (no secret ever leaves the signer):
1. **3 member pubkeys** (both multisigs) — provided 2026-10-16: `GMtPrH3f…gTn`, `CrJD8Apt…QNk`, `6K3ybxa3…gjBx`
   (dedicated wallets, hygiene above).
2. The **ops pubkey** (`solana-keygen new -o ~/fumpad-keys/mainnet/ops.json` on the ops machine;
   `solana-keygen pubkey …`) — add it to both config files before `create`.
3. Decision: keep `platform_treasury` (default) or a new treasury pubkey.

Already on your side: the mainnet deployer key (current admin + upgrade authority), `~/fumpad-keys/mainnet/rpc.env`.

Config files (`~/fumpad-keys/mainnet/multisig/`, dir 700): `createKeyPath` is relative to the file and is generated
(600) by `create`; it only signs the creation.
```json
// admin.json
{ "label": "admin", "threshold": 2, "timeLockSecs": 21600, "createKeyPath": "admin-create-key.json",
  "members": [
    { "pubkey": "GMtPrH3fhyVPFh5hEHsBhfS6W2hQdcQtv2xLfsDBhTgn", "permissions": "all", "label": "member-1" },
    { "pubkey": "CrJD8AptfHPEnqfu2FnBmiPLcdaVxB53UuLFDH7oQQNk", "permissions": "all", "label": "member-2" },
    { "pubkey": "6K3ybxa3Gtbe3cZ5bKayteX35NVxEqtd3PzFxjKVgjBx", "permissions": "all", "label": "member-3" },
    { "pubkey": "<OPS_PUBKEY>", "permissions": ["initiate", "execute"], "label": "ops (hot, no vote)" } ] }
// guardian.json: the same members, "label": "guardian", "threshold": 2, "timeLockSecs": 0,
//                "createKeyPath": "guardian-create-key.json"
```
(JSON has no comments: drop the `// …` lines.) Written 2026-10-16 with the 3 members; the ops entry is still to be
added (no ops key yet). Check before `create`: `checkMultisigConfig` reports no problems/warnings for both.

## 4. Mainnet sequence (exact commands)

```sh
cd ~/fumpad/services
M="npx tsx scripts/ops/multisig.ts"
K=~/fumpad-keys/mainnet; C="--cluster mainnet --rpc-env $K/rpc.env"
A="--admin-config $K/multisig/admin.json --guardian-config $K/multisig/guardian.json"

npm run multisig:rehearsal                       # 0. local dress rehearsal: must end "✓ multisig rehearsal passed"

# 1. create both multisigs (a few thousandths of a SOL of rent each, paid by the deployer). Simulate, then send.
$M create $C --config $K/multisig/admin.json    --payer $K/deployer.json
$M create $C --config $K/multisig/admin.json    --payer $K/deployer.json --yes
$M create $C --config $K/multisig/guardian.json --payer $K/deployer.json --yes
$M status $C $A                                  # prints both multisigs + vault[0] addresses; members check theirs
```
Each member opens <https://app.squads.so> with their dedicated member wallet (hygiene §2) and adds the multisig by address (`status` prints it):
they must see themselves as members and the right threshold/time lock.
```sh
# 2. day 0: propose_admin(new_admin = admin vault, treasury = current, guardian = guardian vault), signed by the deployer
$M propose-admin $C $A --admin-key $K/deployer.json            # simulate
$M propose-admin $C $A --admin-key $K/deployer.json --yes
$M status $C $A                                  # "PENDING admin <admin vault> … eta <T+6h>"

# 3. day 0: the accept_admin vault transaction (ops key creates it; no approval from the ops key)
$M propose $C --config $K/multisig/admin.json --member-key $K/ops.json --action accept-admin --yes   # prints index N
$M show-tx $C --config $K/multisig/admin.json --index N        # reviewers: inner ix = accept_admin, signer = admin vault
#    → 2 members approve transaction N in the Squads app. Squads' 6 h time lock starts at the 2nd approval.

# 4. ≥ 6 h later, same day (after BOTH: FUMPAD eta and Squads time lock)
$M execute $C --config $K/multisig/admin.json --index N --member-key $K/ops.json --yes   # or "Execute" in the Squads app
$M status $C $A                                  # admin = admin vault, guardian = guardian vault, nothing pending

# 5. only now (the multisig has proven it can execute): the upgrade authority
$M set-upgrade-authority $C --admin-config $K/multisig/admin.json --authority-key $K/deployer.json        # simulate
$M set-upgrade-authority $C --admin-config $K/multisig/admin.json --authority-key $K/deployer.json --yes
solana program show <FUMPAD_PROGRAM_ID> --url "$(sed -n 's/^RPC_URL=//p' $K/rpc.env)" | grep Authority  # = admin vault
#   (the script refuses a target that isn't a live Squads multisig's vault, and is a no-op if already done)

# 6. guardian drill (harmless: set_pause(0) when nothing is paused)
$M propose $C --config $K/multisig/guardian.json --member-key $K/ops.json --action set-pause --bits 0 --yes   # index G
#    → 2 guardians approve G in the Squads app, then:
$M execute $C --config $K/multisig/guardian.json --index G --member-key $K/ops.json --yes                 # proves the guardian vault signs
```
In an incident the guardian does the same with `--bits 31` (`PAUSE_ALL`; or a subset: launch 1, trade 2, claims 4,
graduate 8, attest 16), or `--action cancel-params` / `cancel-admin` (and `cancel_config` / `void_ticket` through the
Squads app's transaction builder). Rehearsed: all of these, plus the refusals listed in §6.

Why the order (2 → 4 → 5): until step 4 nothing is irreversible (the guardian, still the deployer, can
`cancel_admin`). Step 5 is irreversible, so it happens only after the admin vault has executed a real transaction.

Program id: every command uses the SDK's `FUMPAD_PROGRAM_ID`: the compiled-in devnet id `5YMF…` unless the
environment variable `FUMPAD_PROGRAM_ID` is set. **On mainnet export it first** (`export FUMPAD_PROGRAM_ID=$(solana-keygen
pubkey ~/fumpad-keys/mainnet/fumpad-program-keypair.json)` and `export FUMPAD_CLUSTER=mainnet`), as LAUNCH-DAY.md does:
`--cluster mainnet` with the id set but `FUMPAD_CLUSTER` ≠ `mainnet` is refused, and an explicit `FUMPAD_CLUSTER` must
equal the Global's `cluster_tag`. `scripts/mainnet/bootstrap-mainnet.ts` sets both itself from the program keypair.

### Program upgrades afterwards (Squads flow)
```sh
cd ~/fumpad/contracts && anchor build -p fumpad          # (or a verifiable build)
RPC="$(sed -n 's/^RPC_URL=//p' ~/fumpad-keys/mainnet/rpc.env)"   # never echo it
solana program write-buffer target/deploy/fumpad.so --url "$RPC" --keypair ~/fumpad-keys/mainnet/deployer.json   # → BUFFER
solana program set-buffer-authority BUFFER --new-buffer-authority <ADMIN_VAULT> --url "$RPC" --keypair ~/fumpad-keys/mainnet/deployer.json
cd ~/fumpad/services
$M buffer-hash $C --buffer BUFFER --so ../contracts/target/deploy/fumpad.so   # every approver runs this on their own build
$M propose $C --config $K/multisig/admin.json --member-key $K/ops.json --action upgrade --buffer BUFFER --spill <DEPLOYER_PUBKEY> --yes
#  → 3 approvals in the app → 6 h → execute. The buffer's rent goes back to --spill. The new code is live from the next slot.
```
**Bigger program**: the loader refuses `ExtendProgram` from a CPI (rehearsed: "not supported by inner instructions"),
so the vault can't extend. The unchecked `ExtendProgram` is permissionless (any payer, ≥ 10,240 bytes, rehearsed):
`$M extend-program $C --payer $K/deployer.json --bytes 20480 --yes` before proposing the upgrade (costs ≈ 7 SOL per
MB of rent). Simplest: extend with headroom (e.g. +200 KB) once, right before step 5.

## 5. Day-to-day
- `status` any time; `show-tx` before approving anything; members approve only what `show-tx` / the Squads app
  decodes as the expected FUMPAD instruction with the vault as signer.
- Membership/threshold/time-lock changes: Squads "config transactions" in the app (vote + 6 h).
- A proposal approved but not yet executed when membership changes becomes stale: re-propose.
- Lost voter key: the remaining voters remove it (config transaction) and add a new one. Lost ops key: remove it.

## 6. Local rehearsal (`npm run multisig:rehearsal`, ≈ 3 min)

A solana-test-validator with FUMPAD v0.7 (`contracts/target/deploy/fumpad.so`; build it with the devnet program
keypair copied to `contracts/target/deploy/fumpad-keypair.json`, git-ignored), the mainnet Squads v4 program +
ProgramConfig, generated member keys (`services/.local/multisig`, wiped each run), the real `initialize_global`
(admin = guardian = upgrade authority = "deployer", like mainnet after bootstrap). Result 2026-10-14 (1 h / 6 h timelocks, 6 h Squads lock): **33/33 ✓** (2026-10-13 with 48 h: 33/33).

- A: create both (2nd create = no-op) · `propose_admin` (simulate, send; pending fields + eta = now + 6 h) ·
  accept vault tx: 2 approvals stay Active, the ops key can't approve (`Unauthorized`), 3rd approval → Approved,
  executable in 6.0 h · execute early → `TimeLockNotReleased` · guardian multisig `set_pause` before the
  handover → FUMPAD `Unauthorized`.
- warp 1 (+8.3 h) · B: `accept_admin` executed through the admin vault (admin, guardian, treasury set; nothing
  pending) · old admin `set_pause` → `Unauthorized` · upgrade authority → admin vault; old authority can't take it
  back (`IncorrectAuthority`) · buffer written, authority → vault, `buffer-hash` matches · upgrade proposed +
  approved, executing early → `TimeLockNotReleased` · guardian `set_pause(31)` with 1 approval →
  `InvalidProposalStatus`, outsider approval → `NotAMember`, with 2 → paused 31 at once; `set_pause(0)` → 0.
- warp 2 (+12.5 h) · C: upgrade executed by the vault (deployed slot advanced, buffer closed into spill, authority still
  the vault) · ExtendProgramChecked via the vault refused; unchecked extend by a non-authority payer OK · admin
  `queue_params` → guardian `cancel_params` → nothing pending · admin `propose_admin(rotation)` → guardian
  `cancel_admin` (proposed and executed by the ops key, approved by 2 guardians) → nothing pending, admin unchanged.
- D: the CLI itself: `--cluster mainnet` against a local RPC → refused; `status`, `show-tx` decode correctly;
  `propose` without `--yes` only simulates; `create` on an existing multisig sends nothing; no output contains the
  RPC URL.

**How the 6 h elapse locally** (harness `Validator.warp`): the validator starts with a 4,000,000-slot epoch. To
warp, it waits until everything sent is finalized, stops, runs `agave-ledger-tool create-snapshot --ledger L <root>
L --warp-slot <target>`, deletes the old vote tower, and restarts on the same ledger. Clock.unix_timestamp then
follows PoH time minus the 25 % drift bound ≈ 0.3 s per warped slot, so +75k slots ≈ +6–8 h (+600k ≈ +50 h). (A plain
`solana-test-validator --warp-slot` restart warps from the newest snapshot = genesis and silently drops every
account created since; a 2nd warp must wait ≥ 300 rooted slots so no pre-warp slot remains in the status cache.)
Unit tests (`test/ops/ops.test.ts`) cover the config checks and the loader instruction layouts.
