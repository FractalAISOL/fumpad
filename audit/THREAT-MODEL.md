# FUMPAD v0.7 — threat model

Commit: this branch (`aa137a9` + the pre-audit fixes listed in PRIOR-REVIEWS §0). Companion to `ARCHITECTURE.md` (roles, PDAs, flows). "Pool" = a coin's reward vault unless it says
DBC / DAMM pool. Test names refer to `contracts/tests/src` (LiteSVM) or `services/*/test` (vitest); the full map is
`TEST-COVERAGE.md`.

## 1. Assets

| # | Asset | Where it lives | Normal outflows |
|---|---|---|---|
| A1 | Reward-pool tokens of each coin (8% leftover + buybacks) | `ATA(reward_pool, mint)` | claims to ticket owners / their escrows |
| A2 | Escrowed payouts | `["escrow", ticket]` | `withdraw_escrow` by the ticket owner |
| A3 | Coin lamports: creator fees, platform fees, buyback balance | `Coin` account | creator, `platform_treasury`, buybacks |
| A4 | Unclaimed partner trading fees, migration fee, surplus | inside Meteora DBC pools, claimable by `fee_claimer` | `claim_fees`, `graduate`; pools that never registered: `claim_unregistered_fees` (trading fees → treasury) |
| A5 | The 100% permanently locked DAMM v2 LP position (NFT held by `fee_claimer`), its fee stream and any farming rewards | DAMM v2 position + NFT account | `claim_lp_fees` (fees), `claim_position_rewards` (rewards → reward vault / treasury ATA); principal is locked by Meteora forever |
| A6 | Ticket integrity — the right to claim (tokens, price, owner, effective time) | `Ticket`, `Position`, `Consumed`, `ClaimQueue` | claims |
| A7 | Governance state: params, DBC-config allow-list, keeper (attestor) set, operator set, admin / treasury / guardian, pauses | `Global` | timelocked changes |
| A8 | Program upgrade authority | BPF upgradeable loader | Squads proposal + 6 h |
| A9 | Attestor keys (3; rent for positions / tickets / markers) and the operator key (jobs keeper: samples, buybacks, auto-claim, escrow rent, graduation setup float) and their SOL | 3 attestor hosts (separate projects / accounts / providers) + the jobs host | rent, fees; rent refunded on close |
| A10 | Launch co-signer key, vanity-mint secrets | API host / Postgres (encrypted) | register-coin co-signature |
| A11 | User funds while trading through FUMPAD (router) and in the Privy embedded wallet | user token accounts | user-signed swaps |
| A12 | Oracle integrity: keeper samples and their medians | `Observations`, `Coin.pregrad_ring` | gates claims and buybacks |

## 2. Actors and capabilities

| Actor | Capabilities | Must NOT be able to | Main controls | Residual / accepted |
|---|---|---|---|---|
| **Anonymous trader** | swap on any app, call every permissionless ix, send lamports / tokens to any address (incl. PDAs), create DAMM positions and add / lock liquidity in our pools, call DBC `withdraw_leftover` / `migration_damm_v2` directly | move A1–A5 anywhere other than their designated destinations; block graduation, fee claims, claims, samples; get a ticket for a sell that doesn't qualify | PDA seeds + `has_one`; pinned CPI account lists; exact-account checks; pre-funded-PDA tolerance (`create_pda_account`); H-1 fix (position identity, not pool share) | rate-limit / RPC cost of spam accounts on keepers (V7-M6 residual: open accounts cost one call per tick) |
| **Coin creator** | launches via the API (co-signed when `launch_signer` set), first buy at min fee, withdraws creator fees, trades with alt wallets | get tickets for own sells; launch on a FUMPAD config without the API (when `launch_signer` set); take the launch-window fees | `trader ≠ coin.creator` on chain + engine exclusion; `launch_signer`; D33 first claim → 100% buyback; DBC creator fee 0 (config check) | creator alt wallets are not excluded (D9: wallet-based, flagged off-chain) |
| **Sniper** (launch block) | buy in the first slots, bundle into the launch tx | get the creator's min fee; avoid the 99% → 1.25% scheduler | DBC gives the min fee to one swap of the pool-creation tx only (verified on the mainnet binary) | snipers inside the window pay up to 99% (all of FUMPAD's share → reward pool) |
| **MEV searcher** | sandwich router trades, sandwich buybacks, move spot around samples | extract more than the band from a buyback; move the claim median with a short spike; steer the pre-grad guard with one sample | buyback band ±3% vs keeper median / ring median + latest sample, slice ≤ 0.5%, `min_out` from the guard; 30-min median with 5-of-6 bucket coverage; ring median (≥ 4 samples spanning ≥ 60 s); app `min_out` from its own quote (V7-M3) | a price held for a majority of the 30-min window moves the claim median (cost ∝ pool depth); pre-grad: a price held through ≥ 3 keeper samples moves the ring median (bounded by band and 0.5% slice) |
| **Sybil / wash seller** | sell with ≥ 10-min hold, buy back on another wallet, transfer tokens between wallets | get a ticket for tokens held < 10 min, or keep a ticket after rebuying within 7 days on the same wallet | engine: pending tokens sold first (Clarification 21), incoming transfers debit like buys, rebuy debits | multi-wallet sell / rebuy is accepted (D9 / FINAL_REVIEW info); rate cap bounds tickets per hour |
| **A compromised single attestor** (one `Global.keepers` key / host) | sign anything, submit attestations, write the board DB rows its role allows | create a ticket or debit alone; sample, buy back or auto-claim (no jobs power); move funds | 2-of-3 distinct active keys; operator powers check `Global.operators` (disjoint, `KeeperOperatorOverlap`) | can delay its own attestations; can grief by refusing to sign (2 others remain); can defer board submissions ≤ 90 s per message (V7-M1) |
| **A compromised operator** (the jobs keeper's key / host) | time samples, run pre-grad buybacks, `claim_for`, run every permissionless crank | create, co-sign or submit any attestation (not in `Global.keepers`; the program refuses the overlap); forge samples' prices; move funds anywhere but the documented destinations | samples read on-chain prices; pre-grad ring median + band + slice; `claim_for` pays only the owner; `set_operators` (admin, immediate) | pre-grad: can feed 4 samples over 60 s at a held price (L5 residual); can stop sampling (claims wait, fallback samples don't count) |
| **2-of-3 colluding / compromised attestors** | create arbitrary tickets: any trader, any `ticket_tokens ≤ base_amount`, any price ≥ the record's own execution price ⌊quote_gross·2⁶⁴/base_amount⌋ (they can fabricate `quote_gross` too), any fabricated trade signature; debit / void any ticket by rebuy messages; push every later ticket of a coin back via the rate cap | have a ticket paid before `attested_at + ticket_challenge_secs`; exceed `max_attest_tokens_per_hour_bps` of supply becoming effective per hour (≈ 2× briefly after releases); attest for another cluster / program | challenge window (default 6 h, bounds 1–48 h) + guardian `void_ticket` + `PAUSE_ATTEST`; watcher on an independent RPC alerting the guardian chat; rate cap (deferral); `set_keepers` (admin, then 6 h freeze for new keys); deployment: each attestor in its own cloud project / account / provider, ideally run by different people (services/DEPLOY-v07.md §1) | **If the guardian does not act within the challenge window, fabricated tickets with a tiny `ticket_price_q64` pass the 10× trigger and drain graduated pools at ≤ 10% of the current pool per claim**, limited by the rate cap (20% of supply in ticket tokens → 2% of supply in claims per hour at defaults vs. a pool of ≈ 8% of supply + buybacks). Accepted design risk (D31); see §5 R2 and Q1. |
| **Compromised API / DB** | serve wrong quotes / data; rewrite board rows; refuse launches; co-sign launches (launch key) | make attestors sign wrong data; make the embedded wallet sign outside the allow-list or with a lowballed `min_out`; get mint secrets out | attestors re-derive from their own RPC; board = signatures + hints only (RLS per attestor role); app quotes locally (V7-M3); allow-list rebuilds every ix | launch co-signer compromise = anyone can register coins on our config (same as `launch_signer` unset); the DB can delay attestations ≤ 90 s per message |
| **Malicious / broken RPC provider** | omit or invent transactions for one attestor / the watcher | make 2 attestors sign a wrong record (needs 2 providers); make the watcher silent while 2 attestors are honest | one provider per attestor, 4th for the watcher; finalized only; L8 first-available-block guard; `rpc-check` | a provider with incomplete history can stop one attestor (liveness) |
| **Meteora upgrade / operator** (D38) | change DBC / DAMM v2 code, layouts, fees; disable a DAMM pool; change a pool's fee | (cannot be prevented) | readers fail closed (owner + discriminator + length); exact pinned lists for PDA-signed CPIs (an upgrade never gets our signature over foreign accounts); a disabled DAMM pool is refused by the router and buybacks (`PoolDisabled`) and skipped by samples, so claims wait for coverage; weekly `mainnet:compare` | a malicious upgrade can take everything Meteora custodies (pool liquidity, unclaimed partner fees, locked LP); claims in the first ≈ 10 min after a disable use samples from before it |
| **Admin key loss** | — | — | 3-of-5 multisig; a lost voter is replaced by the others | loss of ≥ 3 of 5 = no more param / keeper / config changes and no upgrades; the guardian can still pause / cancel / void |
| **Admin compromise** (≥ 3 of 5 voters, or a single admin key on devnet) | queue params / configs (1 h) and admin rotation (6 h), set keepers (immediate; new keys frozen 6 h), set operators (immediate), pause, void tickets, propose program upgrades (6 h Squads lock) | act before the guardian can cancel (params / config / admin); make new keepers attest within 6 h | on-chain timelocks 1 h / 6 h (clarification 29) + guardian cancel + watcher Telegram alert on every pending change; Squads 6 h time lock on upgrades and on every admin action | **the guardian must react within 1 h (params / config) or 6 h (admin) of the change becoming visible on chain (R9)**; **a program upgrade cannot be cancelled by the FUMPAD guardian**: it is visible for 6 h in Squads only; replacing the keeper set enables malicious attestations 6 h later (then the challenge window applies) |
| **Guardian compromise** (2 of 3) | pause any subset (renewable every 7 d indefinitely), cancel any pending change, void any `Open` ticket inside its window, reopen markers | move funds, change params / keepers / admin, pause router sells or fee withdrawals | stop-only powers | can freeze claims indefinitely and censor tickets in their challenge window; the admin can replace the guardian (6 h proposal; the guardian itself can cancel that proposal → stalemate resolved only by a program upgrade) |
| **Program upgrade authority** | replace the program | — | Squads 3-of-5 + 6 h time lock (mainnet plan); verifiable build planned (README §6) | total trust in the upgrade path; devnet authority is a single hot key |

## 3. Invariants that must hold

On-chain (scope A). "Always" = after every successful instruction, for every coin.

| # | Invariant |
|---|---|
| I1 | **Coin lamports.** `Coin.lamports == rent_exempt_min(546 B) + creator_fees_unclaimed + platform_fees_unclaimed + buyback_lamports`. Withdrawals re-check it (`move_coin_lamports`, `LamportInvariant`). |
| I2 | **No cross-coin fund movement.** An instruction acting on coin X moves value only between: X's `Coin`, X's reward vault, escrows of X's tickets, X's DBC / DAMM pool and its vaults (incl. its DAMM reward vaults), the actor's own accounts, and the fixed destinations (`platform_treasury` and its ATAs, `coin.creator`, the ticket owner). `claim_unregistered_fees` touches only a pool with no `Coin` and pays only `platform_treasury`. Shared PDAs (`fee_claimer`, `fee_wsol`, `reward_pool`, `buyback`, `ATA(buyback, WSOL)`) never carry value from one coin's instruction to another's: `fee_wsol` exists only inside one ix; `fee_claimer` ends every ix with no added lamports; buyback spending is measured on the shared WSOL ATA and capped by the coin's own balance; `reward_pool` signs transfers only from `ATA(reward_pool, coin.mint)` of the coin being claimed. |
| I3 | **Reward vault pays only tickets.** Every token leaving `ATA(reward_pool, mint)` goes to (a) a token account of `ticket.owner` (claim) / the owner's canonical ATA (`claim_for`, `process_queue`), or (b) `["escrow", ticket]`, for a ticket of that mint, in the amount `⌊tokens × claim_bps / 10,000⌋` at payment time, with amount ≤ `max_claim_pool_bps` of the vault balance (per-claim cap). Escrows pay only to an owner account (`withdraw_escrow` signed by the owner). |
| I4 | **Claim preconditions.** A payout or queue entry requires: not `PAUSE_CLAIMS`; coin `Graduated`; ticket `Open` (or `Queued` for the crank); `now ≥ attested_at + ticket_challenge_secs`; `now ≤ sell_ts + claim_window` (except queued: never expire); keeper-sample median ≥ trigger × `sell_price_q64` with ≥ `oracle_min_samples` keeper samples in ≥ 5 of 6 buckets of the window; skip-ahead order (no older fitting entry waits); ≤ 2 queue entries per wallet per coin. |
| I5 | **Ticket creation.** `ticket_price_q64 ≥ ⌊quote_gross × 2⁶⁴ / base_amount⌋` of the attested record. A `Ticket` exists only if `attest_sell` verified, in the Ed25519 precompile instruction immediately before it at top level, ≥ 2 distinct keys that are in `Global.keepers` and active (bootstrap key, or added ≥ 6 h ago) signing one identical 284-byte message with domain `FUMPAD-SELL-v1`, this program id and `Global.cluster_tag`, and every record rule in ARCHITECTURE §7 holds. Submitter is a keeper. |
| I6 | **Consumed-key uniqueness.** For each `(sha256(tx_sig), ix_key)` at most one live ticket exists, and the trade is ticketed at most once except: after `void_ticket(reopen = true)`, exactly one further attestation with a message hash different from the voided one. Each `(trade, ticket)` debits at most once. Sell and rebuy markers use different seeds and message lengths / domains (a sell message never parses as a rebuy). |
| I7 | **Marker closure is safe.** `close_consumed` succeeds only if the marker's ticket is not a live fumpad account and `now > block_time + 7 d`; every attestation with `now − block_time > max_attest_age_secs` (≤ 7 d by `is_valid`) is rejected, so a closed marker can't be replayed. |
| I8 | **Rate cap defers, never rejects, never makes a ticket effective early.** `attested_at ≥ now` at attestation; at most one hour's cap (`max(1, supply × bps / 10,000)` tokens) is effective at once, the rest follows at the cap rate; releases by rebuy debits / voids only shorten the backlog (cursor never < now). |
| I9 | **Ticket monotonicity.** `ticket.tokens` never increases; `attest_rebuy` only debits `Open|Queued` tickets within `[sell_ts, sell_ts + rebuy_window]`; a queued ticket's queue entry is updated in the same instruction (amount lowered or removed); `void_ticket` only inside the window, only `Open`. |
| I10 | **Timelocks.** Params and DBC-config allow-list: ≥ 1 h (`PARAMS_TIMELOCK_SECS` / `CONFIG_TIMELOCK_SECS`); admin / treasury / guardian: ≥ 6 h (`ADMIN_TIMELOCK_SECS`) between queue / propose and execute / accept (SPEC v0.7 clarification 29; were 48 h); guardian or admin can cancel; `accept_admin` signed by the new admin. New keeper keys can't attest for 6 h. Pauses lapse after 7 d. `initialize_global` only by the upgrade authority, once. |
| I11 | **Pauses never trap users.** Router `sell`, creator / platform withdrawals, fee claims (incl. `claim_unregistered_fees`, `claim_position_rewards`), samples and Meteora trading are never paused; claims pause only via `PAUSE_CLAIMS` (expiring). |
| I12 | **PDA signatures.** Every CPI signed by `fee_claimer`, `buyback` or `reward_pool` forwards an exact, pinned account list (program, pool, vaults from the pinned pool, fixed destinations — for `claim_position_rewards` the reward vault / mint / token program from the pool's reward slot and a destination computed on chain). The router never signs with a PDA. |
| I13 | **Router.** Only the trader signs; base account = the trader's canonical Token-2022 ATA; quote = a trader-owned SPL WSOL account; pool = the coin's pool for its status; referral = None; buys stop under `PAUSE_TRADE`, sells never. |
| I14 | **Fee split conservation.** `buyback + platform + creator == claimed`; platform / creator are exact floors of the snapshotted shares; the first `claim_fees` (only possible at `slot ≥ launch_slot + launch_window_slots`) sends 100% to buyback and sets `launch_fees_settled`; `claim_lp_fees` requires the flag. |
| I15 | **Graduation budget conservation.** `migrator_refund + caller_refund + setup_prefunded + platform_fee == migration_fee + surplus`; the caller is refunded at most its measured outflow; a pre-funded `fee_wsol` balance is returned, not counted. `graduate` cannot be blocked by third-party liquidity, a donated position, or a third party's `withdraw_leftover`. |
| I16 | **Leftover.** At graduation the reward vault receives ≥ 80,000,000.000000 tokens from DBC's leftover (FUMPAD config shape; rounding dust only adds). |
| I17 | **Buybacks.** Spend ≤ min(`max_in`, buyback balance, slice cap); never completes the curve; spot within the band of the guard price(s); tokens received ≥ `min_tokens` and land only in the coin's reward vault; pre-grad only by an operator after the launch window; post-grad only on an enabled DAMM v2 pool. |
| I18 | **Registration.** One `Coin` per mint; the pool's config is allow-listed and passes the structural FUMPAD checks (INTERFACE §5.4); pool base mint = mint, creator = signer, pool not yet complete; when `launch_signer` is set it must co-sign. |
| I19 | **Accounts fail closed.** Meteora accounts are read only after owner + discriminator + minimum length checks; unknown layouts revert. |
| I20 | **Roles are disjoint.** No key is in both `Global.keepers` and `Global.operators` after any instruction except `migrate_global`'s one-time fill of a pre-operators Global (until `set_operators`); attestation submission / signatures need a keeper, keeper samples / `claim_for` / pre-grad buybacks need an operator. |
| I21 | **Disabled pools.** No sample (keeper or fallback) is recorded from a DAMM v2 pool whose `pool_status ≠ 0`; no buyback or router swap runs on it. |

Off-chain (scope B / C):

| # | Invariant |
|---|---|
| O1 | Determinism: two attestors with complete finalized history produce byte-identical messages regardless of crawl order (golden replays, reverse-order replays, 200 random tapes). |
| O2 | An attestor signs only data it derived from its own RPC at `finalized`, from successful transactions, with authentic Meteora events whose amounts match vault deltas; nothing from the board, indexer, API or a webhook is trusted. |
| O3 | No ticket for: the creator; weak trader attribution (`base_owner_unsigned`, `unknown`); same-tx buy + sell / transfer-in + sell; non-WSOL quote; third-party pools; value < `min_sell_usd_cents`; tokens acquired < `min_hold_secs` ago (pending sold first); > `max_open_tickets` open; a missing / stale Pyth price (> 60 s). |
| O4 | `ticket_price_q64 ≥ ⌊quote_gross × 2⁶⁴ / base_amount⌋` (D12: max(execution, floor)). |
| O5 | Every rebuy / incoming transfer within 7 days produces debits, also when it lands before the ticket's attestation (V7-H1). |
| O6 | A parser / engine issue blocks only the affected transaction (+ one D10 window) or wallet, never the whole coin (V7-H2). |
| O7 | The watcher reports every on-chain attestation that differs from its derivation, and every derived sell not attested in time, before the challenge window ends (alert latency ≪ 6 h). |
| O8 | The watcher alerts (Telegram) on every pending governance change — params or DBC config queued, authority change proposed — on its first loop after the change is visible at `finalized` and again every 30 min until it is executed or cancelled (alert latency ≪ 1 h, the shortest timelock; R9). |
| C1 | The embedded wallet signs silently only transactions that equal, instruction by instruction and account by account, what the app's builders produce for this wallet, with `amountIn` = the typed amount and `min_out` ≥ the app's own quote × (1 − max slippage); no other program, signer, lookup table or Token instruction. |

## 4. Known gaps and open items (status at this branch's head)

| # | Item | Impact | Status |
|---|---|---|---|
| G1 | No verifiable (Docker-pinned) build; devnet bytes reproduce on our host toolchain only (README §6) | users / auditors can't independently tie mainnet bytes to source | planned before mainnet |
| G2 | `layout_version` / `collect_fee_mode` of the DAMM v2 pool are still not read (`pool_status` now is: samples skip a disabled pool, buybacks and the router refuse it — fixed 2026-10-13 d) | `token_b_amount` is 0 on layout-0 pools (buyback cap 0 → no buyback, fails safe); our pools are created by DBC on the current layout | `pool_status`: fixed; rest accepted |
| G3 | On-chain relation between attested fields: only O4 (`ticket_price_q64 ≥ ⌊quote_gross·2⁶⁴/base_amount⌋`, fixed 2026-10-13 d, `TicketPriceBelowExecution`) | an engine bug pricing a ticket below its own trade is refused; a 2-of-3 forgery can still fake `quote_gross` (the watcher compares every field) | fixed (O4); further relations would need on-chain trade data |
| G4 | Stranded value: fixed for DBC partner trading fees of unregistered pools (`claim_unregistered_fees` → treasury) and DAMM v2 farming rewards of our positions (`claim_position_rewards`); still stranded: the migration fee / surplus / 8% leftover / LP of an unregistered pool that graduates | value locked forever in that rare case (needs an 85 SOL raise on our config without FUMPAD) | fixed / remainder accepted |
| G5 | `close_position` with > ≈ 28 tickets needs a v0 tx + ALT; > 64 tickets never closable | keeper rent locked | accepted |
| G6 | Key / infra separation. Fixed in code (2026-10-13 d): the jobs keeper has its own operator key (`Global.operators`, disjoint from the attestors on chain; the services refuse a wrong key). Deployment plan changed: each attestor in its own Railway project (attestor-2 / -3 under other accounts, ideally other people; attestor-3 ideally another cloud), 5 RPC providers (services/DEPLOY-v07.md §1, LAUNCH-DAY.md §1.13) | until the plan is executed (devnet today: one project), one cloud-account compromise can still yield ≥ 2 attestor keys | code fixed; deployment = operational item before mainnet |
| G7 | All attestors and the watcher use the same Pyth Hermes source and API key | a wrong Hermes answer is agreed by all; affects only the $50 threshold, not amounts or price | accepted |
| G8 | `cluster_tag` is any `u8` at `initialize_global` | a mainnet Global initialized with tag 1 would accept devnet-signed messages only if program ids were also equal (they differ) | accepted (documented runbook) |
| G9 | A deferred ticket voided late may leave less than `max_attest_age` for its corrected re-attestation | honest seller may lose the corrected ticket | accepted (CONTRACTS.md) |

## 5. Accepted risks (decisions on record)

- **R1 — Meteora powers (D38).** Meteora's upgrade authority (`JADaUV8k…CVLd`, multisig status unverified) can change
  DBC / DAMM v2 at will; DAMM v2 operators can disable trading of a pool or change its fee; Meteora takes 20% of the
  trading fee and a share at migration. FUMPAD fails closed on layouts it reads and never signs foreign accounts, but
  value custodied by Meteora (curve / pool liquidity, unclaimed partner fees, locked LP) is at Meteora's mercy.
  Disclosed on `/risk`.
- **R2 — Keeper trust (D31).** Tickets are only as good as 2-of-3 independent re-derivation. Mitigations: three
  attestor keys in separate cloud projects / accounts with separate RPC providers (the jobs key is a separate
  operator key that can't attest), 6 h challenge window (`attested_at` = effective time), guardian
  `void_ticket` (2-of-3 multisig, no time lock), `PAUSE_ATTEST`, rate cap (deferral, 20% of supply per hour),
  independent watcher with Telegram alerts to the guardians, replay markers, record binding. Not re-checked on
  chain: trade existence, hold time, rebuys, D10 reference / D12 floor (only "ticket price ≥ the record's own
  execution price" is), USD value.
- **R3 — Oracle.** Only keeper (operator-key) samples count (fallback samples are liveness only); a disabled DAMM
  pool is never sampled; the claim median is 30 min with 5-of-6 bucket coverage; an operator controls sample timing,
  not values. Sustained manipulation of the DAMM v2 spot for
  most of 30 minutes moves the median; cost grows with pool depth (FINAL_REVIEW info: ≈ 0.6–0.9× the quote reserve
  for a keeper/leader-timed attempt in v0.6 analysis). Pre-graduation buybacks rely on keeper samples only (L5
  residual: a price held through ≥ 3 samples moves the ring median; each buyback ≤ 0.5% of the quote reserve within
  ±3%).
- **R4 — Pyth / Hermes.** Off-chain only; affects the $50 eligibility threshold.
- **R5 — Bootstrap without timelocks.** `initialize_global` sets keepers (no freeze) and configs (no timelock); only
  the upgrade authority can call it, and it could replace the program anyway.
- **R6 — Guardian censorship.** The guardian can pause claims indefinitely (renewing every 7 days) and void tickets
  inside their window; chosen so incident response is fast.
- **R7 — Wallet-based creator exclusion (D9)** and sybil sell / rebuy across wallets.
- **R8 — Rent rate** at deploy time UNVERIFIED; the 8% reward pool is exact for a single-swap completion and gains
  dust on real paths (≤ 1,000 base units in tests).
- **R9 — Short governance timelocks (SPEC v0.7 clarification 29, user decision 2026-10-14).** Params and the
  DBC-config allow-list wait 1 h on chain, admin / treasury / guardian changes 6 h (were 48 h); the admin multisig's
  Squads time lock (which also gates program upgrades) is 6 h. Consequences: (a) the guardian (2-of-3) and the team
  must notice and `cancel_params` / `cancel_config` / `cancel_admin` within 1 h / 6 h of the queue / propose —
  so the watcher's Telegram alert on every pending change (`services/keeper/src/watch/governance.ts`: params diff,
  config, new authorities, eta; re-sent every 30 min until executed or cancelled) is **essential**, not a
  convenience, and guardian signers must be reachable around the clock; (b) users get ≥ 1 h (≥ 7 h end to end on
  mainnet with the Squads lock) of notice before a params change applies — reward terms and the fee split are
  snapshotted per coin so live coins are unaffected, but global params (`ticket_challenge_secs` down to its 1 h
  floor, `max_attest_age_secs`, rate cap, oracle / buyback bounds, `launch_signer`) are not; (c) a stolen admin
  key that also defeats the alerting (or acts while guardians are unreachable) can apply a params change after
  1 h — still bounded by `Params::is_valid`. Tests: `admin_tests::params_timelock_boundary_1h`,
  `config_timelock_boundary_1h`, `admin_timelock_boundary_6h`, `guardian_cancels_within_the_short_windows`;
  `keeper/test/watcher.test.ts` "governance alerts".

## 6. Questions for the auditors

1. **Attestation verification.** Is `attestation::load_attestation` + `parse_ed25519_data` sound against every
   Ed25519-precompile layout trick (offset aliasing, `u16::MAX` self-references, overlapping signature / key /
   message regions, multiple entries with different messages, duplicate keys, instruction-index confusion when
   the fumpad ix is invoked by CPI or is not at `current`)? Is requiring the Ed25519 ix at `current − 1` sufficient?
2. **2-of-3 independence in deployment (G6).** The jobs key is now separate (operators) and the plan puts each
   attestor in its own project / account / provider (DEPLOY-v07 §1). Is that separation sufficient, and would you
   require attestors operated by different people (or an HSM / remote signer) before mainnet?
3. **Rate cap + challenge window as a drain bound.** With 2 malicious keys and a passive guardian, what is the
   maximum extractable value per coin per hour under the leaky-bucket cap (incl. the ≈ 2× burst after releases)?
   `ticket_price_q64` is now bounded below by the record's own execution price only (G3). Would you add an on-chain
   per-coin claim-rate limit or a minimum `ticket_price_q64` relative to observed (sampled) prices?
4. **Shared PDAs.** Can any sequence of instructions (incl. donations, pre-funded PDAs, same-tx combinations of
   `claim_fees` / `claim_lp_fees` / `claim_unregistered_fees` / `claim_position_rewards` / `graduate` /
   `execute_buyback` for different coins) make `fee_claimer`, `fee_wsol`, `buyback` or `ATA(buyback, WSOL)` move
   value between coins (I2)? (`two_coin_tests` interleaves two coins through every one of them.)
5. **Direct lamport edits.** `wrap_from_coin` debits the program-owned Coin and credits the system-owned `buyback`
   PDA directly, then CPIs a system transfer carrying the Coin as an extra writable account. Is this robust under
   the current runtime rules (CPI balance checks) and future ones?
6. **Graduation.** Can anyone make `graduate` record a wrong pool, steal the setup budget, inflate
   `migrator_cost` (measured lamport outflow of the `migrate_pool` caller across the DBC CPI), or make
   `leftover_tokens` / the 8% leftover land anywhere but the reward vault? Is accepting any DAMM v2 config whose
   `pool_creator_authority` is DBC's pool authority safe?
7. **Meteora reads.** Are the byte offsets in `external/meteora.rs` correct for the mainnet binaries
   (README §5.1 hashes), and do the readers fail closed on every layout change Meteora has shipped before?
8. **Router pass-through.** With only the trader signing and up to 24 caller-chosen accounts, can the router be
   used to make the trader's measurement (`RoutedTrade`) lie in a way that matters (the event is informational;
   tickets come only from attestations), or to touch another coin's accounts?
9. **Queue / escrow.** Any way to block `process_queue` for a coin (halt condition when an entry's accounts are
   missing; escrow creation griefing; `check_destination` on Token-2022 accounts with extensions), or to make an
   entry's amount exceed its ticket's current claim amount?
10. **Rate-cap arithmetic.** `Coin::schedule_attest` / `release_attest` use saturating i64 arithmetic and
   `attest_secs` caps at `i64::MAX / 4`. Any overflow or rounding path that makes a ticket effective early, or that
   lets releases grow the effective capacity beyond the documented ≈ 2×?
11. **Engine determinism (scope B).** Any input (RPC encoding differences json vs jsonParsed, v0 vs v1 transactions,
   missing `stackHeight`, inner-instruction ordering, Token-2022 extensions, owner changes, closes and re-inits)
   that makes two honest attestors derive different bytes (liveness) or the same wrong bytes (safety)?
12. **Allow-list (scope C).** Can a compromised API or app bundle make the embedded wallet silently sign anything
   beyond C1 (e.g. via `launch` patterns, ATA creation for other owners, priority-fee abuse, or a message that the
   wallet bridge decodes differently)?
