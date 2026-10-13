# FUMPAD governance on Squads v4 multisigs (admin + guardian + upgrade authority)

Tools: `scripts/ops/multisig.ts` (CLI + library, `@sqds/multisig` 2.1.4 = latest), rehearsal
`npm run multisig:rehearsal` (local validator, see §6). Nothing here has touched devnet or mainnet: the live devnet
Global is unchanged. Every write simulates first and only sends with `--yes`; `--cluster` must match the RPC's genesis
(a wrong env file can't hit the wrong cluster); RPC URLs are read from env files and never printed.

## 1. What moves where

| power (INTERFACE-v0.7) | today | after the handover |
|---|---|---|
| **admin**: `queue_params`/`execute_params` (48 h), `queue_config`/`execute_config` (48 h), `set_keepers` (immediate), `set_operators` (immediate), `propose_admin` (48 h), everything guardian can do | deployer key | **admin multisig vault** (3-of-5, 48 h Squads time lock) |
| **guardian**: `set_pause` (immediate, lapses after 7 d), `cancel_params`, `cancel_config`, `cancel_admin`, `void_ticket` | deployer key | **guardian multisig vault** (2-of-3, no time lock) |
| **program upgrade authority** (BPF loader) | deployer key | **admin multisig vault** |
| `platform_treasury` | unchanged unless you pass `--treasury` | |

The two-step handover is FUMPAD's own: `propose_admin(new_admin, treasury, guardian)` by the current admin, 48 h,
then `accept_admin` signed by `new_admin`. Here `new_admin` is a Squads **vault PDA**, so `accept_admin` is executed
*through* the admin multisig (vault transaction → proposal → threshold approvals → time lock → execute; Squads signs
for the vault by CPI). The guardian can `cancel_admin` during the 48 h.

Squads v4: program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, verified 2026-10-13 on mainnet with
`solana program show`: **Authority: none** (immutable), last deployed slot 302582236; the SDK's `PROGRAM_ID` is
checked against it at load. The rehearsal runs the exact mainnet bytecode (dumped read-only, sha256
`dec8d3e0…a01d34c`, `contracts/tests/fixtures/squads_v4_mainnet.so`) and its mainnet `ProgramConfig` (creation fee 0).

## 2. Recommendations

**Admin multisig: 3-of-5 voters, Squads time lock 48 h (172,800 s), no config authority.**
- 5 voters = 5 hardware wallets (Ledger), held by **different people in different places**; nobody holds 3. Each
  voter has all permissions (initiate / vote / execute). A 4th or 5th key lost still leaves the multisig working.
- Optional **ops key** (hot, on the ops laptop): permissions `initiate` + `execute` only, **no vote**. It can create
  proposals and press "execute" after the threshold + time lock, but can never approve: losing it is harmless.
  This is what lets our CLI drive the flow while every approval happens on a Ledger in the Squads app.
- **48 h time lock** covers program upgrades (otherwise instant) and every admin action: users get 48 h to see an
  approved upgrade/param change before it can land. Trade-off: admin's immediate tools (`set_keepers`,
  `set_operators`, `void_ticket`) also wait 48 h; the guardian (no lock) covers incidents meanwhile (`set_pause` incl.
  `PAUSE_ATTEST`, `void_ticket`). If that trade-off is wrong for you, the alternative is a third multisig with the
  same members holding only the upgrade authority (48 h) and the admin multisig at 0 (FUMPAD already timelocks
  params/configs/admin 48 h on chain). Not built; say so if you want it.
- `configAuthority: null` (autonomous): adding/removing members, the threshold and the time lock themselves need a
  vote **and** the time lock. Our `create` always sets this.

**Guardian multisig: 2-of-3, time lock 0.** Three hardware wallets, different people (ideally reachable in
different time zones: a pause should take minutes). Overlap with the admin voters is allowed but keep at least
one guardian who is not an admin voter. All permissions, plus the same **ops key** (initiate + execute, no vote):
in an incident the ops laptop proposes the exact `set_pause` with the CLI in seconds, two guardians approve on
their Ledgers in the Squads app, the ops key executes.

**Never**: threshold 1, a voter key on a server, two voter keys with one person, a time lock on the guardian.
The CLI prints warnings for these (`checkMultisigConfig`).

## 3. What you must provide

Public keys only (no secret ever leaves the signer):
1. **5 admin voter pubkeys** (Ledger addresses, e.g. Phantom/Backpack/Solflare connected to the Ledger → copy address).
2. **3 guardian voter pubkeys**.
3. Optional: the **ops pubkey** (`solana-keygen new -o ~/fumpad-keys/mainnet/ops.json` on the ops machine;
   `solana-keygen pubkey …`).
4. Decision: keep `platform_treasury` (default) or a new treasury pubkey.

Already on your side: the mainnet deployer key (current admin + upgrade authority), `~/fumpad-keys/mainnet/rpc.env`.

Config files (`~/fumpad-keys/mainnet/multisig/`, dir 700): `createKeyPath` is relative to the file and is generated
(600) by `create`; it only signs the creation.
```json
// admin.json
{ "label": "admin", "threshold": 3, "timeLockSecs": 172800, "createKeyPath": "admin-create-key.json",
  "members": [
    { "pubkey": "<LEDGER_1>", "permissions": "all", "label": "alice" },
    { "pubkey": "<LEDGER_2>", "permissions": "all", "label": "bob" },
    { "pubkey": "<LEDGER_3>", "permissions": "all", "label": "carol" },
    { "pubkey": "<LEDGER_4>", "permissions": "all", "label": "dan" },
    { "pubkey": "<LEDGER_5>", "permissions": "all", "label": "erin" },
    { "pubkey": "<OPS_PUBKEY>", "permissions": ["initiate", "execute"], "label": "ops (hot, no vote)" } ] }
// guardian.json
{ "label": "guardian", "threshold": 2, "timeLockSecs": 0, "createKeyPath": "guardian-create-key.json",
  "members": [ { "pubkey": "<G_1>", "permissions": "all" }, { "pubkey": "<G_2>", "permissions": "all" },
               { "pubkey": "<G_3>", "permissions": "all" },
               { "pubkey": "<OPS_PUBKEY>", "permissions": ["initiate", "execute"], "label": "ops (hot, no vote)" } ] }
```
(JSON has no comments: drop the `// …` lines.)

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
Each voter opens <https://app.squads.so> with their Ledger and adds the multisig by address (`status` prints it):
they must see themselves as members and the right threshold/time lock.
```sh
# 2. day 0: propose_admin(new_admin = admin vault, treasury = current, guardian = guardian vault), signed by the deployer
$M propose-admin $C $A --admin-key $K/deployer.json            # simulate
$M propose-admin $C $A --admin-key $K/deployer.json --yes
$M status $C $A                                  # "PENDING admin <admin vault> … eta <T+48h>"

# 3. day 0: the accept_admin vault transaction (ops key creates it; no approval from the ops key)
$M propose $C --config $K/multisig/admin.json --member-key $K/ops.json --action accept-admin --yes   # prints index N
$M show-tx $C --config $K/multisig/admin.json --index N        # reviewers: inner ix = accept_admin, signer = admin vault
#    → 3 voters approve transaction N in the Squads app (Ledger). Squads' 48 h time lock starts at the 3rd approval.

# 4. day 2 (after BOTH: FUMPAD eta and Squads time lock)
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
#  → 3 approvals in the app → 48 h → execute. The buffer's rent goes back to --spill. The new code is live from the next slot.
```
**Bigger program**: the loader refuses `ExtendProgram` from a CPI (rehearsed: "not supported by inner instructions"),
so the vault can't extend. The unchecked `ExtendProgram` is permissionless (any payer, ≥ 10,240 bytes, rehearsed):
`$M extend-program $C --payer $K/deployer.json --bytes 20480 --yes` before proposing the upgrade (costs ≈ 7 SOL per
MB of rent). Simplest: extend with headroom (e.g. +200 KB) once, right before step 5.

## 5. Day-to-day
- `status` any time; `show-tx` before approving anything; members approve only what `show-tx` / the Squads app
  decodes as the expected FUMPAD instruction with the vault as signer.
- Membership/threshold/time-lock changes: Squads "config transactions" in the app (vote + 48 h).
- A proposal approved but not yet executed when membership changes becomes stale: re-propose.
- Lost voter key: the remaining voters remove it (config transaction) and add a new one. Lost ops key: remove it.

## 6. Local rehearsal (`npm run multisig:rehearsal`, ≈ 3 min)

A solana-test-validator with FUMPAD v0.7 (`contracts/target/deploy/fumpad.so`; build it with the devnet program
keypair copied to `contracts/target/deploy/fumpad-keypair.json`, git-ignored), the mainnet Squads v4 program +
ProgramConfig, generated member keys (`services/.local/multisig`, wiped each run), the real `initialize_global`
(admin = guardian = upgrade authority = "deployer", like mainnet after bootstrap). Result 2026-10-13: **33/33 ✓**.

- A: create both (2nd create = no-op) · `propose_admin` (simulate, send; pending fields + eta = now + 48 h) ·
  accept vault tx: 2 approvals stay Active, the ops key can't approve (`Unauthorized`), 3rd approval → Approved,
  executable in 48.0 h · execute early → `TimeLockNotReleased` · guardian multisig `set_pause` before the
  handover → FUMPAD `Unauthorized`.
- warp 1 (+64 h) · B: `accept_admin` executed through the admin vault (admin, guardian, treasury set; nothing
  pending) · old admin `set_pause` → `Unauthorized` · upgrade authority → admin vault; old authority can't take it
  back (`IncorrectAuthority`) · buffer written, authority → vault, `buffer-hash` matches · upgrade proposed +
  approved, executing early → `TimeLockNotReleased` · guardian `set_pause(31)` with 1 approval →
  `InvalidProposalStatus`, outsider approval → `NotAMember`, with 2 → paused 31 at once; `set_pause(0)` → 0.
- warp 2 (+96 h) · C: upgrade executed by the vault (deployed slot advanced, buffer closed into spill, authority still
  the vault) · ExtendProgramChecked via the vault refused; unchecked extend by a non-authority payer OK · admin
  `queue_params` → guardian `cancel_params` → nothing pending · admin `propose_admin(rotation)` → guardian
  `cancel_admin` (proposed and executed by the ops key, approved by 2 guardians) → nothing pending, admin unchanged.
- D: the CLI itself: `--cluster mainnet` against a local RPC → refused; `status`, `show-tx` decode correctly;
  `propose` without `--yes` only simulates; `create` on an existing multisig sends nothing; no output contains the
  RPC URL.

**How the 48 h elapse locally** (harness `Validator.warp`): the validator starts with a 4,000,000-slot epoch. To
warp, it waits until everything sent is finalized, stops, runs `agave-ledger-tool create-snapshot --ledger L <root>
L --warp-slot <target>`, deletes the old vote tower, and restarts on the same ledger. Clock.unix_timestamp then
follows PoH time minus the 25 % drift bound ≈ 0.3 s per warped slot, so +600k slots ≈ +50 h. (A plain
`solana-test-validator --warp-slot` restart warps from the newest snapshot = genesis and silently drops every
account created since; a 2nd warp must wait ≥ 300 rooted slots so no pre-warp slot remains in the status cache.)
Unit tests (`test/ops/ops.test.ts`) cover the config checks and the loader instruction layouts.
