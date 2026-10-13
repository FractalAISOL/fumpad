# FUMPAD contracts v0.7 — interface (Meteora DBC → DAMM v2)

Source of truth for the services/app agents building against the v0.7 program. Spec: `docs/SPEC-v0.7-meteora.md`
(everything it doesn't change keeps its `docs/SPEC.md` v0.6 meaning). Changes to this file are committed with the
prefix `interface:` and a one-line note. Anything not yet verified on the mainnet binaries is marked **UNVERIFIED**.

- Program: `fumpad` (Anchor 1.2.1), **new program id `5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb`** (D39; not
  deployed anywhere). `declare_id!` in `programs/fumpad/src/lib.rs` (the keypair lives in `contracts/target/deploy/fumpad-keypair.json`, git-ignored; back it up). Fresh layouts; no
  v0.6 data migration. `fumpad_lp_locker` is deleted.
- **Devnet and mainnet use different fumpad program ids.** `5YMF…S9Fb` is the devnet (and test) id — its keypair is
  the devnet one; the mainnet build gets its own keypair and `declare_id!`. Every attestation message carries both the
  program id and `Global.cluster_tag` (0 mainnet, 1 devnet, 2 local), and the program checks both, so an
  attestation signed for one cluster never verifies on another. Keepers still use separate keys per cluster.
- External programs (same ids on mainnet + devnet; tests run the **mainnet** binaries, D37):
  DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (0.2.1), DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
  (0.2.4), SPL Token, Token-2022, ATA, Ed25519 precompile `Ed25519SigVerify111111111111111111111111111`, instructions
  sysvar. WSOL `So11111111111111111111111111111111111111112`.
- Every state change emits an Anchor event through the program's event self-CPI (`emit_cpi!` format: inner
  instruction to fumpad whose data = `EVENT_IX_TAG_LE ‖ sha256("event:<Name>")[..8] ‖ borsh`). Instructions marked
  `[ev]` take the two trailing accounts `event_authority` (PDA `["__event_authority"]`) and `program` (fumpad).
- All integers little-endian. Prices `*_q64` = lamports per base unit (6-dec token, 9-dec SOL) in Q64.64 (u128).
  `sqrt_price` = Meteora's Q64.64 sqrt of (quote raw / base raw); `price_q64 = sqrt_price² >> 64`.

## 1. PDAs (fumpad program)

| PDA | Seeds | What |
|---|---|---|
| `global` | `["global"]` | singleton config |
| `fee_claimer` | `["fee_claimer"]` | system account, no data. DBC config `fee_claimer`; owner of the DAMM v2 position NFT; signs DBC `claim_trading_fee` / `withdraw_migration_fee` / `partner_withdraw_surplus` and DAMM `claim_position_fee` / `claim_reward` |
| `fee_wsol` | `["fee_wsol"]` | transient SPL-Token WSOL account (authority `fee_claimer`) created and closed inside `claim_fees` / `claim_lp_fees` / `claim_unregistered_fees` / `graduate`; never exists between instructions |
| `reward_pool` | `["reward_pool"]` | system account, no data. DBC config `leftover_receiver`; authority of every reward vault and escrow |
| reward vault | `ATA(reward_pool, mint, Token-2022)` | the coin's reward pool (created by `register_coin`); DBC `withdraw_leftover` pays the 8% here; buybacks land here; claims pay from here |
| `buyback` | `["buyback"]` | system account, no data. DBC/DAMM swap `payer` for buybacks; owns only `ATA(buyback, WSOL)` |
| `coin` | `["coin", mint]` | per coin |
| `position` | `["position", mint, wallet]` | per wallet per coin (ticket list, counters, auto-claim opt-out) |
| `ticket` | `["ticket", mint, wallet, seq u64 LE]` | one attested sell |
| `consumed` (sell) | `["consumed", sha256(tx_signature 64 B), ix_key u32 LE]` | replay marker of an attested sell |
| `consumed` (rebuy) | `["consumed", sha256(tx_signature 64 B), ix_key u32 LE, ticket]` | replay marker of one (buy/transfer, ticket) debit |
| `claim_queue` | `["claim_queue", mint]` | zero-copy, 1024 entries (81,976 bytes) |
| `observations` | `["observations", mint]` | zero-copy ring, 256 samples (8,280 bytes), graduated coins only |
| `escrow` | `["escrow", ticket]` | Token-2022 account (authority `reward_pool`) for refused payouts (D16) |

Meteora PDAs used: DBC pool authority `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` (`["pool_authority"]`), DBC
pool `["pool", config, max(mint, WSOL), min(mint, WSOL)]`, DBC vault `["token_vault", mint, pool]`; DAMM v2 pool
authority `["pool_authority"]`, DAMM pool `["pool", damm_config, max(mint, WSOL), min(mint, WSOL)]`, position
`["position", nft_mint]`, NFT account `["position_nft_account", nft_mint]`; each program's `["__event_authority"]`.
Mainnet DAMM v2 migration config used by DBC `Customizable`: `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck`.

Derived addresses for program id `5YMF…S9Fb` (they change with the program id): `global`
`9FfSKTcQ5EiUs7JUtC7jMUcW8czCmi1D1ehqSvrTHLst`, `fee_claimer` `HMuSRiSV4PmiC4xkFbuqprXy7dY45C4mZQxDVqNTzJCk`,
`reward_pool` `GAMMBr8LJLE2C1cuETe1dMY1XfzVmNdvEaRFeGi3chUv`, `buyback` `7b72kxr9g1cWsaW7LfDQGSHCHLX4goiYhqiGZc4v6GNF`,
`fee_wsol` `J3gK9hWtupNTz95d5syFBW6VT3pzUVo5JuSFwezB6Yo6`, event authority `DpAyqXC6SwepXeUEBvxLsJ2UV6QQXjj1VsSxi9JLfbHw`.
DBC event authority `8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF`; DAMM v2 pool authority
`HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC`, event authority `3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet`.

FUMPAD DBC configs: exact `create_config` instruction data for mainnet (85 SOL) and devnet (0.85 SOL) in
`tests/vectors/dbc_config.json` (1% migration fee — DBC supports whole percents only; curve re-derived so the reward
pool is exactly 80,000,000 tokens on a single-swap completion; extra swaps can only add rounding dust of a few base
units on top).

## 2. Coin status machine

```
            register_coin                router buy completes the curve
   (none) ───────────────► Curve ─────────────────────────────────► Complete
                             │                                          │
                             │  graduate (DBC pool migrated, any path)  │ graduate
                             └──────────────────────► Graduated ◄───────┘
```
- `Curve` (0): DBC pool trading. Router uses DBC `swap2`. Pre-grad buybacks and pre-grad samples (operator-only) allowed.
- `Complete` (1): the router observed the curve completing (DBC rejects swaps). Third-party completions leave the
  coin in `Curve` until `graduate`; consumers should also read the DBC pool (`migration_progress ≥ 2` = complete).
- `Graduated` (2): `graduate` verified + recorded the DAMM v2 pool and the locked position. Router uses DAMM
  `swap2`; claims, queue, observations, post-grad buybacks enabled.
- Tickets are attested in every status (sells on DBC before completion keep being attested after it).
- `migrate_pool` (our wrapper around DBC `migration_damm_v2`) doesn't change the status; it records who paid the
  flash rent so `graduate` can refund it. Anyone (Meteora's keepers) may also migrate directly.

## 3. Instructions

**Roles (2026-10-13 d).** `Global.keepers` (3 slots) = **attestors**: their Ed25519 signatures count toward
`attest_sell` / `attest_rebuy` (2-of-3) and only they may submit those two instructions — no other power.
`Global.operators` (2 slots) = **operators** (the jobs keeper's key): `record_samples` keeper (non-fallback) samples,
`claim_for`, pre-graduation `execute_buyback`. The two sets are disjoint (`KeeperOperatorOverlap`): an operator key
can neither submit nor co-sign an attestation, and an attestor key has no jobs power. Everything else a keeper does
(fee claims, graduation, queue, closes, params execution) is permissionless.

Notation: `(s)` signer, `(w)` writable, `[ev]` = trailing `event_authority`, `program`. Accounts are listed in order.

### Admin / governance
| Ix | Args | Accounts | Notes |
|---|---|---|---|
| `initialize_global` | `admin: Pubkey, platform_treasury: Pubkey, cluster_tag: u8, params: Params, keepers: [Pubkey; 3], operators: Vec<Pubkey>` (0–2 keys; a Vec so the bootstrap's bundled create_config + init simulation fits 1,232 bytes) | payer (s,w; = program upgrade authority), global (w, init), program (fumpad), program_data, system_program, event_authority; **remaining = the initial DBC configs (0–8, read-only)** | guardian = admin. **Bootstrap (§8 changelog 2026-10-13 b):** `keepers` (non-default keys distinct, else `InvalidParams`; `Pubkey::default()` = empty slot) start with `keeper_added_at = 0` = **no 6h attest freeze**; each remaining account is validated exactly like `execute_config` add (§5.4; `InvalidConfig` / `WrongVenue` / `InvalidAccount`; duplicate → `InvalidParams`; > 8 → `ConfigListFull`) and allow-listed **without the 48h timelock**. Rationale: only the upgrade authority can initialize and it could replace the program anyway; every later `set_keepers` / `queue_config` keeps its freeze / timelock. `operators` (≤ 2 and distinct, else `InvalidParams`; none may be a keeper, else `KeeperOperatorOverlap`) are set at once. `cluster_tag`: 0 mainnet-beta, 1 devnet, 2 localnet/test (immutable; part of every attestation message). Events `GlobalInitialized`, then `KeepersSet { added_at: [0;3] }` (if any keeper), `OperatorsSet` (if any operator) and one `ConfigUpdated { add: true }` per config |
| `queue_params` | `params: Params` | admin (s), global (w) [ev] | 48h timelock (D15). `Params::is_valid`. Event `ParamsQueued` |
| `execute_params` | — | caller (s), global (w) [ev] | permissionless after eta. Event `ParamsUpdated` |
| `cancel_params` | — | authority (s; admin or guardian), global (w) [ev] | Event `ParamsCancelled` |
| `set_pause` | `paused: u8` | authority (s; admin or guardian), global (w) [ev] | bits ⊆ `PAUSE_ALL` (0b1_1111); non-zero lapses after 7 days. Event `PauseSet` |
| `set_keepers` | `keepers: [Pubkey; 3]` | admin (s), global (w) [ev] | immediate. A key not in the previous set gets `keeper_added_at = now` (never 0): its attestation signatures count only from `now + 6h` (`KEEPER_ATTEST_FREEZE_SECS`). Keys that stay keep their timestamp (a bootstrap key stays at 0 = no freeze; removed and re-added = a new key, frozen). A key that is a current operator → `KeeperOperatorOverlap` (move the jobs key with `set_operators` first). Event `KeepersSet` |
| `set_operators` | `operators: [Pubkey; 2]` | admin (s), global (w) [ev] | immediate, no freeze (operators never create tickets). Non-default keys distinct (`InvalidParams`), none a current keeper (`KeeperOperatorOverlap`); all-default = no operator (jobs stop: pre-grad samples / buybacks and `claim_for` refuse everyone, post-grad samples become fallback-only). Event `OperatorsSet` |
| `propose_admin` | `new_admin, platform_treasury, guardian: Pubkey` | admin (s), global (w) [ev] | 48h. Event `AdminProposed` |
| `accept_admin` | — | new_admin (s; = pending_admin), global (w) [ev] | Event `AdminAccepted` |
| `cancel_admin` | — | authority (s; admin or guardian), global (w) [ev] | Event `AdminProposalCancelled` |
| `queue_config` | `config: Pubkey, add: bool` | admin (s), global (w), dbc_config (= `config`; DBC-owned `PoolConfig`, validated when `add`) [ev] | allow-list change, 48h (`CONFIG_TIMELOCK_SECS`). Replaces any pending config change. Validation §5.4. Event `ConfigQueued` |
| `execute_config` | — | caller (s), global (w), dbc_config (= pending; re-validated on add) [ev] | permissionless after eta. Add: into the first empty slot of `Global.configs` (8 slots; `ConfigListFull`), duplicate → `InvalidParams`. Remove: clears the slot (registered coins keep working). Event `ConfigUpdated` |
| `cancel_config` | — | authority (s; admin or guardian), global (w) [ev] | Event `ConfigCancelled` |
| `migrate_global` | — | admin (s,w), global (w, raw), system_program [ev] | layout-upgrade hook. On the current 1,044-byte layout: if `operators` is all default (a Global initialized before operators existed — those bytes were `reserved`) and `keepers[0]` is set, fills `operators[0] = keepers[0]` (the key that ran the jobs keeper; the ONE way a key can be both, until `set_operators` moves it) and emits `OperatorsSet`; otherwise a no-op. Any other length → `UnsupportedGlobalLayout`. Event `GlobalMigrated` |

### Launch
`register_coin()` — the 3rd instruction of the launch tx (`initialize_virtual_pool_with_token2022` → creator's
top-level DBC `swap2` (gets the min fee) → `register_coin`).

Accounts: creator (s,w; pays Coin + reward-vault rent), global, mint (Token-2022 mint = pool base mint), dbc_config,
dbc_pool, coin (w, init `["coin", mint]`), reward_pool (PDA), reward_vault (w; `ATA(reward_pool, mint,
Token-2022)`, created idempotently), token_2022_program, associated_token_program, system_program, **launch_signer
(s; optional — required iff `Global.params.launch_signer != default`, else pass the fumpad program id)** [ev].

Checks: not `PAUSE_LAUNCH`; launch binding: when `Global.params.launch_signer` is set, `launch_signer` must be that
key and sign (`Unauthorized` otherwise) — the API co-signs every launch tx it builds, like the vanity mint; `dbc_pool` owned by DBC with the `VirtualPool` discriminator; `pool.base_mint == mint`,
`pool.config == dbc_config`, `pool.creator == creator`; `pool.migration_progress == 0` (pre-bonding, not complete);
`dbc_config ∈ Global.configs` and still passes the §5.4 structural checks. Snapshots into Coin: reward terms + fee
split (from `Global.params`), `launch_slot = pool.activation_point`, `launch_window_slots` = DBC fee scheduler
`number_of_period × period_frequency` (0 if no scheduler), `total_supply = config.pre_migration_token_supply`.
Event `CoinRegistered`.
DBC 0.2.1 gives its min fee (`enable_first_swap_with_min_fee`) to ONE swap of the pool-creation tx only: further
top-level swaps in the same tx pay the 99% scheduler fee (verified on the mainnet binary,
`review_v07::verify_dbc_min_fee_goes_to_one_swap_per_launch_tx`), so `register_coin` doesn't introspect the tx.

### Router
| Ix | Args | Accounts |
|---|---|---|
| `buy` | `amount_in: u64, min_out: u64, mode: u8` (0 ExactIn, 1 PartialFill) | trader (s), global, coin (w), venue_program (DBC while `Curve`, DAMM v2 when `Graduated`) [ev]; remaining = the venue's `swap2` accounts |
| `sell` | `amount_in: u64, min_out: u64` | same |

Remaining accounts (pass-through, only the trader signs; 15 ≤ n ≤ 24 for DBC, 14 ≤ n ≤ 24 for DAMM):
- DBC `swap2`: 0 pool_authority, 1 config, 2 pool, 3 input, 4 output, 5 base_vault, 6 quote_vault, 7 base_mint,
  8 quote_mint, 9 payer, 10 token_base_program, 11 token_quote_program, 12 referral (pass the DBC program id = None),
  13 event_authority, 14 program.
- DAMM `swap2`: 0 pool_authority, 1 pool, 2 input, 3 output, 4 token_a_vault, 5 token_b_vault, 6 token_a_mint,
  7 token_b_mint, 8 payer, 9 token_a_program, 10 token_b_program, 11 referral (DAMM program id = None),
  12 event_authority, 13 program.

Checks: buy not `PAUSE_TRADE` (sells never paused); coin `Curve` → DBC, `Graduated` → DAMM, else `WrongCoinStatus`;
DAMM pool `pool_status` (offset 481) must be 0 — a pool disabled by its operator → `PoolDisabled` (buys and sells);
`venue_program` id; pool == `coin.dbc_pool` / `coin.damm_pool`; base mint == `coin.mint`, quote mint == WSOL;
payer == trader; referral = None (keeps the fee measurement exact); base account = the trader's **canonical**
`ATA(trader, mint, Token-2022)`; quote account = an SPL-Token WSOL account owned by the trader; sell `mode` is
always ExactIn. The CPI data is built by fumpad (`swap2` discriminator `[65,75,63,76,235,91,91,136]`,
`amount_0 = amount_in, amount_1 = min_out, swap_mode`). Results are measured as balance deltas of the two trader
accounts + pool state deltas (`RoutedTrade` event; set_return_data = `base u64 ‖ quote u64`). A DBC buy that
completes the curve sets `Complete` (+ `CurveCompleted`). Use PartialFill (mode 1) for buys that may complete the
curve (ExactIn overshoot reverts on DBC).

### Fees
`claim_fees()` — DBC partner trading fees (permissionless, never paused).
Accounts: caller (s,w; pays the transient `fee_wsol` rent, refunded in the same ix), global, coin (w), mint,
dbc_config, dbc_pool (w), dbc_base_vault (w), dbc_quote_vault (w), fee_claimer (w), fee_wsol (w), reward_vault (w;
base-side destination, receives 0 in quote fee mode), wsol_mint, token_program (SPL), token_2022_program,
system_program, dbc_pool_authority, dbc_event_authority, dbc_program [ev].
CPI `claim_trading_fee(u64::MAX, u64::MAX)` (exact pinned 14-account list) signed by `fee_claimer`; the claimed
WSOL is unwrapped into the Coin account. Split: first claim (`launch_fees_settled == false`) requires
`slot ≥ launch_slot + launch_window_slots` and sends **100% → `buyback_lamports`** (D33), then sets the flag; later
claims split per `coin.fee_split` (default 50/30/20; platform and creator exact floors, rounding remainder → buyback).
Zero claimed → `NothingToClaim` (the launch flag is still set when the window has passed, so call it once anyway).
Event `FeesClaimed`.

`claim_lp_fees()` — DAMM v2 position fees (permissionless). Requires `Graduated` and `launch_fees_settled`.
`damm_position` = **any** DAMM v2 position of `coin.damm_pool` whose NFT the `fee_claimer` PDA holds (normally
`coin.damm_position`, the DBC-created 100%-locked one; `position.pool != coin.damm_pool` → `WrongVenue`; DAMM itself
requires the NFT holder `fee_claimer` to sign). Pass the position of the NFT you claim for; `coin.damm_position` is
not enforced (REVIEW-v0.7 H-1: a third-party position handed to `fee_claimer` before `graduate` can't strand ours).
Accounts: caller (s,w), global, coin (w), mint, damm_pool, damm_position (w), position_nft_account,
damm_token_a_vault (w), damm_token_b_vault (w), fee_claimer (w), fee_wsol (w), reward_vault (w; token-a
destination), wsol_mint, token_program, token_2022_program, system_program, damm_pool_authority,
damm_event_authority, damm_program [ev]. CPI `claim_position_fee` signed by `fee_claimer`; split as above.
Event `FeesClaimed`.

`claim_unregistered_fees()` — DBC partner trading fees of a pool on a FUMPAD-shaped config whose base mint never
called `register_coin` (permissionless, never paused; THREAT-MODEL G4 a). Accounts: caller (s,w; pays the transient
`fee_wsol` rent, refunded), global, mint (= pool base mint), coin (`["coin", mint]`; must NOT exist — system-owned,
no data — else `PoolIsRegistered`), dbc_config (must pass the §5.4 structural checks: fee claimer = our PDA, quote-only
fees — else `InvalidConfig`; it need not be allow-listed), dbc_pool (w; `pool.config == dbc_config`, `pool.base_mint
== mint`), dbc_base_vault (w), dbc_quote_vault (w), fee_claimer (w), fee_wsol (w), reward_vault (w; `ATA(reward_pool,
mint, Token-2022)` = DBC's base-side destination, receives 0; **must exist** — create it idempotently in the same tx),
wsol_mint, platform_treasury (w; = `Global.platform_treasury`), token_program, token_2022_program, system_program,
dbc_pool_authority, dbc_event_authority, dbc_program [ev]. CPI `claim_trading_fee(u64::MAX, u64::MAX)` with the same
pinned 14-account list as `claim_fees`; the claimed WSOL is unwrapped and paid **entirely to `platform_treasury`** (no
coin, no split); 0 claimed → `NothingToClaim`. Event `UnregisteredFeesClaimed`. Not covered (documented, rare): the
partner migration fee / surplus, the 8% leftover (DBC pays it to `ATA(reward_pool, mint)`, which has no claim path
without a Coin) and the LP position of an unregistered pool that graduates. A pool registered later (only possible
while `migration_progress == 0`, creator-signed, with the launch co-signer when set) keeps only the fees accrued after
the sweep.

`claim_position_rewards(reward_index: u8)` — DAMM v2 farming rewards (`claim_reward`) of a `fee_claimer`-held position
of a graduated coin's pool (permissionless, never paused; THREAT-MODEL G4 b). Accounts: caller (s), global, coin
(`has_one` mint, damm_pool; `Graduated` else `WrongCoinStatus`), mint, damm_pool (w), damm_position (w; any position of
the pool whose NFT `fee_claimer` holds, like `claim_lp_fees`; `position.pool != damm_pool` → `WrongVenue`),
position_nft_account (= `["position_nft_account", nft_mint]`), damm_reward_vault (w; = `pool.reward_infos[i].vault`),
reward_mint (= `pool.reward_infos[i].mint`), destination (w), fee_claimer, reward_token_program (SPL Token if the slot's
`reward_token_flag` = 0, Token-2022 if 1), damm_pool_authority, damm_event_authority, damm_program [ev]. Checks:
`reward_index < 2`, slot initialized, mint / vault / token program match the slot (`WrongVenue`); destination =
**`ATA(reward_pool, mint, Token-2022)` (the coin's reward vault) when `reward_mint == mint`**, else
**`ATA(Global.platform_treasury, reward_mint, reward_token_program)`** (must exist) — anything else `InvalidAccount`.
CPI DAMM `claim_reward(reward_index, skip_reward = 0)` (disc `[149,95,181,242,94,90,158,162]`, exact pinned 11-account
list) signed by `fee_claimer`; the amount is the destination's measured balance delta; 0 → `NothingToClaim`. Event
`PositionRewardClaimed`. Pool reward slots: `Pool.reward_infos[2]` at offset 728, 192 bytes each (initialized u8 @0,
reward_token_flag u8 @1, mint @16, vault @48). On FUMPAD pools only a DAMM admin can initialize a reward (UNVERIFIED; the pool
creator is DBC's pool authority), so this is normally idle.

`withdraw_creator_fees()` — creator (s,w), coin (w) [ev]; never paused. Event `FeesWithdrawn`.
`withdraw_platform_fees()` — caller (s), global, coin (w), platform_treasury (w; = `Global.platform_treasury`) [ev].

### Buyback
`execute_buyback(max_in: u64)` — cranker (s,w), global, coin (w), mint, observations (`["observations", mint]`; pass
the PDA address pre-graduation, unused), buyback (w, PDA), buyback_wsol (w; `ATA(buyback, WSOL)`, init-if-needed,
cranker pays), reward_vault (w), wsol_mint, venue_program, token_program, token_2022_program,
associated_token_program, system_program [ev]; remaining = the venue's `swap2` accounts **exactly** (DBC 15 / DAMM
14, every key pinned: payer = `buyback`, input = `buyback_wsol`, output = `reward_vault`, referral = None).
- Not `PAUSE_TRADE`. `Curve` (pre-grad): **operator-only** (`Global.operators`; attestor keys → `Unauthorized`); `slot ≥ launch_slot + launch_window_slots`; the coin's
  last keeper pre-grad sample must be ≤ 60 s old (`PREGRAD_SAMPLE_MAX_AGE_SECS`, else `StaleSample`); **guard price
  = median of `coin.pregrad_ring`** (samples with `ts ∈ [now − 300, now]`, ≥ 4 of them spanning ≥ 60 s, even count
  → mean of the two middle values; else `InsufficientSamples`); spot (DBC `sqrt_price`) within
  ±`buyback_max_deviation_bps` of BOTH that median and the last sample (`PriceDeviation`; L5, §8 2026-10-13 c); slice ≤ `buyback_max_pool_bps` of the curve's `quote_reserve`; and
  `quote_reserve + slice < migration_quote_threshold` (a buyback never completes the curve).
- `Graduated`: permissionless; the DAMM v2 pool must be enabled (`pool_status == 0`, else `PoolDisabled` — a disabled
  pool's spot is frozen, not a market); spot within ±band of the 30-min keeper median (coverage as v0.6); slice ≤
  `buyback_max_pool_bps` of the pool's `token_b_amount`.
- Both: received tokens ≥ fair amount at the guard price less (band + 200 bps fee allowance + 2 × slice);
  spend = min(max_in, buyback_lamports, slice cap) > 0 (`NothingToBuyBack`). Event `BuybackExecuted`.
- `Complete` → `WrongCoinStatus`.

### Graduation
`migrate_pool()` — caller (s,w), global, coin (w), dbc_program [ev]; remaining = DBC `migration_damm_v2` accounts
in DBC order (0 virtual_pool, 1 migration_metadata (any; deprecated), 2 config, 3 pool_authority, 4 damm pool,
5 first_position_nft_mint (s; fresh keypair), 6 first_position_nft_account, 7 first_position, 8–10 second position
triple (DBC program id = None), 11 damm_pool_authority, 12 amm_program, 13 base_mint, 14 quote_mint,
15 token_a_vault, 16 token_b_vault, 17 base_vault, 18 quote_vault, 19 payer (= caller), 20 token_base_program,
21 token_quote_program, 22 token_2022_program, 23 damm_event_authority, 24 system_program, 25 DAMM v2 config).
Checks: not `PAUSE_GRADUATE`; `virtual_pool == coin.dbc_pool`; payer == caller; coin not `Graduated`. Records
`coin.migrator = caller`, `coin.migrator_cost` = the caller's measured lamport outflow (DBC flash rent), refunded by
`graduate` from the migration fee. Uses the 600k-CU-class migration; set a compute budget. Event `PoolMigrated`.
(Anyone may call DBC `migration_damm_v2` directly instead; then nothing is refunded.)

`graduate()` — caller (s,w), global, coin (w), mint, dbc_config, dbc_pool (w), dbc_quote_vault (w), dbc_base_vault
(w), damm_config, damm_pool, damm_position, position_nft_account, fee_claimer (w), fee_wsol (w), reward_pool,
reward_vault (w), wsol_mint, migrator (w; = `coin.migrator`, or the caller's own key when none — may repeat the
caller), observations (w, PDA),
claim_queue (w, PDA), token_program, token_2022_program, system_program, dbc_pool_authority, dbc_event_authority,
dbc_program [ev]. Permissionless; not `PAUSE_GRADUATE`; coin `Curve|Complete`.
1. Requires the DBC pool migrated (`migration_progress == 3`, `is_migrated == 1`) — else `NotMigrated`.
2. Verifies the DAMM v2 pool: owner DAMM, `pool == PDA["pool", damm_config, max, min]`, `damm_config` owned by DAMM
   with `pool_creator_authority == DBC pool authority`, `token_a_mint == mint`, `token_b_mint == WSOL`,
   `creator == DBC pool authority`; the position: `position.pool == damm_pool`, `unlocked == 0`, `vested == 0`,
   `permanent_locked > 0`, NFT account = `PDA["position_nft_account", position.nft_mint]` with token owner
   `fee_claimer` and amount 1. **Never compared with pool totals** (REVIEW-v0.7 H-1: anyone can add or lock
   liquidity; extra third-party liquidity no longer blocks `graduate`). Records `damm_pool`, `damm_position`,
   `status = Graduated`. Keepers pass the NFT mint of the DBC migration (first position).
3. `withdraw_leftover` if not yet withdrawn (DBC flag), measured as the reward-vault delta; when someone else already
   called DBC's permissionless `withdraw_leftover`, `leftover_tokens` = reward-vault balance − `coin.buyback_tokens`
   (REVIEW-v0.7 I-1; donations to the vault count); `withdraw_migration_fee` (partner) if not yet withdrawn;
   `partner_withdraw_surplus` if not yet withdrawn — both into `fee_wsol`, unwrapped. WSOL already sitting in a
   pre-funded `fee_wsol` is excluded from `surplus` and the budget and returned to the caller with the rent.
4. Spends migration fee + surplus (the "setup budget"), in order: migrator refund (`coin.migrator_cost`, capped)
   → caller's own net rent for this ix → observations rent (pre-funded into the PDA) → claim-queue rent
   (pre-funded) → remainder `platform_fees_unclaimed` (a step the budget can't fully fund is funded partially unless
   that would leave a fresh PDA below the 0-byte rent minimum). `migrator_refund + caller_refund + setup_prefunded +
   platform_fee = migration_fee + surplus` (tested). Event `Graduated`.

`init_observations()` — payer (s,w), coin, observations (w, init), system_program. Requires `Graduated`.
`init_claim_queue()` — payer (s,w), coin, claim_queue (w), system_program. Call 9× (one tx). Requires `Graduated`.

### Oracle
`record_samples()` — sampler (s), global, instructions sysvar [ev]; remaining = 1–10 groups of
`[coin (w), pool, observations (w)]`. Tx must contain only compute-budget instructions besides this one.
- "Keeper sample" = a sample by an **operator** key (`Global.operators`); attestor keys sample like anyone else.
- `Graduated`: pool == `coin.damm_pool`; `price_q64` from DAMM `sqrt_price` (offset 456); ring push; keeper or
  fallback rules exactly as v0.6 (keeper spacing vs keeper samples, fallback after `keeper_stale_secs`, fallback
  samples never count). **A pool disabled by its DAMM v2 operator (`pool_status` @481 ≠ 0) is skipped** — no sample
  (keeper or fallback), no event, no error; the rest of the batch proceeds. Its frozen price never enters the ring, so
  **claims on that coin wait**: with no new sample the 30-min median loses coverage (`InsufficientSamples` once 2 of
  the 6 five-minute buckets are empty — at most ≈ 10 min at defaults, earlier when `oracle_min_samples` is no longer
  met) until the pool is re-enabled and operator samples refill the window. Claims inside that window use samples
  taken while the pool still traded.
- `Curve`: pool == `coin.dbc_pool`; **operator only**; spacing ≥ `oracle_min_spacing_secs` vs the previous pre-grad
  sample; DBC `sqrt_price` (offset 280) → `coin.pregrad_sample_price_q64/ts` and pushed into `coin.pregrad_ring`
  (5 samples, in the Coin; the observations account in the group is ignored). Used only by the pre-grad buyback
  guard, never for claims (D1).
- `Complete` → the group is **skipped** (no sample, no event, no error; the rest of the batch proceeds). Event
  `SampleRecorded` per sampled group.

### Tickets (attestations, D31)
`attest_sell()` — no args. Accounts: keeper (s,w; ∈ `Global.keepers`; pays rent of position/ticket/consumed),
global, coin (w), position (w; `["position", mint, trader]`, created if missing), ticket (w; `["ticket", mint,
trader, position.next_ticket_seq]`, created), consumed (w; sell PDA, created), instructions sysvar,
system_program [ev]. The instruction **immediately before** it must be an Ed25519 precompile instruction whose
signature entries all reference data inside that instruction (`*_instruction_index == u16::MAX`), all over the same
284-byte message (§4.1); ≥ `attest_threshold` (2) **distinct** active keeper keys (in `Global.keepers`, past their
6h freeze, or bootstrap keepers with `keeper_added_at == 0`) must be among the signers; other signers are ignored. The record is read from that message.
Checks (fail → error, nothing created): not `PAUSE_ATTEST`; `program_id`, `cluster_tag`; `mint == coin.mint`;
venue bit0 = 0 → `pool == coin.dbc_pool`, 1 → `pool == coin.damm_pool ≠ default`; `trader ∉ {default,
coin.creator}`; `usd_cents ≥ coin.rewards.min_sell_usd_cents`; `0 < ticket_tokens ≤ base_amount`; `quote_gross > 0`;
`ticket_price_q64 > 0` (`InvalidTicketAmount`); **`ticket_price_q64 ≥ ⌊quote_gross × 2⁶⁴ / base_amount⌋`** (the
execution price, the engine's exact formula; D12 ticket price = max(execution, floor) ≥ execution — no tolerance;
else `TicketPriceBelowExecution`); `slot ≥ coin.launch_slot`; `block_time ≥ coin.created_at − 60`; `block_time ≤ now + 60`;
`now − block_time ≤ max_attest_age_secs`; `0 ≤ block_time − pyth_publish_time ≤ max_price_age_secs`;
`position.open_count < coin.rewards.max_open_tickets`; replay: the sell marker must not exist — or be **reopened**
(`kind = 2`, set by `void_ticket(.., reopen = true)`) with a `message_hash` different from this message's
(`AlreadyConsumed` otherwise); a reopened marker is reused (its original `rent_payer` kept) and turned back into a
live sell marker. **Rate cap (M-1): never rejects** — the per-coin leaky bucket (§5.3) gives the ticket an
`effective_at ≥ now` (= now while the coin is under `max_attest_tokens_per_hour_bps` of supply per hour, later when
over it). Creates the Ticket (`Open`, `attested_at = effective_at`, `rent_payer = keeper`). Event `TicketAttested`
(`effective_at`).

`attest_rebuy()` — no args. Accounts: keeper (s,w; ∈ `Global.keepers`), global, coin (**w**), ticket (w), position (w), consumed (w; rebuy PDA,
created), claim_queue (w; **optional**: required iff the ticket is `Queued`, else pass the fumpad program id),
instructions sysvar, system_program [ev]. Same Ed25519 scheme over the 236-byte rebuy message (§4.2).
Checks: not `PAUSE_ATTEST`; message ticket/mint/owner match; ticket `Open|Queued`; `ticket.sell_ts ≤ block_time ≤
ticket.sell_ts + rebuy_window_secs`; `now − block_time ≤ max_attest_age_secs`; `debit_tokens > 0`. Debits
`min(debit, tokens)`; at 0 tokens (or 0 owed) → `Voided` and off the open list; a `Queued` ticket's queue entry is
updated (lowered or removed) in the same ix. The debited tokens' rate-cap capacity is released (§5.3). Event
`TicketDebited`.

`void_ticket(reason: u8, reopen: bool)` — authority (s; guardian or admin), global, coin (w; `["coin",
ticket.mint]`), mint (= `ticket.mint`), ticket (w), position (w), consumed (w; = `ticket.consumed`, the sell marker)
[ev]. Ticket `Open` and `now < attested_at + ticket_challenge_secs` (`ChallengeWindowOver` otherwise; `attested_at`
is the effective time, so a deferred ticket's window ends later). → `Voided`; its tokens' rate-cap capacity is
released. `reopen = true` (the attestation was wrong, the trade may be honest — engine bug): the sell marker becomes
`kind = 2` so ONE corrected attestation of the same trade (any message except the voided one) can follow while
`now − block_time ≤ max_attest_age_secs`; `reopen = false` (fraud) keeps the trade consumed forever. Event
`TicketVoided` (`coin`, `reopened`).

`close_consumed()` — caller (s), global, consumed (w; closed → rent_payer), rent_payer (w; = consumed.rent_payer),
ticket (= consumed.ticket; must not be a live fumpad account) [ev]. Also requires `now > consumed.block_time +
MAX_MAX_ATTEST_AGE_SECS` (7 days), so a closed marker can never let the same trade be attested again (a reopened
marker points at the voided ticket and follows the same rule).
Event `ConsumedClosed`.

### Claims (v0.6 rules + challenge window; pay from the reward vault, signed by `reward_pool`)
| Ix | Args | Accounts |
|---|---|---|
| `claim` | — | owner (s), global, coin (w), mint, ticket (w), position (w), claim_queue (w), observations, reward_pool, reward_vault (w), owner_token_account (w; any Token-2022 account of the owner for the mint), token_program (Token-2022) [ev] |
| `claim_for` | — | keeper (s,w; **an operator**, `Global.operators`), global, coin (w), mint, ticket (w), position (w), claim_queue (w), observations, reward_pool, reward_vault (w), owner_ata (w; canonical ATA, may be missing), escrow (w; `["escrow", ticket]`), token_program, system_program [ev] |
| `process_queue` | `max_entries: u8` | cranker (s,w), global, coin (w), mint, claim_queue (w), reward_pool, reward_vault (w), token_program, system_program [ev]; remaining = quadruples `[ticket (w), position (w), owner canonical ATA (w), escrow PDA (w)]` in queue order (a legacy tx carries 5 quadruples; 13 need a v0 tx + ALT and ≈ 600k CU when all escrow) |
| `withdraw_escrow` | — | owner (s), global, mint, ticket (w), escrow (w), reward_pool, destination (w), escrow_payer (w), token_program [ev] |
| `set_auto_claim` | `enabled: bool` | wallet (s), position (w) [ev] |
| `close_ticket` | — | caller (s), global, ticket (w; closed → rent_payer), rent_payer (w; = ticket.rent_payer), position (w), claim_queue (optional, w), coin [ev] |
| `close_position` | — | signer (s; the wallet, or `position.rent_payer` **only while `auto_claim_opt_out == 0`** — L-1), position (w; closed → rent_payer), rent_payer (w) [ev]; remaining = ticket PDAs seq `0..next_ticket_seq` (≤ 64), none live |

`claim`/`claim_for` = v0.6 `decide_claim` plus: `now ≥ ticket.attested_at + ticket_challenge_secs`
(`TicketInChallenge`). Pause `PAUSE_CLAIMS` (claim, claim_for, process_queue, withdraw_escrow). `close_ticket` is
permissionless for every terminal state (Claimed, Voided, Expired; Open past `sell_ts + claim_window` → Expired);
Queued and Escrowed are never closable. Rent always goes to `rent_payer` (the attesting keeper).

## 4. Attestation messages (Ed25519, fixed width, little-endian)

Test vectors: `contracts/tests/vectors/attestation.json` (message hex, keeper secret seeds, signatures, consumed
PDA, Ed25519 instruction data) — generated by `cargo test -p fumpad --lib attestation_vectors` and checked in.

### 4.1 Sell — 284 bytes
| off | size | field | notes |
|---|---|---|---|
| 0 | 14 | `"FUMPAD-SELL-v1"` | ASCII domain tag |
| 14 | 32 | program_id | fumpad program id |
| 46 | 1 | cluster_tag | `Global.cluster_tag` |
| 47 | 32 | mint | |
| 79 | 32 | pool | DBC virtual pool or DAMM v2 pool of the trade |
| 111 | 1 | venue | bit0: 0 DBC, 1 DAMM v2; bit7 (0x80): the swap was routed by the fumpad router (→ `Ticket.source = Router`); other bits must be 0 |
| 112 | 64 | signature | tx signature |
| 176 | 4 | ix_key | u32 `(top_ix << 16) \| (inner_ix + 1)` of the swap instruction (ATTESTATION.md) |
| 180 | 32 | trader | ticket owner |
| 212 | 8 | base_amount | u64 tokens sold |
| 220 | 8 | quote_gross | u64 lamports before fees |
| 228 | 8 | ticket_tokens | u64 (≤ base_amount; hold/rebuy engine result) |
| 236 | 16 | ticket_price_q64 | u128 (D10/D12 floor already applied by the engine) |
| 252 | 8 | usd_cents | u64 value of the ticket's tokens |
| 260 | 8 | pyth_publish_time | i64 |
| 268 | 8 | slot | u64 |
| 276 | 8 | block_time | i64 |

### 4.2 Rebuy — 236 bytes
| off | size | field |
|---|---|---|
| 0 | 15 | `"FUMPAD-REBUY-v1"` |
| 15 | 32 | program_id |
| 47 | 1 | cluster_tag |
| 48 | 32 | mint |
| 80 | 32 | ticket (PDA) |
| 112 | 32 | owner |
| 144 | 64 | signature (of the buy / incoming transfer tx) |
| 208 | 4 | ix_key |
| 212 | 8 | debit_tokens |
| 220 | 8 | slot |
| 228 | 8 | block_time |

### 4.3 Ed25519 instruction
Program `Ed25519SigVerify111111111111111111111111111`, no accounts, placed immediately before `attest_sell` /
`attest_rebuy`. Data: `num_signatures u8 ‖ 0u8 ‖ num × {signature_offset u16, signature_ix u16 = 0xFFFF,
pubkey_offset u16, pubkey_ix u16 = 0xFFFF, message_offset u16, message_size u16, message_ix u16 = 0xFFFF}` followed
by the signatures, pubkeys and **one** copy of the message all offsets point to (2 signers: 2 + 28 + 2 × 96 + 284 =
506 bytes for a sell). Recommended layout (what the vectors use): header, `sig0 ‖ pk0 ‖ sig1 ‖ pk1`, message. A
sell attestation tx (Ed25519 ix + `attest_sell`, keeper fee payer) is ≈ 990 bytes (legacy).

## 5. Account layouts (Anchor accounts: 8-byte discriminator + borsh)

Sizes incl. discriminator: Global 1,044 · Coin 546 · Position 315 · Ticket 276 · Consumed **98** · ClaimQueue 81,976 ·
Observations 8,280 (unit test `state::size_tests::account_sizes`).

### 5.1 `Params` (borsh, in `Global.params` / `pending_params`)
`fee_buyback_share_bps u16, fee_platform_share_bps u16, fee_creator_share_bps u16` (sum 10,000; default 5,000 /
3,000 / 2,000) · `trigger_multiple_bps u32, claim_bps u16, max_claim_pool_bps u16, min_sell_usd_cents u64,
min_hold_secs i64, rebuy_window_secs i64, claim_window_secs i64, max_open_tickets u8` (v0.6 defaults/bounds; the
engine reads hold/rebuy from the coin snapshot) · `oracle_window_secs i64, oracle_min_spacing_secs i64,
oracle_min_samples u16, keeper_stale_secs i64, buyback_max_deviation_bps u16, buyback_max_pool_bps u16` (v0.6) ·
`sol_usd_feed_id [u8;32]` (pinned Pyth SOL/USD) · `max_price_age_secs u64` (engine's max |block_time −
publish_time|; default **60**, bounds 30–300) · `max_attest_age_secs i64` (default 86,400; bounds 3,600–604,800) ·
`max_attest_tokens_per_hour_bps u16` (default 2,000; bounds 1–10,000) · `ticket_challenge_secs i64` (default 21,600;
bounds 3,600–172,800) · `attest_threshold u8` (must be 2 in v1) · **`launch_signer Pubkey`** (default
`Pubkey::default()` = no launch co-signer; otherwise `register_coin` needs its signature — off-chain review L1;
changed like every param: `queue_params` → 48 h → `execute_params`, guardian can cancel). `Params` = 168 bytes (was 136).

### 5.2 `Global` — PDA `["global"]`
`bump u8, admin Pubkey, platform_treasury Pubkey, guardian Pubkey, keepers [Pubkey;3], keeper_added_at [i64;3],
cluster_tag u8, paused u8, pause_expires_at i64, params Params, pending_params Params, pending_eta i64,
pending_admin Pubkey, pending_treasury Pubkey, pending_guardian Pubkey, pending_admin_eta i64, configs [Pubkey;8],
pending_config Pubkey, pending_config_add u8, pending_config_eta i64, operators [Pubkey;2]` (1,044 bytes, unchanged:
`Params` grew by 32 bytes twice and `operators` took the last 64 bytes of `reserved` at offset 980; **no reserved bytes
remain** — the next Global change grows the account through `migrate_global`).
Pause bits: `PAUSE_LAUNCH` 1, `PAUSE_TRADE` 2 (router buys, buybacks), `PAUSE_CLAIMS` 4, `PAUSE_GRADUATE` 8
(`migrate_pool`, `graduate`), `PAUSE_ATTEST` 16.

### 5.3 `Coin` — PDA `["coin", mint]`
`bump u8, status u8 (0 Curve, 1 Complete, 2 Graduated), launch_fees_settled u8, mint, creator, dbc_pool, dbc_config,
damm_pool, damm_position (Pubkey ×7 incl. mint/creator), launch_slot u64, launch_window_slots u64, created_at i64,
completed_at i64, graduated_at i64, total_supply u64, creator_fees_unclaimed u64, platform_fees_unclaimed u64,
buyback_lamports u64, fees_claimed_lamports u64, buyback_spent_lamports u64, buyback_tokens u64,
router_volume_lamports u64, router_trade_count u64, tickets_created u64, tokens_paid_out u64,
rewards RewardTerms {trigger_multiple_bps u32, claim_bps u16, max_claim_pool_bps u16, min_sell_usd_cents u64,
min_hold_secs i64, rebuy_window_secs i64, claim_window_secs i64, max_open_tickets u8},
fee_split {buyback_bps u16, platform_bps u16, creator_bps u16}, attest_cursor i64, attest_tokens_total u64,
attest_released_tokens u64, pregrad_sample_price_q64 u128, pregrad_sample_ts i64, migrator Pubkey,
migrator_cost u64, migration_fee_lamports u64, leftover_tokens u64, pregrad_ring PregradRing {prices_q64 [u64;5],
ts [u32;5], head u8, len u8} (62 bytes; prices saturate at u64::MAX, ts = unix seconds), reserved [u8;2]` (546 bytes
incl. discriminator; the ring sits at offset 482 where `reserved [u8;64]` started).
Lamport invariant: `lamports == rent_exempt_min + creator_fees_unclaimed + platform_fees_unclaimed +
buyback_lamports` (tested).
Rate cap (M-1: leaky bucket, defers, never rejects): `cap = max(1, total_supply × max_attest_tokens_per_hour_bps /
10,000)` tokens per 3,600 s. `attest_sell`: `cursor = max(attest_cursor, now) + ⌈tokens × 3600 / cap⌉`,
`effective_at = max(now, cursor − 3600)` (a full hour's cap is effective at once, the rest is spread at the cap
rate). `attest_rebuy` (debited tokens) and `void_ticket` (remaining tokens) release capacity when the coin has a
backlog (`attest_cursor > now`) and the ticket's `attested_at + 3600 > now`: `attest_cursor = max(now, attest_cursor −
⌊tokens × 3600 / cap⌋)` (re-used at the end of the backlog). `attest_tokens_total` / `attest_released_tokens` are
cumulative stats.

### 5.4 Config allow-list validation (`queue_config` add / `execute_config` / `register_coin`)
DBC `PoolConfig` (owner DBC, 1,048 bytes, discriminator `sha256("account:PoolConfig")[..8]`), byte offsets incl.
discriminator: `quote_mint@8 == WSOL`, `fee_claimer@40 == fee_claimer PDA`, `leftover_receiver@72 == reward_pool
PDA`, `collect_fee_mode@232 == 0` (quote), `migration_option@233 == 1` (DAMM v2), `activation_type@234 == 0`
(slot), `token_decimal@235 == 6`, `token_type@237 == 1` (Token-2022), `partner_permanent_locked@239 == 100`,
`partner_liquidity@240 == 0`, `creator_permanent_locked@241 == 0`, `creator_liquidity@242 == 0`,
`migration_fee_option@243 == 6` (Customizable), `fixed_token_supply_flag@244 == 1`,
`creator_trading_fee_percentage@245 == 0`, `token_update_authority@246 == 1` (Immutable),
`creator_migration_fee_percentage@248 == 0`, both liquidity-vesting infos (`@184`, `@200`, 16 B each) all zero,
locked vesting (`@296`, 40 B) all zero, `migrated_collect_fee_mode@360 == 0` (→ DAMM `OnlyB`),
`pre_migration_token_supply@344 == post_migration_token_supply@352`. Numeric curve/fee values (threshold,
`migration_fee_percentage@247`, base fee, migrated fee bps) are the admin's choice (timelocked).

### 5.5 `Position` — PDA `["position", mint, wallet]`
`bump u8, wallet Pubkey, mint Pubkey, next_ticket_seq u64, open_tickets [Pubkey;5], open_count u8,
auto_claim_opt_out u8, rent_payer Pubkey, tickets_created u64, reserved [u8;32]`.

### 5.6 `Ticket` — PDA `["ticket", mint, wallet, seq]`
`bump u8, owner Pubkey, mint Pubkey, seq u64, tokens u64, original_tokens u64, sell_price_q64 u128,
sell_usd_cents u64, sell_ts i64 (= attested block_time), status u8 (0 Open, 1 Queued, 2 Claimed, 3 Expired,
4 Voided, 5 Escrowed), queued_at i64, claim_amount u64, claimed_at i64, escrow_payer Pubkey, source u8 (0 Outside,
1 Router), venue u8 (0 DBC, 1 DAMM v2), attested_at i64 (**effective** attestation time: the `attest_sell` time, or
later when the rate cap deferred the ticket; claimable from `attested_at + ticket_challenge_secs`), rent_payer Pubkey,
consumed Pubkey, reserved [u8;16]`.

### 5.7 `Consumed`
`bump u8, kind u8 (0 sell, 1 rebuy, 2 sell reopened by the guardian), ticket Pubkey, rent_payer Pubkey,
block_time i64, message_hash [u8;16]` (sell markers: `sha256(284-byte message)[..16]` of the attestation that created
or last re-used it; zero for rebuy markers). 98 bytes.

### 5.8 `ClaimQueue`, `Observations` (zero-copy; unchanged from v0.6)
ClaimQueue: `mint Pubkey, len u16, bump u8, _pad [u8;5], total_owed u64, entries [QueueEntry{ticket, owner,
amount u64, sell_ts i64}; 1024]`. Observations: `mint, pool (= damm_pool), head u16, len u16, bump u8,
keeper_sampled u8, _pad [u8;2], last_keeper_sample_ts i64, samples [{ts i64, fallback u64, price_q64 u128}; 256]`.

## 6. Events (borsh fields in order)
- `GlobalInitialized { admin, platform_treasury, guardian, cluster_tag u8, params, ts }`
- `ParamsQueued { params, eta, ts }`, `ParamsUpdated { params, ts }`, `ParamsCancelled { authority, ts }`
- `PauseSet { paused u8, expires_at, authority, ts }`, `KeepersSet { keepers [Pubkey;3], added_at [i64;3], ts }`,
  `OperatorsSet { operators [Pubkey;2], ts }`
- `AdminProposed { admin, platform_treasury, guardian, eta, ts }`, `AdminAccepted { previous_admin, admin,
  platform_treasury, guardian, ts }`, `AdminProposalCancelled { authority, ts }`
- `ConfigQueued { config, add bool, eta, ts }`, `ConfigUpdated { config, add bool, ts }`,
  `ConfigCancelled { config, authority, ts }`, `GlobalMigrated { old_len u32, new_len u32, ts }`
- `CoinRegistered { mint, creator, dbc_pool, dbc_config, launch_slot, launch_window_slots, ts }`
- `RoutedTrade { mint, trader, venue u8, is_buy bool, base_amount u64, quote_gross u64, fee u64,
  pre_sqrt_price u128, post_sqrt_price u128, slot u64, ts }` — buy: `quote_gross` = WSOL spent (fee included);
  sell: WSOL received + fee. `fee` = Meteora trading + protocol fee of the swap (from pool counters).
- `CurveCompleted { mint, dbc_pool, ts }`
- `FeesClaimed { mint, venue u8, claimed u64, to_buyback u64, to_platform u64, to_creator u64, launch_window bool, ts }`
- `FeesWithdrawn { mint, recipient, lamports, creator bool, ts }`
- `UnregisteredFeesClaimed { mint, dbc_pool, dbc_config, claimed u64, platform_treasury, ts }`
- `PositionRewardClaimed { mint, damm_pool, damm_position, reward_index u8, reward_mint, destination, amount u64,
  to_reward_pool bool, ts }`
- `BuybackExecuted { mint, venue u8, lamports_in, tokens_out, guard_price_q64 u128, spot_price_q64 u128, ts }`
- `PoolMigrated { mint, damm_pool, migrator, cost u64, ts }`
- `Graduated { mint, damm_pool, damm_position, leftover_tokens, migration_fee u64, surplus u64, migrator_refund u64,
  caller_refund u64, setup_prefunded u64, platform_fee u64, ts }`
- `SampleRecorded { mint, venue u8, price_q64 u128, fallback bool, ts }`
- `TicketAttested { mint, owner, ticket, seq u64, pool, venue u8, source u8, signature [u8;64], ix_key u32,
  base_amount, quote_gross, tokens, sell_price_q64 u128, sell_usd_cents, pyth_publish_time i64, slot u64,
  sell_ts i64, keepers [Pubkey;2], submitter, ts, effective_at i64 }` (`effective_at` = `Ticket.attested_at`)
- `TicketDebited { ticket, mint, owner, signature [u8;64], ix_key u32, debited, remaining, voided bool, ts }`
- `TicketVoided { ticket, mint, owner, reason u8, authority, ts, coin, reopened bool }`
- `ConsumedClosed { consumed, ticket, rent_payer, ts }`
- `ClaimQueued { mint, ticket, owner, amount, queue_len u16, ts, triggered_by }`,
  `ClaimPaid { mint, ticket, owner, amount, from_queue bool, median_price_q64 u128, ts, triggered_by }`,
  `ClaimEscrowed { mint, ticket, owner, escrow, amount, ts, triggered_by }`,
  `EscrowWithdrawn { mint, ticket, owner, destination, amount, ts }`
- `TicketClosed { ticket, owner, final_status u8, rent_payer, ts }`, `PositionClosed { mint, wallet, ts }`,
  `AutoClaimSet { mint, wallet, enabled bool, ts }`

## 7. Error codes (Anchor custom errors, 6000 + index)
6000 Unauthorized · 6001 InvalidParams · 6002 Paused · 6003 MathOverflow · 6004 SlippageExceeded · 6005 ZeroAmount
· 6006 InvalidAccount · 6007 WrongCoinStatus · 6008 WrongVenue · 6009 ConfigNotAllowed · 6010 InvalidConfig ·
6011 ConfigListFull · 6012 NoPendingParams · 6013 NoPendingConfig · 6014 NoPendingAdmin · 6015 TimelockNotElapsed
· 6016 UnsupportedGlobalLayout · 6017 PoolNotFresh · 6018 NotMigrated · 6019 InvalidMigratedPool ·
6020 LaunchWindowActive · 6021 NothingToClaim · 6022 LaunchFeesUnsettled · 6023 NothingToBuyBack ·
6024 PriceDeviation · 6025 StaleSample · 6026 InsufficientSamples · 6027 SampleTooSoon · 6028 SampleTxNotIsolated ·
6029 WouldCompleteCurve (reserved: buybacks cap the slice instead) · 6030 MissingAttestation · 6031 InvalidAttestation · 6032 NotEnoughKeeperSignatures ·
6033 AttestationExpired · 6034 WrongCluster · 6035 PoolNotOfCoin · 6036 CreatorSell · 6037 BelowMinimumUsd ·
6038 InvalidTicketAmount · 6039 StalePythPrice · 6040 AttestRateLimited (reserved: no longer returned, M-1) ·
6041 TooManyOpenTickets ·
6042 AlreadyConsumed · 6043 ChallengeWindowOver · 6044 TicketInChallenge · 6045 TicketNotOpen · 6046 TicketExpired
· 6047 TriggerNotMet · 6048 QueueFull · 6049 WalletQueueLimit · 6050 QueueAccountRequired · 6051 NoEscrow ·
6052 AutoClaimDisabled · 6053 TicketNotClosable · 6054 ConsumedNotClosable · 6055 PositionNotEmpty ·
6056 LamportInvariant · 6057 RebuyOutOfWindow · 6058 PoolDisabled · **6059 TicketPriceBelowExecution ·
6060 KeeperOperatorOverlap · 6061 PoolIsRegistered**.

## 8. Changelog
### 2026-10-13 d — pre-audit fixes: operators, DAMM pool status, D12 price floor, stranded value (services follow)
1. **Operators.** `Global.reserved [u8;64]` → `operators [Pubkey;2]` (same offset 980, Global still 1,044 bytes).
   `record_samples` keeper samples, `claim_for` and pre-graduation `execute_buyback` require an operator (were: a
   keeper); `attest_sell` / `attest_rebuy` still require a keeper (attestor) submitter and attestor signatures.
   `initialize_global` takes a trailing `operators: Vec<Pubkey>` arg (0–2); new `set_operators(operators)` (admin,
   immediate, `OperatorsSet`); keepers and operators are disjoint (`KeeperOperatorOverlap` in `initialize_global`,
   `set_operators`, `set_keepers`). `migrate_global` on a pre-operators Global fills `operators[0] = keepers[0]`.
   SDK: `GlobalAccount.operators`, `isOperator` / `isAttestor` / `keyRole`, `setOperatorsIx`, `initializeGlobalIx({
   operators })`. Keeper: jobs mode runs only with an operator key, attestor mode never with one.
2. **DAMM v2 pool status.** `record_samples` skips a disabled pool (no sample); `execute_buyback` (graduated) →
   `PoolDisabled`; claims wait (median coverage). The router already refused (`PoolDisabled`).
3. **`attest_sell`**: `ticket_price_q64 ≥ ⌊quote_gross × 2⁶⁴ / base_amount⌋`, else `TicketPriceBelowExecution`.
4. **New instructions** `claim_unregistered_fees` (unregistered pools' partner fees → platform treasury) and
   `claim_position_rewards(reward_index)` (DAMM v2 farming rewards → the coin's reward vault / the treasury's ATA).
   Events `UnregisteredFeesClaimed`, `PositionRewardClaimed`. Errors 6059–6061 appended.

### 2026-10-13 c — pre-graduation buyback guard on a median of keeper samples (security-review L5)
1. `Coin.reserved [u8;64]` → `pregrad_ring PregradRing (62 B) + reserved [u8;2]` (same size and offsets). Zeroed bytes
   = empty ring, so existing Coins decode unchanged.
2. `record_samples` (`Curve`) also pushes the sample into `pregrad_ring`.
3. `execute_buyback` (`Curve`): guard price = ring median (≥ 4 samples within 300 s spanning ≥ 60 s, else
   `InsufficientSamples`); spot must be within the band of the median AND of the latest sample. `BuybackExecuted.
   guard_price_q64` is the median. Constants `PREGRAD_RING_LEN 5`, `PREGRAD_WINDOW_SECS 300`, `PREGRAD_MIN_SAMPLES 4`,
   `PREGRAD_MIN_SPAN_SECS 60` (not params). No instruction/account-list/event/error change. SDK: `CoinAccount.
   pregradRing`, `pregradMedianQ64`; keeper skips pre-grad buybacks until the ring is warm.

### 2026-10-13 b — bootstrap keepers + configs in `initialize_global` (devnet/mainnet deploy; services follow)
1. `initialize_global` takes a trailing arg `keepers: [Pubkey; 3]` and the initial DBC configs as remaining accounts
   (0–8, read-only, validated like `execute_config` add). Bootstrap keepers get `keeper_added_at = 0` and attest at
   once; bootstrap configs are allow-listed at once. Extra events `KeepersSet` + `ConfigUpdated` in the init tx.
2. Active attester rule: `keeper_added_at == 0 || now ≥ keeper_added_at + 6h`; `set_keepers` stores `max(now, 1)`
   for new keys. SDK `activeKeepers` follows. No account layout change.

### 2026-10-13 — fixes of `REVIEW-v0.7.md` + off-chain review L1/L3 (services / app must follow)
1. `register_coin`: optional trailing account `launch_signer` (signer) before the event-CPI pair; required when the
   new param `Params.launch_signer` (appended Pubkey; `Params` 136 → 168 bytes, `Global.reserved` 128 → 64, Global
   still 1,044) is set. Clients pass the fumpad program id when unset. `initialize_global` / `queue_params` /
   `ParamsQueued` / `ParamsUpdated` / `GlobalInitialized` carry the longer `Params`.
2. `void_ticket(reason u8, reopen bool)`: new arg `reopen`; accounts now authority, global, **coin (w), mint**,
   ticket (w), position (w), **consumed (w)** [ev]. `TicketVoided` + trailing `coin Pubkey, reopened bool`.
3. `attest_rebuy`: `coin` is now writable.
4. `attest_sell` never returns `AttestRateLimited`; `Ticket.attested_at` / new trailing `TicketAttested.effective_at`
   = effective time (may be in the future). Claimability and the void window run from it. Accepts a reopened marker.
5. `Coin`: `attest_bucket_start/attest_bucket_tokens/attest_prev_bucket_tokens` → `attest_cursor i64,
   attest_tokens_total u64, attest_released_tokens u64` (same offsets, same size).
6. `Consumed`: + `message_hash [u8;16]` (82 → 98 bytes); `kind = 2` = reopened sell marker.
7. `close_position`: the rent payer may sign only while `auto_claim_opt_out == 0`.
8. `claim_lp_fees`: `damm_position` may be any `fee_claimer`-held position of the coin's pool (no `has_one`).
9. `graduate`: no pool-share check; `leftover_tokens` recorded when a third party withdrew the leftover;
   `Graduated.surplus` excludes a pre-funded `fee_wsol` balance (returned to the caller).
10. Router: `PoolDisabled` (6058) for a disabled DAMM v2 pool. `record_samples`: `Complete` coins skipped.
