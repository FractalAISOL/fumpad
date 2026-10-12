# FUMPAD off-chain pre-mainnet security review

Scope: `services/` (sdk, indexer, api, keeper, grinder) and `app/` (Next.js, Privy embedded wallets with silent signing). Reviewed at commit ff0c4ea, 2026-10-12. Internal review; does not replace the external audits.

Reproductions (run from `services/`, or `app/` for the launch test): `node --import tsx --test ../security-review/<dir>/<name>.test.ts`

## High

| ID | Finding | Where | Fix | Repro |
|---|---|---|---|---|
| H-1 | Indexer webhook accepts forged transactions: auth is skipped when `HELIUS_WEBHOOK_SECRET` is unset, and the body is trusted as chain data. A forged payload reusing a real signature wins the idempotency race and is later marked finalized. Critical if shipped without the secret. | `indexer/src/sources/push.ts:26`, `ingest.ts:89-101` | Require the secret (fail boot), `timingSafeEqual`, treat the webhook as a poke that re-fetches each signature from our RPC. | `services-poc/webhook-forgery.test.ts` |
| H-2 | `trustProxy: true` makes `req.ip` the client-controlled leftmost `X-Forwarded-For`: bypasses every per-IP limit and `RATE_LIMIT_ALLOW`. | `api/src/server.ts:69` | Trust only the real hop count / Railway's header; verify live. | `services-poc/xff-rate-limit.test.ts` |
| H-3 | Coins are routed by symbol and the oldest case-insensitive match wins: a squatted symbol hijacks links, share cards and the trade panel's mint. | `api/src/repo.ts:225` | Route by mint everywhere; symbol lookup returns a list. | reasoning |
| H-4 | Keeper `process_queue` passes accounts for the first 13 entries only; if those don't fit, fitting entries behind never pay, a zero-pay tx is sent every 30 s, and owners can farm the re-created ATA rent (~76 SOL/day worst case). | `keeper/src/keeper.ts:474-484`, `sdk/src/client.ts:423` | Simulate the skip-ahead walk and pass only entries that will pay; don't recreate the same ATAs; alert on zero-pay runs. | `services-poc/process-queue-stall.test.ts` |
| H-5 | No CSP / security headers while the embedded wallet signs silently in the page's JS context: any injected or supply-chain script could drain it. | `app/next.config.ts`, `PrivyIsland.tsx:80-90` | Privy-compatible CSP (report-only first), `frame-ancestors 'none'`, X-Frame-Options DENY, HSTS, nosniff, Referrer-Policy; lock Privy allowed origins; evaluate Privy's server-side policy engine. | reasoning |

## Medium

| ID | Finding | Fix |
|---|---|---|
| M-1 | `checkPreparedLaunch` doesn't bind the first buy to the new mint or the form's name/symbol/uri: a compromised API can redirect the initial buy (signed silently). Repro: `app-poc/launch-buy-redirect.test.ts`. | Use the SDK's `inspectLaunchTx` and compare metadata. |
| M-2 | Vanity pool can be drained (no proof of wallet control, IP limit bypassable); prepare does RPC inside a DB transaction → ~10 slow prepares starve the pool. | Wallet signature + min balance or captcha; RPC outside the tx with timeouts. |
| M-3 | SSRF via coin metadata URI (redirects followed, no host filtering); fetched fields served publicly. Repro: `services-poc/metadata-ssrf.test.ts`. | Allow https/ipfs/ar only, block private ranges after DNS resolution, no redirects to private hosts, size/time limits. |
| M-4 | Finalizer deletes rows after a single null status from RPC. | Require repeated misses + cross-check. |
| M-5 | Poller advances its cursor past transactions it failed to fetch. | Keep the cursor until fetched; retry queue. |
| M-6 | WebSocket fan-out: per-client serialization, no backpressure, no global cap. (Partly addressed by the perf pass: serialize once, coalescing, slow-client drop.) | Global connection cap. |
| M-7 | Keeper spend unbounded: priority fees can be pinned at the cap; a new lookup table each restart (~0.06 SOL leak); RPC cost scales with spam coins. | Spend budget + alarm, persist the ALT, scan limits. |
| M-8 | `NEXT_PUBLIC_SOLANA_RPC` is in the client bundle (a Helius key there is public); unset falls back to public mainnet RPC. | Restricted frontend key (domain-locked) or RPC proxy. |
| M-9 | Slippage measured from fresh chain state, not the displayed quote; per-trade limit excludes fee and first-time rent. | Use the shown quote as the bound; include fee + rent in the limit. |

## Low

L-1 metadata `imageUrl` unvalidated · L-2 API client doesn't encode path params; `/og` id unvalidated and uncached · L-3 `before=NaN` → 500, no schema validation · L-4 grinder DB without TLS; all services share one DB role · L-5 verbose public health endpoints · L-6 webhook compare not constant-time, 20 MB bodies · L-7 mint co-signature only checked non-zero · L-8 instant trading on by default, no session cap · L-9 Docker runs as root · L-10 single keeper instance not enforced · L-11 API cache wiped on every indexed tx.

## Info

`CORS_ORIGINS` README says fumpad.fun (domain is fumpad.app; unset = `*`) · hard-coded Privy app id fallback · cluster inferred from RPC URL · `RPC_URL` defaults to Helius mainnet when only the key is set · a stolen keeper key can bias sample timing (can't move funds) · cost basis excludes rent/fees/transfers · look-alike Unicode symbols allowed (worsens H-3).

## No issue found

MINT_POOL_KEY crypto (per-row nonce, pubkey as AAD, fingerprint, zeroing) · mint secrets never returned/logged; server signs only its own bytes · allow-list core (ALTs, fee payer, signer set, System/Token/nonce, compute caps, summed buys) · withdraw flow · export flow (Privy iframe) · XSS · SQL injection · pagination clamps · `/og` has no outbound fetch · no open redirects · keeper key never logged · no secrets in git history.

## npm audit

app: 0 critical, 9 high, 28 moderate (runtime: `ws` via Privy's wallet deps, `toml` via anchor; update Privy to latest 3.x). services: 2 critical (dev-only vitest/tinypool → vitest 5), 2 high, 6 moderate (anchor/web3.js transitive, malicious-RPC only). Nothing exploitable from user input at runtime.

## Mainnet readiness gaps

Fail boot/build when required env is missing (webhook secret, CORS origins, RPC_URL, Privy id, frontend RPC/API) · separate Helius key per service · only API + `/helius` public, Postgres private · SSR→API auth via shared secret header, not IP allow-list · Postgres backups + tested restore (vanity pool can't be rebuilt) · alerts: indexer lag, rollbacks, gap fills, low pool, API 5xx, keeper balance/spend, unexpected keeper-key txs; Telegram mandatory · runbooks: pause, keeper key rotation, MINT_POOL_KEY rotation, webhook re-sync, re-backfill, RPC outage · keeper: persisted ALT, single instance.

## Fix order

1 H-1 · 2 H-2 · 3 H-5 · 4 H-3 · 5 H-4 · 6 M-1 · 7 M-2 · 8 M-4/M-5 · 9 M-3 · 10 M-7 · 11 M-8 · 12 M-6, M-9, then Low.
