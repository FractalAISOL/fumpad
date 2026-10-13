# FUMPAD v0.7 — architecture for auditors

Commit `aa137a9`. Byte-level details (account layouts, offsets, instruction account lists, events, error codes) are
in `contracts/INTERFACE-v0.7.md`; this file explains how the pieces fit and who can do what. "Coin" below means the
per-mint `Coin` account and everything FUMPAD holds for that mint.

## 1. Components

| # | Component | Where | Trust level |
|---|---|---|---|
| 1 | **fumpad program** (Anchor 1.2.1, upgradeable) | `contracts/programs/fumpad` | the system; upgrade authority = admin multisig (mainnet plan) |
| 2 | **Meteora DBC** (bonding curve) + **DAMM v2** (AMM) | external, mainnet ids in README §3 | trusted (D38); upgradeable by Meteora |
| 3 | **Token-2022 coin mint** | created by DBC `initialize_virtual_pool_with_token2022`; vanity `…fmbL` key from the API | no mint / freeze / metadata authority (config enforces `Immutable`) |
| 4 | **Attestors ×3** (`KEEPER_MODE=attestor`) | `services/keeper/src/attest` | each holds one keeper key in `Global.keepers`; any 2 together can create tickets |
| 5 | **Jobs keeper** (`KEEPER_MODE=jobs`) | `services/keeper/src/keeper.ts` | uses the attestor-1 key (3 keeper slots only; DEPLOY-v07 §1) |
| 6 | **Watcher** (`KEEPER_MODE=watcher`) | `services/keeper/src/watch` | no key; own RPC; alerts the guardian chat on any mismatch |
| 7 | **Signature board** | Postgres tables `attest_signatures`, `attest_hints`, per-attestor DB roles + RLS | untrusted transport: signatures are verified, hints only delay (≤ 90 s) |
| 8 | **Indexer + API** | `services/indexer`, `services/api` | untrusted for chain truth; the API holds the **launch co-signer key** and decrypts vanity-mint secrets |
| 9 | **App** (Next.js) + **Privy embedded "Trading wallet"** | `app/` | the embedded wallet signs silently only allow-listed transactions (`app/src/chain/allowlist.ts`) |
| 10 | **Squads v4 multisigs** | admin 3-of-5 + 48 h time lock (also upgrade authority); guardian 2-of-3, no time lock | governance |
| 11 | **Pyth Hermes** (historical SOL/USD) | off-chain input to the engine | trusted for the $50 threshold only |
| 12 | **RPC providers** | one per attestor + one for the watcher | each trusted only by the process that uses it |

## 2. Trust boundaries

```
                      ┌──────────────────────────── Solana (consensus = source of truth) ─────────────────────────────┐
                      │                                                                                                │
  any wallet / app ───┼──swap──► Meteora DBC pool ──migration──► Meteora DAMM v2 pool                                  │
  (Jupiter, Axiom,    │            ▲   partner fees, leftover,         ▲  LP NFT (100% perm. locked) held by           │
   bots, direct)      │            │   migration fee, surplus          │  PDA fee_claimer; position fees               │
                      │            │ (fee_claimer / reward_pool        │                                               │
  FUMPAD app ─────────┼─► fumpad.buy/sell (user-signed CPI, no PDA)    │                                               │
  (Privy wallet,      │            │                                   │                                               │
   allow-listed)      │   ┌────────┴───────────────────────────────────┴─────────────────────────────┐                │
                      │   │ fumpad program                                                           │                │
                      │   │  Global · Coin[mint] · Position · Ticket · Consumed · ClaimQueue · Obs.  │                │
                      │   │  PDA signers: fee_claimer, fee_wsol, reward_pool, buyback, event auth.   │                │
                      │   └──▲───────────────▲───────────────────▲───────────────────▲───────────────┘                │
                      │      │ admin ix      │ guardian ix       │ [Ed25519 ×2 + attest_*]    │ keeper-only ix     │
                      └──────┼───────────────┼───────────────────┼───────────────────┼──────────────────────────────┘
       ══ B1 ═══════════════ │ ═════════════ │ ════════ B2 ══════ │ ═══════════════════│═══════════════════════════════
             Squads admin    │   Squads      │                    │                    │
             3-of-5 + 48 h ──┘   guardian ───┘          attestor-1 ── attestor-2 ── attestor-3      jobs keeper
                                 2-of-3                   │ own RPC A   │ own RPC B   │ own RPC C   (= attestor-1 key)
                                   ▲                      │             │             │
                                   │ alerts               └──── signature board (Postgres, RLS) ───┘
                                 watcher (own RPC D) ── re-derives every TicketAttested / TicketDebited
       ══ B3 ════════════════════════════════════════════════════════════════════════════════════════════════════════
         Pyth Hermes (same source for all attestors + watcher)        indexer / API / DB (no chain authority;
                                                                       API holds the launch co-signer key)
       ══ B4 ════════════════════════════════════════════════════════════════════════════════════════════════════════
         app + Privy embedded wallet: silent signing only for allow-listed transactions
```

- **B1 (governance):** changes to params, the DBC-config allow-list and admin / treasury / guardian wait 48 h on
  chain (plus the admin multisig's 48 h Squads time lock = ≥ 96 h end to end on mainnet). The guardian can cancel
  them, pause, and void tickets.
- **B2 (attestation):** the program cannot see trades. It trusts any message signed by 2 distinct active keeper
  keys. Bounds: challenge window, guardian void, per-coin rate cap (defers), `PAUSE_ATTEST`, replay markers, record
  binding to program id / cluster / mint / pool / creator, max age. The watcher is the detection mechanism.
- **B3 (off-chain inputs):** each attestor uses only its own RPC at `finalized`; Hermes is common to all.
  The indexer / API / DB are never chain truth for keepers or the watcher.
- **B4 (wallet):** see README §2.3.

## 3. PDAs and other program-controlled accounts

Seeds are byte strings; `mint` = the coin's mint; derived addresses for the devnet id are in INTERFACE §1.

| Account | Seeds / address | Type, owner | Created by (rent payer) | Who can make the program sign / write for it, and for what |
|---|---|---|---|---|
| `global` | `["global"]` | `Global`, fumpad | `initialize_global` (upgrade authority) | written by admin / guardian / permissionless execute ixs (§6) |
| `coin` | `["coin", mint]` | `Coin`, fumpad; holds creator / platform / buyback lamports | `register_coin` (creator) | lamports leave only via `withdraw_creator_fees` (creator), `withdraw_platform_fees` (→ `Global.platform_treasury`), `execute_buyback` (→ `buyback` PDA → its WSOL ATA → swap) |
| `fee_claimer` | `["fee_claimer"]` | system account, no data | never created; holds lamports only transiently inside one ix | signs DBC `claim_trading_fee`, `withdraw_migration_fee` (partner), `partner_withdraw_surplus` (in `claim_fees` / `graduate`) and DAMM `claim_position_fee` (in `claim_lp_fees`), each with an exact pinned account list; signs `fee_wsol` close and system transfers out of itself. It is the DBC config's `fee_claimer` and the owner of every coin's DAMM v2 position NFT (NFT account `PDA_DAMM["position_nft_account", nft_mint]`). It never signs a DAMM liquidity / lock / transfer instruction. |
| `fee_wsol` | `["fee_wsol"]` | SPL-Token WSOL account, authority `fee_claimer` | created and closed inside `claim_fees`, `claim_lp_fees`, `graduate` (caller advances rent, refunded in the same ix) | never exists between instructions; a lamport pre-fund is tolerated (counted as claimed in `claim_fees`; excluded from the budget and returned in `graduate`) |
| `reward_pool` | `["reward_pool"]` | system account, no data | never created | authority of every reward vault and every escrow. Signs Token-2022 `transfer_checked` out of `ATA(reward_pool, coin.mint)` in `claim` / `claim_for` / `process_queue` (to the ticket owner's account or the ticket's escrow) and out of an escrow in `withdraw_escrow` (to an owner account) + escrow close. DBC config `leftover_receiver`. |
| reward vault | `ATA(reward_pool, mint, Token-2022)` | Token-2022 account | `register_coin` (creator, idempotent) | inflows: DBC `withdraw_leftover` (8%), buybacks, donations, DBC/DAMM base-side fee claims (0 in quote / `OnlyB` mode); outflows: claims only |
| `buyback` | `["buyback"]` | system account, no data | never created | signs DBC / DAMM `swap2` as payer in `execute_buyback` with an exact pinned 15 / 14-account list (input = its WSOL ATA, output = the coin's reward vault, referral None); receives Coin lamports and wraps them |
| buyback WSOL | `ATA(buyback, WSOL)` | SPL-Token account, shared by all coins | `execute_buyback` (`init_if_needed`, cranker) | holds only swap rounding dust between buybacks (never credited to any coin) |
| `position` | `["position", mint, wallet]` | `Position` (open-ticket list ≤ 5, seq counter, auto-claim opt-out, `rent_payer`) | `attest_sell` (attesting keeper) | closed by the wallet, or by `rent_payer` only while `auto_claim_opt_out == 0` (REVIEW-v0.7 L-1); rent → `rent_payer` |
| `ticket` | `["ticket", mint, wallet, seq u64 LE]` | `Ticket` | `attest_sell` (keeper) | status changes only through the rules in §5.2; `close_ticket` (anyone, terminal states) → rent to `rent_payer` |
| `consumed` (sell) | `["consumed", sha256(tx_sig), ix_key u32 LE]` | `Consumed` (kind, ticket, rent_payer, block_time, message_hash) | `attest_sell` (keeper) | `void_ticket(reopen=true)` sets kind 2 (re-attestable once with a different message); `close_consumed` (anyone) only when the ticket account is gone AND `now > block_time + 7 d` |
| `consumed` (rebuy) | `["consumed", sha256(tx_sig), ix_key, ticket]` | `Consumed` kind 1 | `attest_rebuy` (keeper) | same close rule |
| `claim_queue` | `["claim_queue", mint]` | zero-copy, 81,976 B, 1024 entries | rent pre-funded by `graduate`; `init_claim_queue` ×9 (anyone, Graduated only) | modified by claim, claim_for, process_queue, attest_rebuy (queued tickets), close_ticket |
| `observations` | `["observations", mint]` | zero-copy ring, 256 samples | pre-funded by `graduate`; `init_observations` (anyone, Graduated only) | written by `record_samples` |
| `escrow` | `["escrow", ticket]` | Token-2022 account, authority `reward_pool` | `process_queue` cranker or `claim_for` keeper (`Ticket.escrow_payer`) | emptied only by `withdraw_escrow` (owner-signed) |
| event authority | `["__event_authority"]` | Anchor `emit_cpi` | — | signs the event self-CPI only |

External accounts the program trusts by address or derivation (never by caller choice): DBC pool / config pinned in
`Coin` (`has_one`), vaults read from the pinned pool, DAMM pool = PDA of (a DAMM config whose
`pool_creator_authority` = DBC pool authority, mint, WSOL) checked once in `graduate` and pinned in `Coin.damm_pool`,
WSOL mint, DBC / DAMM program ids and their pool / event authorities (constants).

## 4. Fund flows

### 4.1 Trading fees (any app, both venues)

```
swap on a FUMPAD DBC / DAMM v2 pool  ── 1.25% fee (DBC: 99% → 1.25% over 8 slots after activation) ──┐
                                                                                                        │
   Meteora protocol share 20%  ◄────────────────────────────────────────────────────────────────────────┤ (Meteora's)
   partner (DBC) / locked position (DAMM v2) 80%  = 1.00% of volume, accrues in the Meteora pool ◄──────┘
        │ claim_fees (DBC, permissionless)  /  claim_lp_fees (DAMM v2, permissionless, Graduated + launch flag set)
        │ fee_claimer signs → WSOL into transient fee_wsol → closed into fee_claimer → system transfer
        ▼
   Coin account lamports, credited to its ledgers:
     first claim_fees with slot ≥ launch_slot + launch_window_slots (D33):  100% → buyback_lamports
     every later claim:  platform = ⌊x·30%⌋, creator = ⌊x·20%⌋, buyback = x − platform − creator  (split snapshotted per coin)
        │                         │                               │
        │ withdraw_platform_fees  │ withdraw_creator_fees          │ execute_buyback (§4.3)
        ▼ (anyone → treasury)     ▼ (creator signs)                ▼
   Global.platform_treasury   Coin.creator                    reward vault (tokens)
```

`claim_fees` before `launch_slot + launch_window_slots` fails (`LaunchWindowActive`), so nobody can settle the
launch flag early; a late first claim only moves more fees to the buyback (D33). DBC creator fee share is 0 by
config (checked); FUMPAD pays the creator from its own share.

### 4.2 Graduation (D34 / D35)

```
DBC curve reaches its quote threshold (85 SOL mainnet) ─► anyone: DBC migration_damm_v2 (or fumpad.migrate_pool,
                                                          which records the caller's measured flash-rent cost)
   ├─ DAMM v2 pool created by DBC's pool authority; 100% of the partner LP permanently locked, NFT → fee_claimer
   └─ DBC holds for the partner: 1% migration fee + any quote surplus
fumpad.graduate (anyone, idempotent per step):
   1. verify DBC migrated; verify DAMM pool PDA / mints / creator; verify a position of that pool with NFT held by
      fee_claimer, unlocked = vested = 0, permanent_locked > 0 (no comparison with pool totals; REVIEW-v0.7 H-1)
   2. withdraw_leftover (if not already done by anyone) → reward vault receives 8% of supply (80,000,000.000000 tokens
      on a one-swap completion; real paths add rounding dust on top, never less)
   3. withdraw_migration_fee (partner) + partner_withdraw_surplus → fee_wsol → fee_claimer  = "setup budget"
   4. budget spent in order: migrator refund (Coin.migrator_cost, capped) → caller's own net rent for this ix →
      observations PDA rent (pre-fund) → claim-queue PDA rent (pre-fund) → remainder → Coin.platform_fees_unclaimed
      invariant: migrator_refund + caller_refund + setup_prefunded + platform_fee = migration_fee + surplus
   5. Coin.status = Graduated, damm_pool / damm_position recorded
```

### 4.3 Buybacks

`execute_buyback(max_in)`: `spend = min(max_in, Coin.buyback_lamports, slice cap)`; Coin lamports → `buyback` PDA →
`ATA(buyback, WSOL)` (wrapped) → venue `swap2` (ExactIn, `min_out` = fair amount at the guard price less band +
2% venue allowance + 2 × slice) → tokens into the coin's reward vault. Guards:

| | Pre-graduation (`Curve`) | Post-graduation (`Graduated`) |
|---|---|---|
| Caller | keeper only | anyone |
| Timing | after the launch window | — |
| Guard price | median of `Coin.pregrad_ring` (≥ 4 keeper samples within 300 s spanning ≥ 60 s); spot within ±band of the median AND of the latest sample (≤ 60 s old) | 30-min median of keeper samples (≥ `oracle_min_samples`, 5 of 6 buckets); spot within ±band |
| Slice | ≤ `buyback_max_pool_bps` (0.5%) of the curve's quote reserve, and never reaching the migration threshold | ≤ 0.5% of the pool's `token_b_amount` |

### 4.4 Claims, queue, escrow

```
reward vault ──(reward_pool signs)──► owner's token account (claim: any owner account; claim_for / process_queue:
                                       the owner's canonical ATA) — or — escrow ["escrow", ticket] (owner's ATA
                                       missing / frozen / memo-required) ──withdraw_escrow (owner)──► owner account
amount = ⌊ticket.tokens × claim_bps / 10,000⌋ (10%); paid now iff amount ≤ 10% of the vault balance and no older
fitting queue entry; else queued (≤ 2 entries per wallet per coin, 1024 per coin, skip-ahead, never expire).
```

### 4.5 Rent flows

| Rent | Paid by | Returned to | When |
|---|---|---|---|
| Coin, reward vault | creator | — (permanent) | |
| Position, Ticket, Consumed | attesting keeper (`rent_payer`) | `rent_payer` | `close_position`, `close_ticket`, `close_consumed` |
| Escrow | cranker / `claim_for` keeper (`escrow_payer`) | `escrow_payer` | `withdraw_escrow` |
| Observations, ClaimQueue | pre-funded from the migration fee by `graduate` | — (permanent) | |
| `fee_wsol` | caller of `claim_fees` / `claim_lp_fees` / `graduate` | caller, same ix | |
| buyback WSOL ATA | first cranker | — | |

## 5. State machines

### 5.1 Coin

```
              register_coin                      router buy completes the curve (DBC migration_progress ≥ 2)
   (none) ─────────────────► Curve ─────────────────────────────────────────────────────► Complete
                               │                                                              │
                               │ graduate (requires DBC is_migrated == 1, progress == 3)      │ graduate
                               └───────────────────────────► Graduated ◄──────────────────────┘
```
A third-party completion leaves the coin in `Curve` until `graduate`. Router: DBC while `Curve`, DAMM v2 while
`Graduated`, refused in `Complete`. Tickets are attested in every status (DBC sells before completion keep being
attested after it). Claims, observations, post-grad buybacks and `claim_lp_fees` require `Graduated`.

### 5.2 Ticket

```
attest_sell ─► Open ──claim / claim_for (paid now)──────────────────────────────► Claimed ──close_ticket─► (closed)
                │  ├─claim / claim_for (doesn't fit) ─► Queued ──process_queue──► Claimed
                │  │                                     │   └──process_queue (refusing ATA)─► Escrowed ──withdraw_escrow─► Claimed
                │  ├─claim_for (refusing ATA) ─────────────────────────────────► Escrowed
                │  ├─attest_rebuy to 0 tokens / 0 owed ─► Voided ──close_ticket─► (closed)
                │  ├─void_ticket (guardian/admin, now < attested_at + challenge) ─► Voided
                │  └─close_ticket after sell_ts + claim_window ─► Expired (closed)
                └─ Queued ─attest_rebuy to 0─► Voided (queue entry removed in the same ix)
```
`attested_at` is the **effective** time (≥ attest time; later when the rate cap defers). Claimable from
`attested_at + ticket_challenge_secs`. Queued and Escrowed tickets are never closable and never expire (D5).

### 5.3 Replay marker (`Consumed`)
`(none) ─attest_sell→ kind 0 (sell) ─void_ticket(reopen)→ kind 2 ─attest_sell (different message hash)→ kind 0`;
`(none) ─attest_rebuy→ kind 1`. Closable when the referenced ticket is no longer a live fumpad account and
`now > block_time + MAX_MAX_ATTEST_AGE_SECS (7 d)`; since every attestation older than `max_attest_age_secs`
(≤ 7 d by bound) is rejected, a closed marker cannot be replayed.

## 6. Admin, guardian, timelocks, pauses

| Action | Who | Delay | Notes |
|---|---|---|---|
| `initialize_global` | program upgrade authority (checked via ProgramData) | — | sets admin = guardian, treasury, `cluster_tag` (any u8, immutable), params (validated), bootstrap keepers (no 6 h freeze), bootstrap DBC configs (validated, no 48 h) |
| `queue_params` → `execute_params` | admin → anyone | 48 h | `Params::is_valid` bounds every field (SPEC §6.2 + v0.7 attestation params); reward terms and fee split are snapshotted per coin at `register_coin`; oracle / buyback / attestation params (`ticket_challenge_secs`, `max_attest_age_secs`, rate cap, `launch_signer`) are global |
| `cancel_params` | admin or guardian | immediate | |
| `queue_config` → `execute_config` (add / remove a DBC config) | admin → anyone | 48 h | add re-validated at queue and execute; removal doesn't affect registered coins |
| `cancel_config` | admin or guardian | immediate | |
| `propose_admin(admin, treasury, guardian)` → `accept_admin` | admin → the new admin key signs | 48 h | `cancel_admin` by admin or guardian |
| `set_keepers` | admin | immediate | new keys can't count toward attestations for 6 h; remaining keys keep their timestamp |
| `set_pause(bits)` | admin or guardian | immediate | non-zero lapses after 7 d unless renewed; 0 unpauses |
| `void_ticket(reason, reopen)` | guardian or admin | only inside the ticket's challenge window, `Open` tickets | `reopen = true` lets one corrected attestation of the same trade follow |
| `migrate_global` | admin | — | no-op on the current layout (D39: fresh layouts; mechanism kept) |
| program upgrade | upgrade authority (admin Squads vault, 48 h Squads time lock) | 48 h (Squads) | can replace everything; the on-chain timelocks are meaningful only with the Squads time lock |

Pause flags (`Global.paused`, in force only while `now < pause_expires_at`):

| Bit | Flag | Stops | Never stopped by any flag |
|---|---|---|---|
| 1 | `PAUSE_LAUNCH` | `register_coin` | router `sell`; `claim_fees`, `claim_lp_fees`; `withdraw_creator_fees`, `withdraw_platform_fees`; `record_samples`; `void_ticket`; `close_*`; `set_auto_claim`; `init_*`; trading on Meteora itself |
| 2 | `PAUSE_TRADE` | router `buy`, `execute_buyback` | |
| 4 | `PAUSE_CLAIMS` | `claim`, `claim_for`, `process_queue`, `withdraw_escrow` | |
| 8 | `PAUSE_GRADUATE` | `migrate_pool`, `graduate` (never Meteora's own migration) | |
| 16 | `PAUSE_ATTEST` | `attest_sell`, `attest_rebuy` | |

Planned mainnet roles (`services/MULTISIG.md`): admin = Squads vault, 3-of-5 Ledger voters + an ops key that can
only initiate / execute, 48 h Squads time lock, `configAuthority = null`; guardian = Squads vault, 2-of-3, no time
lock; upgrade authority = admin vault (transferred only after `accept_admin` executed through the vault); treasury
= a Squads vault or hardware wallet.

## 7. Keeper powers and limits

On-chain, a "keeper" is any key in `Global.keepers` (3 slots). The jobs keeper shares the attestor-1 key.

| Power | Instruction | Limit enforced on chain |
|---|---|---|
| Co-sign tickets (2 distinct active keys needed) | Ed25519 + `attest_sell` | record binding (program id, cluster tag, coin, its DBC / recorded DAMM pool, trader ≠ creator / default, `usd_cents ≥ min`, `0 < ticket_tokens ≤ base_amount`, `quote_gross > 0`, `price > 0`, `slot ≥ launch_slot`, `block_time ∈ [created_at − 60 s, now + 60 s]`, age ≤ `max_attest_age_secs`, Pyth age ≤ `max_price_age_secs`), replay marker, ≤ 5 open per wallet, rate cap (defers), challenge window, guardian void, `PAUSE_ATTEST`. **Not** checked on chain: that the trade exists, hold time, rebuys, the D10/D12 price, the USD value. |
| Co-sign rebuy debits | Ed25519 + `attest_rebuy` | ticket / mint / owner binding, `Open|Queued`, `sell_ts ≤ block_time ≤ sell_ts + rebuy_window`, age, one debit per (trade, ticket), debit ≤ ticket tokens. Can only lower or void tickets. |
| Submit attestations (fee payer, pays rent) | `attest_*` | submitter must be a keeper; signatures decide |
| Price samples | `record_samples` | price is read from the pool account, never supplied; spacing ≥ `oracle_min_spacing_secs`; the transaction may contain only compute-budget instructions besides it; pre-grad samples keeper-only; post-grad samples permissionless only after `keeper_stale_secs` without a keeper sample, and those (fallback) never count for medians. A keeper controls **timing** only. |
| Pre-graduation buybacks | `execute_buyback` (Curve) | guards in §4.3; spends only the coin's own buyback balance into its own reward vault |
| Auto-claim | `claim_for` | same rules as `claim`; payout only to the owner's canonical ATA or the ticket's escrow; respects opt-out |
| Close a Position it paid for | `close_position` | only while the wallet hasn't opted out of auto-claim |

Permissionless cranks anyone may run (keepers do): `claim_fees`, `claim_lp_fees`, `migrate_pool`, `graduate`,
`init_observations`, `init_claim_queue`, post-grad `execute_buyback`, `process_queue`, `close_ticket`,
`close_consumed`, `execute_params`, `execute_config`, `withdraw_platform_fees`.

## 8. Off-chain attestation pipeline (scope B)

1. **Crawl** (`engine/src/fetch.ts`, `keeper/src/attest/derive.ts`): from the attestor's own RPC, `finalized` only,
   every signature touching the mint, its token accounts, the Coin PDA and attested ticket PDAs; incremental cursors;
   L8 guard refuses coins older than the RPC's first available block.
2. **Parse** (`meteora/src/parse.ts`, `vaultflow.ts`): only DBC / DAMM v2 self-CPI events signed by the program's
   `__event_authority` whose CPI parent is a `swap`/`swap2` of the same program; amounts cross-checked against pool
   vault balance deltas (non-swap vault movements in the tx accounted); trader attribution must be
   `base_owner_signer` or `signer_net_base`; anything else is an issue scoped to that transaction.
3. **Engine** (`engine/src/engine.ts`, `rules/*`): total order (slot, tx index in block, ix_key); per-wallet
   hold buckets (pending first, Clarification 21), rebuy rule (7 d, newest ticket first, buys and incoming
   transfers), D10 reference (10-min TWAP over every swap on the coin's pools) and D12 floor (ticket price =
   max(execution, ⌈reference × max(execution ÷ pre-trade spot, 0.9)⌉)), USD = ticket tokens × price at the Pyth
   update with greatest `publish_time ≤ block_time` (|Δ| ≤ 60 s), lower confidence bound; output canonical bytes.
4. **Records** (`keeper/src/attest/records.ts`): sells → 284-byte messages, rebuy debits → 236-byte messages (only
   once the ticket PDA is known on chain); DAMM sells only after `Coin.damm_pool` is recorded.
5. **Sign + exchange** (`board.ts`): each attestor signs its own derivation and publishes `(message, signature)` on
   the board; it submits `[Ed25519(2 sigs), attest_*]` only when another **active** keeper's valid signature over the
   identical bytes exists. Designated submitter = lowest key; others after a fallback delay. "Landed" = the consumed
   marker exists at `finalized`.
6. **Watch** (`keeper/src/watch`): an independent process on a 4th RPC re-derives every coin and compares every
   `TicketAttested` / `TicketDebited` field by field; mismatches, sells never attested and engine issues alert the
   guardian chat; the feed is served at `/v1/verification`.
