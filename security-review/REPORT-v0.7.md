# FUMPAD v0.7 off-chain pre-audit security review

Scope: services/ (meteora parser, engine, keeper attestor/watcher/jobs, sdk attestation encoding, indexer, api launch) and app/ (allow-list, signer, launch binding, CSP, prelaunch gate, data layer). Reviewed at 95c59e9 (2026-10-13) against SPEC-v0.7 (+Clarifications), ATTESTATION.md, INTERFACE-v0.7.md and REPORT.md. On-chain program not reviewed here (see contracts/REVIEW-v0.7.md). PoCs: `security-review/v07-poc/` — written to pass while the bug existed; fixed ones are now flipped (see Status). Run from `services/` (or `app/` for `app-*`): `node --import tsx --test ../security-review/v07-poc/<name>.test.ts`; needs a `security-review/node_modules -> ../services/node_modules` symlink (not committed).

## Status (2026-10-13, branch fixes: `e01899c` services fixes, `824cf86` follow-up to contracts INTERFACE §8)

PoCs for fixed findings were flipped: each now asserts the attack FAILS (header: "fixed in e01899c").

| ID | Severity | Finding | Status |
|---|---|---|---|
| V7-H2 | High | Engine issue freezes a coin | **Fixed** `e01899c` — vault cross-check accounts non-swap movements (`meteora/src/vaultflow.ts`), issues carry the pool; failures scoped per tx (+ one D10 window, `price_unverified`) / per wallet (negative balance, unmappable attestation; recovers after a full exit) / coin only for engine invariants; `ownerDeltas` per token account (owner changes); `records.ts` cuts off only coin-scope issues; alerts + runbook (services/README.md). PoCs `vault-donation-freeze`, `owner-change-negative-balance`; golden replays now also inject a donation and reverse the input order. |
| V7-H1 | High | Rebuy before attestation lost | **Fixed** `e01899c` — debits carry the ticket's final on-chain address (resolved after the replay); watcher reports missing debits. PoC `rebuy-before-attestation`. |
| V7-M1 | Medium | Board status suppresses attestations | **Fixed** `e01899c` — per-keeper hints (`attest_hints`); landed = consumed marker at finalized, dropped = own simulation only; a fresh "landed" hint defers once (≤ 90 s). Per-keeper DB roles + RLS are the documented default (`ATTEST_BOARD_RLS`, README "Keeper board"; startup alert, `ATTEST_BOARD_REQUIRE_RLS=1` for mainnet). PoC `board-status-suppression` (a). |
| V7-M2 | Medium | PoolNotOfCoin drops a DAMM sell | **Fixed** `e01899c` — DAMM sells not signed until the finalized Coin has `damm_pool`; PoolNotOfCoin / TooManyOpenTickets / TicketNotOpen retried with back-off. PoC (b). |
| V7-M3 | Medium | App allow-list doesn't bound `min_out` | **Fixed** `ec3d416` — the silent-signing allow-list (`app/src/chain/allowlist.ts`) requires the exact `amount_in` and a `min_out` no lower than the app's own RPC quote minus slippage; the launch first buy is bounded the same way (`app/src/chain/launch.ts`); tamper tests in the app suite. |
| V7-M4 | Medium | Fresh tokens ride on matured credit | **Fixed** `e01899c` (decision) — a sell draws pending tokens first; SPEC-v0.7 Clarifications 21. PoC `fresh-tokens-ride-matured`. |
| V7-M5 | Medium | Pyth null cache / determinism | **Fixed** `e01899c` — only successes cached; recent 404s re-asked after 60 s (final after 1 h); pinned selection (max publish_time ≤ block time, earliest slot, price, conf) with a cross-keeper order test. PoC `hermes-null-cache`. |
| V7-M6 | Medium | Keeper liveness DoS | **Fixed** `e01899c` — incremental crawl (cursors, closed accounts skipped), per-coin RPC budget, parallel prioritised coins + tick budget, LRU caches. API co-signature on `register_coin` = contracts `Params.launch_signer` (see L1). PoC `crawl-amplification`. Residual: accounts kept OPEN cost one call each per tick (and the attacker their rent). |
| L1 | Low | Launch binding off-chain only | **Fixed** — contracts (`c9be557`: `Params.launch_signer`, verified one min-fee swap per launch tx) + API co-signs with `LAUNCH_SIGNER_KEY` (`824cf86`); e2e proves an unsigned self-launch is refused; app fixtures re-captured with the co-signer (positive path tested by the app allow-list). The launch tx now sets a CU limit only with a priority price (room under 1,232 bytes); prepare refuses metadata that doesn't fit. |
| L2 | Low | Unregistered pools on our config | **Fixed** `e01899c` — pools count only for mints with a `CoinRegistered` (table or same tx). |
| L3 | Low | Voids missed after restart | **Fixed** — `void_ticket` now lists coin + mint (contracts `c9be557`); services rely on it (`824cf86`), regression test in `keeper/test/derive.test.ts`. |
| L4 | Low | "landed" at confirmed | **Fixed** `e01899c` — consumed marker at finalized (see V7-M1). |
| L5 | Low | Pre-grad buyback guard on one sample | **Fixed** — off-chain `e01899c`: randomized buyback timing; spot and the on-chain sample must agree with the keeper's TWAP of its last 8 observations; samples only anchored at such a spot. On-chain (contracts, INTERFACE §8 2026-10-13 c): the guard price is the median of the coin's last 5 keeper samples (`Coin.pregrad_ring`, ≥ 4 within 5 min spanning ≥ 60 s) and spot must be within the band of that median AND the latest sample; regression tests `regression_l5_*` + liveness test in `contracts/tests/src/oracle_buyback_tests.rs`. Residual: a price held through ≥ 3 keeper samples moves the median (bounded by the band and the 0.5% slice). |
| L6 | Low | CSP / same-context scripts | **Fixed** (image part) — coin images through the API's proxy `GET /v1/img/:mint` (SSRF-safe fetch, raster-only, strict headers); app CSP `img-src` without `https:`. `'unsafe-inline'` / same-context assumption stated in `app/LAUNCH.md`. |
| L7 | Low | Watcher alert gaps | **Fixed** `e01899c` — alerts for unattested sells, engine issues; 30 min re-alert; voided tickets not re-alerted (`824cf86`). |
| L8 | Low | Incomplete RPC history | **Fixed** `e01899c` — `getFirstAvailableBlock` floor vs coin launch (startup + hourly), pool creation must precede `Coin.launch_slot`. |

## High

### V7-H1 Rebuy debits before attestation are lost (rebuy rule bypass)
- **Where:** `engine/src/engine.ts:158` (`ticketAddress` copied at replay time), `keeper/src/attest/records.ts:70`, `keeper/src/watch/verify.ts:111,130`.
- **Impact:** a buy or transfer-in between a sell and its attestation leaves `RebuyDebit.ticketAddress = null` forever. Keepers and the watcher skip it, so "sell, buy back next slot" keeps a full ticket. The engine's open-ticket count also drifts from the chain.
- **PoC:** `rebuy-before-attestation.test.ts`.
- **Fix:** resolve `ticketAddress` from the final ticket after replay. Keep the open count consistent with the chain. Add an engine test, and a watcher alert for attested tickets that are missing derived debits.

### V7-H2 Any engine issue freezes a coin forever; attacker-triggerable for ~free
- **Where:** `meteora/src/parse.ts:280-298`, `engine/src/history.ts:91-93`, `engine/src/engine.ts:168,174,213,265`, `keeper/src/attest/records.ts:40,89-91`.
- **Impact:** once the sticky `inconsistent` flag is set, no keeper or watcher ever signs a ticket or rebuy debit for that coin again. Triggers:
  - a 1-unit donation into a pool vault in a swap transaction;
  - `SetAuthority(AccountOwner)` on a non-ATA Token-2022 account, which drives a balance negative;
  - accidental vault movements outside swaps (migration bundles, fee claims);
  - an attested ticket the engine can't map.
- **PoC:** `vault-donation-freeze.test.ts`, `owner-change-negative-balance.test.ts`.
- **Fix:**
  - Scope failures to the affected transaction or wallet, and attach the pool to vault issues.
  - Tolerate or account for known non-swap vault movements.
  - Attribute balances per token account and track owner changes.
  - Make `negative_balance` per wallet.
  - Cut off per wallet or range in `candidates()`.
  - Alert and write a runbook.

## Medium

### V7-M1 Board `attest_status` lets one keeper or DB writer suppress all attestations
- **Where:** `keeper/src/attest/attestor.ts:184-185`, `board.ts`.
- **Impact:** unsigned status rows are checked before the chain. One compromised keeper or a leaked `DATABASE_URL` can mark everything "dropped", so 2-of-3 liveness fails.
- **PoC:** `board-status-suppression.test.ts` (a).
- **Fix:** treat status as a hint only. "Landed" = consumed PDA or ticket on chain at finalized; "dropped" only from this keeper's own simulation. Make per-keeper DB roles mandatory.

### V7-M2 `PoolNotOfCoin` marks a valid DAMM sell dropped forever
- **Where:** attestor permanent errors (`:264`), `engine/src/history.ts:81-85`.
- **Impact:** sells between Meteora's migration and our `graduate` are rejected once and never retried.
- **PoC:** `board-status-suppression.test.ts` (b).
- **Fix:** don't sign DAMM sells until the finalized Coin has `damm_pool`. Treat `PoolNotOfCoin` / `TooManyOpenTickets` / `TicketNotOpen` as retryable after a re-check.

### V7-M3 App allow-list doesn't bound `min_out`, which comes from the API quote
- **Where:** `app/src/chain/allowlist.ts:212-235`, `app/src/data/api.ts:259`, `components/coin/TradePanel.tsx:109`.
- **Impact:** a compromised API can lowball the quote, and the embedded wallet silently signs trades with no real slippage protection. That enables sandwiching. M-9 is only partly fixed.
- **PoC:** `app-allowlist-min-out.test.ts`.
- **Fix:** quote locally from pool accounts via the app's RPC. Refuse `min_out` below the local quote × (1 − max slippage). Put `amountIn`/`minOut` in `SilentPolicy` and enforce them.

### V7-M4 Fresh tokens ride on matured credit (design decision)
- **Where:** `engine/src/rules/position.ts` (`planSell`/`debitSold` spend matured tokens first).
- **Impact:** a holder with M matured tokens can receive or buy X, sell X one second later, get a full X ticket and keep M. This is a regression from v0.6's "unseen arrivals are sold first".
- **PoC:** `fresh-tokens-ride-matured.test.ts`.
- **Fix (design):** sell newest (pending) tokens first, or require the balance at `sell_ts − min_hold` ≥ ticket tokens.

### V7-M5 Pyth source: cached nulls, unverified determinism
- **Where:** `engine/src/pyth.ts:47`, the long-lived `priceCache`.
- **Impact:** a 404 is cached forever, so honest sells can go unattested. Whether two keepers pick the same update within one `publish_time` second is unverified.
- **PoC:** `hermes-null-cache.test.ts`.
- **Fix:** cache only successful responses. Pin a deterministic selection rule. Add a cross-keeper determinism test.

### V7-M6 Keeper liveness DoS
- **Where:** `engine/src/fetch.ts` (`crawlMintHistory`, full pagination every tick), `attestor.ts:155-166` (coins processed one after another), unbounded caches in `derive.ts`, and `register_coin` (no API co-signature).
- **Impact:** cheap 1-unit spraying to many accounts, or spam coins, makes every tick slower and slower. Sells older than 24 h then become unattestable.
- **PoC:** `crawl-amplification.test.ts`.
- **Fix:**
  - Crawl incrementally with persisted cursors.
  - Stop re-crawling finalized-closed accounts.
  - Per-coin budgets and parallelism, with priority for coins with recent sells.
  - Bounded caches.
  - Consider an API co-signature in `register_coin`.

## Low
- **L1:** the launch binding is off-chain only. `register_coin` accepts self-launched pools on allow-listed configs. UNVERIFIED whether several sybil swaps in the init tx can all get DBC's min fee. *Needs a contracts change (services can't bind it): done in contracts `c9be557` (`Params.launch_signer`; the min fee goes to one swap per launch tx, verified on the mainnet binary).*
- **L2:** the indexer treats unregistered pools on our config as ours. Gate on `CoinRegistered`.
- **L3:** `void_ticket` references no mint or Coin, so the first pass after a restart misses voids. Use a two-pass crawl.
- **L4:** "landed" is set at confirmed, not finalized. Use the consumed PDA at finalized.
- **L5:** the pre-graduation buyback guard follows a movable spot inside the ±3% band. Randomise timing and use a TWAP of samples.
- **L6:** the CSP's `img-src https:` and `'unsafe-inline'` still allow exfiltration. The allow-list can't stop same-context scripts; state that assumption.
- **L7:** the watcher has no alert for sells that were never attested or for engine issues, and it has a 6 h cooldown.
- **L8:** an RPC provider with incomplete history diverges permanently. Cross-check at startup.

## Info
- The prelaunch gate is host-based: `fumpad.vercel.app` and previews serve the full app.
- Held up under review:
  - trader attribution;
  - event authenticity;
  - failed transactions;
  - v0/v1 shapes;
  - ixKey uniqueness;
  - ordering;
  - bigint determinism;
  - message encoding;
  - board signature verification;
  - designated-submitter fallback.

## Previous REPORT.md regression check
- H-1..H-5 and M-1..M-6 are fixed. The old PoCs for SSRF, webhook forgery and XFF now fail, as expected.
- `process-queue-stall` and `launch-buy-redirect` target v0.6 APIs that no longer exist.
- M-9 is only partly fixed (V7-M3).
- M-7's budget covers keeper jobs, not the attestor (V7-M6).

## Fix order
V7-H2 · V7-H1 · V7-M1 · V7-M2 · V7-M3 · V7-M6 · V7-M5 · V7-M4 (decision) · Lows.

## External audit 2026-10-17

Source: `fumpad-audit-final-report.md` (AI-assisted, 2026-10-17; first audit at `4e1940d`, re-run at `74da155`).
Status per finding fixed or touched. Other areas (engine, keeper, app, program) may add their own rows below theirs.

### services/api (off-chain API) + the app's launch-message builder

| ID | Severity | Status | Fix | Tests |
|---|---|---|---|---|
| S-2 / H-3 | High | **Fixed (off-chain)** | `launchConfig: "first_coin"` on `POST /v1/launch/prepare` **and** `POST /v1/launch/metadata` only for `FIRST_COIN_CREATOR` (403 `first_coin_not_allowed` before anything is reserved, pinned or co-signed; `pickLaunchConfig` re-checks). `LAUNCH_FIRST_COIN=true` without a valid `FIRST_COIN_CREATOR` = startup error. `GET /v1/launch/options` shows `firstCoin` only to `?creator=<FIRST_COIN_CREATOR>` (the app's `/launch?config=first-coin` asks with the connected wallet). Mainnet creator `EiwHzSkty4mD1463dvbr7o1fHMNaA8xQPgk4PyXpnVGc` (LAUNCH-DAY §1 / §5.3). **Residual:** the launch key still co-signs whatever this API decides; an on-chain `allowed_creator` on the config would bind it in the program (program change, separate decision) | `api/test/poc-s2-first-coin.test.ts` (the audit PoC, flipped: 1,000 random creators refused, prepare + metadata 403 with nothing prepared/pinned, options hide it; positive control: the team creator gets the co-signed tx), `launches-open.test.ts`, `launch-metadata.test.ts`, `launch.test.ts` |
| M-3 / S-5 | Medium / Low | **Fixed** | `reserved_at` never refreshed (hard expiry; reuse only within the TTL; `expiresAt` fixed); fresh reservations capped per wallet (`LAUNCH_WALLET_RESERVATIONS_PER_HOUR`, 6) and per IP (`LAUNCH_IP_RESERVATIONS_PER_HOUR`, 20), IPv6 bucketed by /64 (also the DB active-per-IP cap); the sweeper releases a reservation whose creator's balance fell below `LAUNCH_MIN_BALANCE_LAMPORTS` once its signed txs expired (balance bound to the reservation). Verified: `/health` pool counts were SSR-only but **`/v1/status` returned exact counts publicly**; now rounded down for the public, exact with the SSR header. Hourly caps are in memory (per instance) | `test/integration/vanity-pool.test.ts` (real Postgres), `audit-2026-10-17.test.ts` (status, ipBucket) |
| S-4 / L-2 | Low | **Fixed** | `TRUST_PROXY_HOPS` defaults to 2 in production (Railway, verified live); docs keep it explicit | `security.test.ts` |
| S-6 | Low | **Fixed** | CSV cells starting with `=` `+` `-` `@` tab or CR get a leading `'` and are quoted | `audit-2026-10-17.test.ts` |
| S-7 / L-4 | Low | **Fixed** | positions / closed / balances: own per-IP limit (`WALLET_RPC_RATE_LIMIT_PER_MIN`, 60); cache = one bounded LRU per route family (`chain:<kind>` for chain reads), so attacker-chosen keys can't flush other routes; failed loads cached 2 s (negative caching) | `audit-2026-10-17.test.ts` |
| L-3 | Low | **Fixed** (legacy window) | launch message gains `domain:` (checked against `LAUNCH_AUTH_DOMAINS`, default the `CORS_ORIGINS` hosts) and `cluster:` (= `FUMPAD_CLUSTER`); nonce single use per route (metadata, prepare), kept until expiry, given back when the request fails before reserving/pinning. App builder (`app/src/chain/launchAuth.ts`) signs the seven-line form and its allow-list checks host + cluster. The old five-line form stays accepted (single use too) while `LAUNCH_AUTH_LEGACY=true` (default): set `false` after the app deploy (DEPLOY-v07 §14). Nonces in memory (one instance) | `launch-auth.test.ts`, `launch-metadata.test.ts`, `audit-2026-10-17.test.ts`; app `launchAuth.test.ts` |
| L-7 | Low | **Fixed** | image proxy: per-host-group cap (`IMG_MAX_PER_HOST`, 2; group = last two DNS labels) inside the global cap (`IMG_MAX_CONCURRENT`, now 16); our Pinata gateway / ipfs:// share half the global cap | `img.test.ts` |
| S-11 / I-2 | Info | **Fixed** | no default `SOL_USD_FALLBACK`: last good Pyth price for `SOL_USD_MAX_STALE_SECS` (300), then 503 `{code: "price_unavailable"}` and an error-level log `SOL/USD price unavailable` (alert on it); an explicit fallback (local stacks) is logged | `audit-2026-10-17.test.ts` |
| I-1 | Info | **Fixed** | the SSR secret lifts the per-IP limit to `SSR_RATE_LIMIT_PER_MIN` (6000) instead of exempting it (all routes, incl. route-level limits) | `audit-2026-10-17.test.ts`, `security.test.ts` |

Source: `fumpad-audit-final-report.md` (AI-assisted, 2026-10-17). Off-chain fixes only (keeper / engine / sdk /
meteora parser); nothing under `contracts/programs` changed. Status of the findings touched here:

| ID | Severity | Status | Fix |
|---|---|---|---|
| S-1 / H-2 | High | **Fixed** | `engine/src/fetch.ts`: each run crawls only addresses with NEW activity — the mint, the Coin PDA, never-crawled accounts, and every account appearing in a newly found tx plus all open accounts of its owner (transitively, same run), so a wallet's whole history is current before anything of it is attested. Dormant open accounts and attested ticket PDAs are re-polled in rotation within half the budget (ticket holders inside their rebuy window first), never past it. The O(n²) rescan is gone (per-address `touched` sets, index-based queue). Budget adaptive per coin (×2 after a miss up to `ATTEST_COIN_RPC_BUDGET_MAX`, halving back), `crawl-budget:<mint>` alert after `ATTEST_CRAWL_ALERT_TICKS` (4) consecutive misses (attestor + watcher, 1 h dedupe; the watcher no longer reports it as a derivation failure). PoC `engine/test/poc-s1-crawl-budget.test.ts` flipped: 5,200 and 20,000 open accounts catch up (1 resp. 4 ticks), then every tick completes at ≈ 2,500 calls (≤ 90% of the 5,000 budget), the rotation re-polls every account within ⌈n / 2,500⌉ ticks, a plain transfer between two dormant accounts is found within one cycle and a silent transfer into a wallet that then trades is found in the same run; 20,000 accounts run in ≈ 0.15 s (was 8–10 s CPU per failing tick). |
| H-1 | High | **Fixed** | Engine (consensus, SPEC Clarification 32): a ticket's debits are attested once they reach 1% of the ticket (`ENGINE_MIN_REBUY_DEBIT_BPS`) or void it — one attestation for the sum, anchored on the crossing acquisition; ≤ 101 rebuy attestations per ticket ever, each backed by ≥ 1% of the ticket really acquired. Unattested residual ≤ 1% of a ticket (claim overstated ≤ 0.1% of it). The program's `attest_rebuy` accepts these unchanged (debit > 0, window, age, per-(trade, ticket) marker). Keeper: per-ticket (6/h) and per-coin (120/h) submission budgets (deferred, still signed), `balance` alert below `MIN_ATTESTOR_LAMPORTS`. Golden mainnet replays: identical decisions (every real rebuy was ≥ 1%). |
| M-1 | Medium | **Fixed** | Engine (consensus, Clarification 33): a transfer-in < 1% of the wallet's pending bucket (`ENGINE_DUST_TRANSFER_BPS`) neither restarts nor joins it (untracked: sold first, never ticketed). For rebuys dust is harmless under H-1. |
| M-2 | Medium | **Investigated, narrowed** | Can a third party trigger a parse issue on a FUMPAD pool? Yes, plausibly: a genuine swap event under an instruction outside our IDL subset (`event_without_swap_parent` / `unsupported_instruction`, e.g. a newer DBC/DAMM v2 swap variant callable by anyone — the parser already names `swap2_with_transfer_hook`) — whether such an instruction is callable on our pools on mainnet is unverified (external program). Other codes need an RPC fault (`tx_shape`, `no_stack_heights`), a Meteora layout change (`event_decode`, I-3) or an unmodelled pool-program vault movement; donations and token instructions into a vault are already accounted (V7-H2). Per-tx scoping (Clarification 22) holds: only that tx's sells are refused and the wallet state stays exact; the coin-wide part was the 10-min D10 price taint. Narrowed (Clarification 34b): the parser now attaches the pool and EvtSwap2's post-swap sqrt price to such issues (one issue per unknown instruction), the issue is dropped for a third-party pool, and the engine re-anchors the pool spot + D10 reference exactly instead of tainting. Fail-closed kept: no price (decode failure, vault mismatch, two EvtSwap2 under one unknown instruction) → taint as before. |
| L-5 | Low | **Fixed** | `engine/src/history.ts` `payoutReceipts`: the exemption is per owner, capped at what that owner received from a reward-pool token account in the tx (Clarification 34a); bundled transfer-ins are acquisitions. |
| L-6 | Low | **Fixed** | Alert keys `issues:<mint>:<kind>` (attestor + watcher; was `issues:<mint>:<count>` in the watcher); every alert inside the tick loops is fire-and-forget (`notify`): a hanging Telegram can't stall a tick (tested). |
| S-8 / L-1 | Low | **Fixed** | `PgBoard.rlsProblems()`: RLS enabled AND FORCEd, per-keeper policies present, role not the owner / a member of the owner role / superuser / BYPASSRLS (tested on a real Postgres). `ATTEST_BOARD_RLS` now FORCEs RLS. `ATTEST_BOARD_REQUIRE_RLS` defaults to on with `NODE_ENV=production` (`0` opts out). Re-run the RLS script before upgrading (DEPLOY-v07 §14). |
| SDK robustness gap 1 | Info | **Fixed** | `sdk/src/attestation.ts` range-checks u8/u32/u64/i64/u128 and throws `RangeError` (was: `baseAmount = 2^64` encoded as 0). Fuzz characterization flipped. |
| Test flake | — | **Fixed** | `keeper/test/queue.test.ts` "matches the program on random queues…" has a 60 s timeout. |

Adopted from the audit worktrees: `engine/test/fuzz.property.test.ts`, `sdk/test/fuzz-cross.test.ts` (+ `fast-check`
devDependency), the S-1 PoC (flipped). Not touched here: S-2/H-3 (first-coin gate, api), APP-1/M-4 (app), ONC-*,
S-3, M-3, M-5, S-4..S-7, L-3, L-7..L-10, APP-*.
