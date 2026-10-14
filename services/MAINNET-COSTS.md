# FUMPAD mainnet — what launching costs

Exact where the chain decides (rent, base fees), measured where we could (the local mainnet-fork rehearsal), and
labelled **estimate** with a source where a vendor decides (RPC, Railway). No revenue or profit figures.

**Sources of the numbers**
- Rent: `getMinimumBalanceForRentExemption` on **mainnet**, read-only, 2026-10-13 (`npm run mainnet:snapshot`; the
  shared Helius key, spaced requests). Mainnet rent is linear: **lamports = (128 + bytes) × 5,080** (checked for
  0 … 81,976 bytes). Note: a local `solana-test-validator` still charges 6,960 per byte (the old rate), so amounts
  measured in the rehearsal are ~37% above mainnet's for the rent part; below they are converted.
- Sizes: `contracts/programs/fumpad/src/state/mod.rs` asserts (Global 1,491 since 2026-10-14, Coin 546 — 593 for the
  first coin, whose fee policy is snapshotted in a tail — Position 315, Ticket 276,
  Consumed 98), keeper constants (Observations 8,280, ClaimQueue 81,976), DBC PoolConfig 1,048, the built .so.
- Fees: base fee 5,000 lamports per signature. Priority fees: `getRecentPrioritizationFees` on mainnet (150 slots,
  2026-10-13) for DBC/DAMM v2 writable accounts: p50 0, p75 0, p90 0, max 10,002 (DBC) / 556,057 (DAMM v2)
  µlamports/CU.
- Measured: `npm run mainnet:rehearsal` (§8), report in `services/.local/mainnet-rehearsal/report.json`.

## 1. Program deploy

| item | bytes | SOL | kept / transient |
|---|---|---|---|
| ProgramData account (45 B header + 749,800 B .so) | 749,845 | **3.809863** | kept (rent; recoverable only by closing the program) |
| Program account | 36 | 0.000833 | kept |
| Deploy buffer (37 B header + .so) | 749,837 | 3.809822 | **transient**: needed during the deploy, refunded when the deploy instruction consumes it |
| write transactions (≈ 780 × 5,000 lamports) + the final deploy tx, incl. priority at 20,000 µlamports/CU | — | **0.0040** (measured, §8) | fee |

- Peak balance the deployer needs for the deploy: ≈ **7.62 SOL** + fees; after it: 3.81 SOL stays locked in rent.
- `.so` size today 749,800 B (`build-program.ts`; same size for any program id). Headroom (`programHeadroomBytes`)
  costs 5,080 lamports per byte: +100 KiB = +0.520 SOL, +200 KiB = +1.040 SOL. Not needed at deploy: upgrades
  can extend permissionlessly later (MULTISIG.md "Bigger program").
- If a deploy fails midway the buffer keeps its 3.81 SOL until closed (`solana program close <buffer>`) or reused.

## 2. Accounts created by the bootstrap

| account | bytes | SOL | payer |
|---|---|---|---|
| FUMPAD DBC configs (`create_config` ×2: standard + the one-off first-coin config) | 2 × 1,048 | 2 × 0.005974 | deployer |
| Global (`initialize_global`) | 1,491 | 0.008225 | deployer |
| admin Squads multisig (5 voters + ops key = 6 members; `132 + 33·n` bytes) | 330 | 0.002327 | deployer |
| guardian Squads multisig (3 voters + ops key) | 264 | 0.001991 | deployer |
| Squads multisig creation fee (`ProgramConfig.multisig_creation_fee`, mainnet, read 2026-10-13) | — | **0** | — |
| each governance vault transaction + proposal (accept_admin, pause drill, later upgrades) | ~250–400 | ≈ 0.002–0.004 each (estimate from Squads account sizes; not reclaimed: `rent_collector` = none) | ops key |
| the 4–5 bootstrap transactions (config, init, fund, propose_admin, upgrade authority) | — | ≈ 0.00004 base + ≤ 0.008 priority each (400k CU limit × 20,000 µlamports cap) | deployer |

## 3. Keeper working balances (not spent: balances the keepers draw on)

| key | role | funded to (bootstrap `fund`) | why |
|---|---|---|---|
| operator | **the jobs keeper** (`Global.operators[0]`: migrate, graduate, init observations/claim queue, samples, buybacks, fee claims, auto-claims) | **2.0 SOL** | graduation setup is fronted then refunded (§4); sample fees; `MIN_KEEPER_LAMPORTS` alert at 0.5 SOL |
| attestor-1 | attestor 1 (attestations only, `Global.keepers[0]`) | 0.3 SOL | position / ticket / marker rent (refunded on close) |
| attestor-2 | keeper slot 2 | **0.3 SOL** | attestation rent (Position / Ticket / Consumed) when it is the submitter, tx fees |
| attestor-3 | keeper slot 3 | **0.3 SOL** | same |
| launch-signer | API co-signer | 0 | never pays (only signs) |
| ops key | Squads initiate/execute | 0.05 SOL | vault tx + proposal rent, execute fees |

## 4. Per-coin costs (who pays, and from what)

**Graduation (85 SOL curve).** The DBC migration fee is 1% of the 85 SOL raise = **0.85 SOL** per coin, paid to
FUMPAD's fee claimer inside `graduate` and spent there as the "setup budget" (INTERFACE-v0.7 §graduate):

| setup item | bytes | SOL (mainnet rent) | funded by |
|---|---|---|---|
| ClaimQueue (9 × `init_claim_queue`) | 81,976 | 0.417088 | pre-funded from the migration fee |
| Observations (`init_observations`) | 8,280 | 0.042713 | pre-funded from the migration fee |
| migrator's flash rent for the DAMM v2 pool/position/NFT/vaults (DBC `migration_damm_v2` via `migrate_pool`) | — | refunded to the keeper (`coin.migrator_cost`) | migration fee |
| **total pre-funded rent** | | **0.459801** | |
| remainder of the 0.85 SOL after refunds | | → `platform_fees_unclaimed` | — |

So 0.85 SOL covers the 0.46 SOL of PDAs plus the migrator refund. What the jobs keeper really pays per graduation
is transaction fees (migrate_pool, graduate, init tx): measured in §8.

**Per attested sell (ticket).** The submitting keeper pays rent, refunded when the account closes:

| account | bytes | SOL | refunded when |
|---|---|---|---|
| Ticket | 276 | 0.002052 | `close_ticket` (claimed / expired) |
| Consumed marker | 98 | 0.001148 | `close_consumed` (7 days after the sell) |
| Position (first ticket of a wallet on a coin) | 315 | 0.002250 | `close_position` |
| fees: 1 tx (Ed25519 verify ix + `attest_sell`, keeper fee payer) | — | 0.000005 + priority | — |

→ 0.0032 SOL per ticket (0.0055 for a wallet's first on a coin) of **float**, returned on close. 100 open tickets ≈
0.32–0.55 SOL tied up. Rebuy debits (`attest_rebuy`) only pay the consumed marker (0.001148, refunded).

**Samples (`record_samples`, jobs keeper).** Graduated coins get a keeper sample every 480 s (heartbeat) and every
15 s while near the trigger or a buyback is due; up to 10 coins per transaction, 1 signature each:

| graduated coins sampled | heartbeat only (180 tx/day per 10 coins) | all at full rate (5,760 tx/day per 10 coins) |
|---|---|---|
| 1–10 | 0.0009 SOL/day | 0.0288 SOL/day |
| 100 | 0.009 SOL/day | 0.288 SOL/day |

plus priority: the keeper bids the p75 of recent fees, clamped to [1,000, 1,000,000] µlamports/CU and ≤ 200,000
lamports per tx (`keeper/src/config.ts`); at today's p75 (0) it pays the floor, 1,000 µlamports × its CU limit
(≈ 0.0002 SOL per 200k-CU tx). `KEEPER_DAILY_BUDGET_SOL` (default 2) caps the jobs keeper's daily spend.

Other keeper transactions (fee claims every 10 min per coin with fees, buybacks, auto-claims, closes) are 1-signature
txs: 0.000005 SOL + priority each.

## 5. RPC providers (estimates, vendor list prices, 2026-10)

Four different companies (one per attestor + the watcher; DEPLOY-v07.md §8). The current shared Helius key 429s at
1 req/s on mainnet: unusable. Every endpoint must serve archive `getSignaturesForAddress` + `getTransaction` (v1).

| provider | plan (list price) | limits | source |
|---|---|---|---|
| Helius | Developer **$49/mo** · Business **$499/mo** · Professional $999/mo; overage $5 per M credits | 50 / 200 / 500 RPC req/s; 10M / 100M / 200M credits | [helius.dev/docs/billing/plans](https://www.helius.dev/docs/billing/plans) |
| QuickNode | Build **$49/mo** · Accelerate **$249/mo** · Scale $499/mo (monthly billing) | 50 / 125 / 250 req/s; 80M / 450M / 950M credits; Solana call = 30 credits | [quicknode.com/pricing](https://www.quicknode.com/pricing), [costbench summary](https://costbench.com/software/blockchain-nodes/quicknode/) |
| Triton One | pay as you go: **$125 prepaid minimum**, then $10 per M calls + $0.08/GB | — | [triton.one/pricing](https://triton.one/pricing) |
| Chainstack / Alchemy / a 2nd Helius account | similar tiers ($49–$499) | — | vendor pages |
| **App frontend key** (`NEXT_PUBLIC_SOLANA_RPC`, domain-restricted) | usually the A provider's plan, separate key | — | — |

**Estimate**: A = Helius Business ($499; indexer + api + jobs keeper are the heavy users; the attestors and the
watcher each use their own provider, DEPLOY-v07.md §1), B, C, D on
$49–$249 plans → **≈ $650–$1,250 / month**; a lean start (all four on ~$49 plans + Triton PAYG) ≈ $200–$300 / month
if the request rates fit (check with `rpc-check`, which measures the 429 threshold).

## 6. Railway (estimate)

Pro plan **$20/month per workspace** incl. $20 of usage; usage $20 per vCPU-month, $10 per GB-RAM-month, $0.05/GB
egress, $0.15/GB-month volumes ([railway.com/pricing](https://railway.com/pricing), summarized at
[budgetforge.dev](https://www.budgetforge.dev/tools/railway-pricing-2026)). The mainnet project: indexer, api,
grinder, keeper, attestor-1/2/3 (each in its own project), watcher, Postgres (+ the shared `waitlist-db`). At ~0.1–0.25 vCPU and 0.3–0.5 GB
average per service (devnet-like load; the grinder is CPU-bound while refilling its pool) → **≈ $80–$200 / month**
(estimate; check the devnet project's usage page for real numbers before sizing).

## 7. SOL needed at launch

| item | SOL |
|---|---|
| program data + program account rent (kept) | 3.8107 |
| deploy buffer (transient, refunded at the deploy) | 3.8098 |
| deploy fees (write txs + priority, measured §8) | 0.0040 |
| DBC config + Global | 0.0119 |
| Squads multisigs ×2 (creation fee 0) | 0.0043 |
| keepers: operator 2.0 + attestor-1/2/3 0.3 each (working balances) | 2.9000 |
| ops key | 0.05 |
| bootstrap/governance tx fees + priority margin | 0.05 |
| **deployer must hold at the start (peak)** | **≈ 11.0 SOL** (incl. ≈ 4.09 SOL refunded by the deploy; program data 804,472 bytes since 2026-10-13 d) |
| **ends up committed** (rent locked + keeper balances) | **≈ 7.1 SOL** (≈ 4.1 rent, 2.9 working balances, ~0.1 fees) |

Not included: the team's own first coin and test trades, priority-fee spikes on deploy day (raise
`computeUnitPriceMicroLamports` if the p75 is non-zero; each 10,000 µlamports adds ≈ 0.004 SOL per 400k-CU tx and
a few thousandths of a SOL over the deploy's write transactions).

## 8. Measured in the rehearsal (local fork of mainnet)

`npm run mainnet:rehearsal`, 2026-10-13 (`services/.local/mainnet-rehearsal/report.json`). The validator charges
6,960 lamports per byte; the "at mainnet rent" column re-prices the rent part at 5,080 (fees unchanged).

| what | measured (local) | rent part (local) | fees | at mainnet rent |
|---|---|---|---|---|
| program deploy, deployer net outflow (buffer refunded) | 5.224926 | 5.220954 | **0.003972** | **3.814668** |
| create 2 Squads multisigs (6 + 4 members) | 0.005936 | 0.005916 | 0.000020 | 0.004338 |
| create_config + initialize_global | 0.016373 | 0.016342 | 0.000031 | 0.011959 |
| fund 3 keepers | 2.600013 | — | 0.000013 | 2.600013 |
| 2 attested sells (2 × Position + Ticket + Consumed, submitting keepers) | 0.015002 | 0.014936 | 0.000066 | 0.010966 (float, refunded on close) |
| one graduation, jobs keeper net (migrate_pool + graduate + init_observations + 9 × init_claim_queue, with concurrent samples) | **0.000073** | 0 (pre-funded from the 0.85 SOL migration fee, flash rent refunded) | 0.000073 | 0.000073 |

The graduation figure is the important one: at the higher local rent (ClaimQueue + Observations = 0.63 SOL there)
the 0.85 SOL migration fee still covered everything, so on mainnet (0.46 SOL) the keeper's per-graduation cost is
its transaction fees.
