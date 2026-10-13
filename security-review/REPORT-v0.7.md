# FUMPAD v0.7 off-chain pre-audit security review

Scope: services/ (meteora parser, engine, keeper attestor/watcher/jobs, sdk attestation encoding, indexer, api launch) and app/ (allow-list, signer, launch binding, CSP, prelaunch gate, data layer). Reviewed at 95c59e9 (2026-10-13) against SPEC-v0.7 (+Clarifications), ATTESTATION.md, INTERFACE-v0.7.md and REPORT.md. On-chain program not reviewed here (see contracts/REVIEW-v0.7.md). PoCs: `security-review/v07-poc/` — each passes while the bug exists. Run from `services/` (or `app/` for `app-*`): `node --import tsx --test ../security-review/v07-poc/<name>.test.ts`; needs a `security-review/node_modules -> ../services/node_modules` symlink (not committed).

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
- **L1:** the launch binding is off-chain only. `register_coin` accepts self-launched pools on allow-listed configs. UNVERIFIED whether several sybil swaps in the init tx can all get DBC's min fee.
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
