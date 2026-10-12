# Research — Graduation venue: PumpSwap vs Meteora

Status: research note · 2026-10-12 · Scope: SPEC D7 / D11 / §1 / §4. Mechanisms and fee rates only, with no volume or revenue projections.

## 0. Sources read (and versions)

| Source | Version / date read |
|---|---|
| `MeteoraAg/damm-v2` (program `cp-amm`), cloned | commit `a85c926` (2026-09-08), crate `0.2.4`, CHANGELOG through 0.2.4 |
| `MeteoraAg/dynamic-bonding-curve`, cloned | commit `f552f20` (2026-09-09) |
| docs.meteora.ag pages (fetched 2026-10-12): DAMM v2 *What is*, *Fees overview*, *Time scheduler*, *Dynamic fees*, *Compounding liquidity*, *NFT positions*, *Token 2022 support*, *Developer guide*, *Rust CPI*; DBC *What is*, *Fees*, *Migration and liquidity*; DLMM *What is*, *Formulas*, *Collect fee mode*, *Token 2022*, *Program instructions*, *Dynamic positions*; DAMM v1 *What is*; *Protocol revenues*; *Audits* (DAMM v2, DBC, DLMM) | live docs, 2026-10-12 |
| Jupiter developer docs, *Market Listing* (`developers.jup.ag/docs/swap/routing/amm/market-listing`) | 2026-10-12 |
| Solana mainnet RPC `getAccountInfo` on program and programdata accounts; `getBlockTime` | 2026-10-12 |
| OtterSec verify API (`verify.osec.io/status/<program>`) | 2026-10-12 |
| Local pump docs: `contracts/external-idl/pump-docs/PUMP_SWAP_README.md`, `FEE_PROGRAM_README.md` | as in repo (2026-10-11) |
| Axiom docs (`docs.axiom.trade`), GMGN docs (`docs.gmgn.ai`), Bags docs (`docs.bags.fm/principles/program-ids`) | 2026-10-12 |

Code references below are paths inside `damm-v2/programs/cp-amm/src/` at the commit above.

---

## 1. Meteora products for graduation

| Product | Mainnet program ID (= devnet unless noted) | Status per Meteora | Fit for FUMPAD |
|---|---|---|---|
| **DAMM v2** (`cp-amm`) | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` (docs: same ID on mainnet and devnet; `lib.rs:42`) | Current AMM; DBC's required migration target | **Candidate** |
| DAMM v1 (dynamic AMM) | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | "Legacy product"; DBC: "deprecated for new configs and new pools" | No |
| DLMM (`lb_clmm`) | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Current, concentrated bins | Poor fit (see below) |
| DBC (Dynamic Bonding Curve) | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | Current launch product; migrates to DAMM v2 only | No (replaces our curve) |

On-chain state (mainnet RPC, 2026-10-12): all four Meteora programs are **upgradeable**, with the same upgrade authority `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd` (a System-owned, zero-data account, so it is either a keypair or a Squads-style vault PDA; I could not tell which). Last deploys: DAMM v2 at slot 445230614 (2026-09-08), DBC at 445503633 (2026-09-09), DAMM v1 at 442210200, DLMM at 423977638. For comparison, PumpSwap is also upgradeable (authority `7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8`, last deploy slot 454596406 = 2026-10-08). According to the OtterSec verify API, neither DAMM v2 nor PumpSwap has a verified build. So I could not prove that the deployed DAMM v2 bytecode equals repo `0.2.4`. The deploy date lines up with the 0.2.4 commit, but that is the only evidence.

### 1.1 DAMM v2: pool creation, Token-2022, quote tokens

There are three creation paths (README; `instructions/initialize_pool/*`):

| Path | Who can call | Pool PDA | Fees |
|---|---|---|---|
| `initialize_customizable_pool` | **Anyone** (payer signs; `creator` is an unchecked account and receives the position NFT) | `["cpool", max(mintA,mintB), min(mintA,mintB)]`, so **one per pair, ever** | Passed per pool |
| `initialize_pool` (static config) | Anyone if the config's `pool_creator_authority` is default; otherwise only that address | `["pool", config, max, min]` | Fixed in the operator-created config |
| `initialize_pool_with_dynamic_config` | Only `config.pool_creator_authority` (a `Signer`, so a PDA can sign via CPI) | `["pool", config, max, min]` | Passed per pool |

- Configs can only be created by **Meteora operators** (`create_config` / `create_dynamic_config` are gated by `OperatorPermission::CreateConfigKey`, `lib.rs:85-101`). A *private* dynamic config with `pool_creator_authority = FUMPAD PDA` would therefore require a one-time action by Meteora.
- **Token-2022:** the permissionless allowlist (`utils/token.rs:223-262`; docs *Token 2022 support*) is `TransferFeeConfig`, `MetadataPointer`, `TokenMetadata`, and `TransferHook` only when both the hook program and the hook authority are unset. Any other extension needs a Meteora-issued token badge, or a private config with `CreatePoolWithoutMintValidation` (added in 0.2.4). **The FUMPAD mint (SPEC §3: metadata-pointer + token-metadata only, no freeze authority) passes permissionlessly on every path.** Token-2022 wrapped SOL is rejected; use the classic WSOL mint `So111…112`.
- **Quote token:** the SOL/USDC constraint was removed in 0.1.6 (CHANGELOG: "Remove constraints for quote tokens (SOL/USDC)" for the dynamic-config and customizable paths). WSOL works.
- **Ownership proof:** creation transfers at least 1 base unit of each token from the payer (`ix_initialize_customizable_pool.rs`: "require at least 1 lamport to prove ownership"). **Any holder of a FUMPAD coin can therefore create the coin's one-and-only customizable pool before we do**, for rent (~0.02 SOL by my estimate) plus dust. That is a **graduation-griefing vector** that PumpSwap does not have, because PumpSwap's PDA includes `creator`. See §6.

### 1.2 DLMM
- Permissionless creation (`initialize_lb_pair2`, `initialize_customizable_permissionless_lb_pair2`) with Token-2022 support. The allowlist matches DAMM v2, and DLMM rejects mints that have a freeze authority (docs).
- Concentrated, binned liquidity. Bin step is at most 400 bps, and a position covers at most 1,400 bins. The docs say a position "stops earning trading fees" when price leaves its range, so DLMM needs active management.
- Locking: positions have only a `lock_release_point` (time lock). Unlike DAMM v2, the docs describe **no permanent-lock primitive**.
- Fee cap is 10% (`MAX_FEE_RATE = 100,000,000`). Protocol share is 10% on standard pools and 20% on launch pools (docs *Formulas*, *Protocol revenues*).

### 1.3 DAMM v1
Legacy. LP-token model on top of Meteora Dynamic Vaults. Standard constant-product pools charge a fixed 0.25% fee with a 20% protocol share. Meteora recommends DAMM v2 for new pools. I did not evaluate it further.

### 1.4 DBC and its built-in migration
- DBC is a **complete launchpad curve** (virtual pool, up to 16 curve segments, fee schedulers). When the quote threshold is reached it migrates to **DAMM v2 only** (DAMM v1 is deprecated for new configs).
- DBC economics (docs *DBC Fees*):
  - Protocol takes 20% of every curve trading fee. The minimum curve base fee is 0.25%.
  - A **fixed 0.2% protocol liquidity migration fee** is deducted from the migrated liquidity.
  - Partner and creator split the remaining 80%.
  - Migrated pools use fixed fee options of 0.25/0.3/1/2/4/6% or `Customizable` (`dynamic-bonding-curve/.../state/config.rs:459`).
  - At least 10% of liquidity must stay locked at day 1, and vesting is capped at 2 years.
- Using DBC would mean **dropping FUMPAD's own curve (D7)** together with everything attached to it: tickets, the D10/D12 reference floor, the D19 snipe tax and inline buyback. FUMPAD cannot add logic inside DBC swaps. **Not viable** without a full redesign. The useful takeaway is that DBC's own graduation target is DAMM v2 with permanently locked position NFTs, which is the pattern recommended below. Bags (`docs.bags.fm/principles/program-ids`) is a live launchpad running DBC → DAMM v2 in exactly this way.

---

## 2. Fee configuration

### 2.1 DAMM v2 (verified in code)
- **Denominator** is 1e9. **Minimum fee** is 1 bps (`MIN_FEE_NUMERATOR = 100_000`). **Maximum total fee** (base + dynamic) is **99%** for pool version 1 (current) and 50% for v0 (`constants.rs` `MAX_FEE_NUMERATOR_V1`; `state/fee.rs:122-138` clamps to it). **A custom pool creator can set a static 1%–5% fee, or anything from 0.01% to 99%.**
- **Base fee modes for new pools:**
  - Time scheduler, linear or exponential. Uses cliff fee, number of periods, period frequency and reduction factor; setting all three of the latter to 0 gives a fixed fee.
  - Market-cap scheduler, linear or exponential. The fee steps down as √price rises above the initial price, with an expiration.
  - The rate limiter is deprecated for new pools (0.2.3).
  - This gives **native anti-sniper fees on the graduated pool**, e.g. 50% decaying to 1% over a few minutes.
- **Dynamic (volatility) fee:** optional, added on top of the base fee. `bin_step` is fixed at 1 bps. Parameters are `filter_period < decay_period`, `reduction_factor ≤ 10000`, and `variable_fee_control` and `max_volatility_accumulator` each ≤ 0xFFFFFF (`params/fee_parameters.rs`).
- **Who receives fees** (`params/fee_parameters.rs`, `state/fee.rs:240-280`; docs *Protocol revenues*):
  - **Protocol** gets **20% of the trading fee**. This is a hard constant `PROTOCOL_FEE_PERCENT = 20` for customizable and dynamic-config pools.
  - **Referral** gets 20% *of the protocol fee*, i.e. 4% of the trading fee, when the swap passes a referral token account. It does not increase what the trader pays.
  - **LPs** (position holders, pro-rata to total position liquidity) get the remaining 80%.
  - Since 0.2.0 there is **no partner/creator fee share** in DAMM v2: the `partner_fee` feature was removed (CHANGELOG 0.2.0). The partner/creator split exists only in DBC.
- **Collect-fee modes:**
  - `BothToken`: the fee comes from the output token, so buys pay in base and sells pay in SOL.
  - `OnlyB`: all fees in token B (SOL).
  - `Compounding`: full-range x·y=k, fees in token B, and `compounding_fee_bps` (1–10000) of the LP fee is reinvested into reserves while the rest stays claimable.
- **Fee claiming is separate from liquidity.** Fees accrue per position (`fee_a/b_per_token`, using **total** position liquidity including permanently locked liquidity: `state/position.rs:159,247-252`) and are withdrawn with `claim_position_fee`. The signer must own the token account holding the position NFT, or be a delegate with `ClaimPositionFee` permission (`state/position.rs:566`). No liquidity is removed, and **a permanently locked position still claims fees** (docs *NFT positions*: "Locked liquidity still earns"). Claiming is not gated by pool status (`pool_action_access/permissionless.rs`).
- **Native locking:** `permanent_lock_position` (cannot be undone in the program logic) and `lock_position` / `lock_inner_position` (vesting, up to 10 years).

### 2.2 PumpSwap non-canonical (for comparison)
- Charges 0.20% LP + 0.05% protocol = 0.25% (SPEC §1; `PUMP_SWAP_README.md:56`). These are global `flatFees` set by Pump's admin (`FEE_PROGRAM_README.md`: non-canonical pools use `feeConfig.flatFees`). **The pool creator cannot choose fees.** There is no fee scheduler and no creator fee.
- Our share is 80% of the trading fee (0.20 of 0.25), which **equals DAMM v2's LP share at the same 0.25% total**. The difference is that DAMM v2 lets FUMPAD pick the total fee.

### 2.3 DLMM / DBC
DLMM: base + variable fee, capped at 10%, LP share 90% on standard pools. DBC: see §1.4.

---

## 3. Routing and discoverability

- **Jupiter (Metis)** routes new markets on listed DEXes immediately ("instant routing"). The list includes **Meteora DAMM V2, Meteora DLMM, Meteora DBC, Meteora Dynamic AMM, Pump.fun AMM (PumpSwap)** and Pump.fun.
  - The grace period is **29 days from token creation** (token age, not pool age). During it the liquidity criteria do not apply.
  - After that, every 30 minutes a market must pass one of two tests: a $500 round trip losing less than 30%, or a $1000-vs-$500 price-impact difference under 20%.
  - The page states **no fee cap or fee threshold**. A high-fee pool stays routable, but Jupiter picks routes by net output, so **a higher fee only holds volume while no cheaper pool for the same pair has comparable depth**. That is my reading of best-output routing, not something the docs state. With ~85 SOL locked, a 1–5% fee pool should pass the $500 round-trip test after grace: the fee costs about 2× fee on a round trip, which is well under 30%. This is arithmetic I did not test.
- **Both venues are equal for Jupiter discovery.** Neither gives FUMPAD coins a "graduated from pump.fun" label, because PumpSwap pools that pump's `migrate` did not create are ordinary non-canonical pools.
- **Trading terminals (Axiom, Photon, GMGN, BullX): could not verify from primary sources.**
  - Axiom's public docs still describe "migration to Raydium" (outdated). GMGN's docs mention neither PumpSwap nor Meteora.
  - The only first-party statement is Meteora's own (*DBC token launch pool*): tokens are "tradable across trading terminals such as Jupiter Pro, Axiom, and Photon".
  - DBC → DAMM v2 launchpads (Bags, Believe, Jupiter Studio) trade on these terminals in practice, so DAMM v2 support is very likely. Terminal "Pulse/new pairs" feeds key off *launchpad programs* they index (pump.fun, DBC, …). Our own curve is in none of these feeds whichever venue we graduate to.
  - **This needs a manual check:** create a devnet/mainnet test pool and confirm that each terminal shows a chart and lets you trade.

---

## 4. CPI integration (DAMM v2)

- **Pool creation, lock and claim by CPI: yes.** The docs (*Rust CPI*) explicitly support Anchor CPI and recommend generating bindings from the published IDL (`damm-v2-sdk/src/idl/cp_amm.json`) or using the `cp-amm` crate with `features=["cpi"]`. Graduation would run:
  1. `initialize_customizable_pool`, or `initialize_pool_with_dynamic_config` with FUMPAD's PDA as `pool_creator_authority` signer. Passes:
     - `creator` = the locker PDA
     - `payer` = FUMPAD PDA holding the curve tokens + WSOL
     - `position_nft_mint` = a fresh keypair signer (as in today's pool creation)
     - event-CPI accounts
     - The pool mints the position NFT to `["position_nft_account", nft_mint]` with authority = `creator`.
  2. `permanent_lock_position(all liquidity)`, signed by the NFT owner, i.e. the locker PDA via `invoke_signed`.
  3. Later, `claim_position_fee` via CPI from the locker.

  All of this can fit in one `graduate` transaction, subject to CU and size checks. Account count and CU are **unverified**: DAMM v2 pool creation plus NFT mint likely needs more than today's ~270k CU and a lookup table.
- **Swaps through our router:** `swap2` has a fixed account list: pool_authority, pool, user in/out accounts, vaults, mints, payer, token programs, optional referral account, event authority, program. **Passing FUMPAD's WSOL ATA as `referral_token_account` earns 20% of the protocol fee (4% of the trading fee) on swaps routed through FUMPAD.** I have not tested whether the referral account must be a specific mint/ATA. Rate-limiter pools need the instructions sysvar, but new pools cannot use the rate limiter.
- **Breaking-change history** (CHANGELOG 0.1.1 → 0.2.4, roughly 2025 to Sep 2026):
  - Mostly additive. The breaking items were renamed signer accounts (`owner` → `signer`, 0.2.2, without changing order or count), new error codes, a new `permission` arg on admin `create_*config`, event field changes, and removal of `partner_fee`/`claim_partner_fee` (0.2.0).
  - **None changed the `swap` account list for non-rate-limiter pools.** Compare PumpSwap, which made buy/sell account additions mandatory (e.g. Sep 1, `FEE_PROGRAM_README.md`).
  - The program is still upgradeable (§1).
- **Admin / pausability levers on *our* pool** (`lib.rs` access control, `instructions/operator/*`, `state/pool.rs:1182-1270`):
  - `set_pool_status(Disable)`: blocks swap, add liquidity, position create/lock/split. It does **not** block remove-liquidity or fee claims.
  - `update_pool_fees`:
    - Can change the static base fee **up to a 10% cap** (`MAX_FEE_NUMERATOR_POST_UPDATE`), but only after any scheduler has finished.
    - Can enable, update or disable the dynamic fee.
    - On `Compounding` pools it can set `compounding_fee_bps` up to 10000, i.e. **send 100% of LP fees into locked reserves so our claimable fee becomes 0**. → **Avoid `Compounding` mode.**
  - Operators are accounts created by two hard-coded admins (`instructions/admin/auth.rs`), plus the program upgrade authority.
  - PumpSwap's equivalent levers are `update_fee_config` (global), `disable_flags`, and upgrades.
- **Audits:** Meteora's audit page lists DAMM v2 audits by Zenith (versions 0.1.2–0.2.0, June 2025), Offside Labs (0.1.5–**0.2.4**, June 2025) and OtterSec (0.1.5, Apr 2025). PDFs are in `github.com/MeteoraAg/audits/tree/main/damm-v2` (file list confirmed via the GitHub API; I did not read the PDFs). DBC has Offside, OtterSec and Zenith audits; DLMM has Zenith, Offside, OtterSec, Sherlock and Sec3.

---

## 5. Comparison

| | **PumpSwap non-canonical (today)** | **DAMM v2 (customizable / private dynamic config, OnlyB or BothToken, full range, permanent lock)** | DLMM | DBC | DAMM v1 |
|---|---|---|---|---|---|
| Fee captured by FUMPAD on **all** pool volume | 0.20% (80% of a fixed 0.25%) | **80% of a fee we choose** (0.01–99%; e.g. 1% total → 0.80%, 2% → 1.60%), **plus** an optional decaying anti-sniper scheduler and dynamic fee. Referral adds 4% of the fee on FUMPAD-routed swaps | 90% of a fee ≤10% (but only while in range) | 80% of curve fees minus partner/creator split, 0.2% migration fee, then DAMM v2 | 80% of 0.25% (fixed for standard pools) |
| Who pays | Every trader (bots, Jupiter, FUMPAD router), on top of our 1% router fee via FUMPAD | Same | Same | Same | Same |
| Fee token | Both (√k skim at pool ratio) | SOL only (`OnlyB`) or both (`BothToken`) | Input or Y | — | Both |
| LP lock | Our immutable `fumpad_lp_locker`, √k principal check | **Native `permanent_lock_position`**; fees claimed separately via NFT owner | Time lock only | Native (≥10% locked) | LP-token lock |
| Routing | Jupiter instant routing ✓ | Jupiter instant routing ✓ | ✓ | ✓ | ✓ |
| Terminals | Unverified (PumpSwap widely supported) | Unverified (DBC→DAMM v2 coins trade on Axiom/Photon per Meteora) | Unverified | — | — |
| Pool creation griefing | None (PDA includes our creator) | **Customizable path: anyone holding the coin can pre-create the single `cpool` PDA.** Private dynamic config: none, but needs Meteora to create the config | Unverified | — | — |
| Admin / upgrade risk | Upgradeable; admin sets global flat fees, `disable_flags`; history of mandatory account changes | Upgradeable; operators can pause swaps, change our base fee (≤10%) and dynamic fee; account list stable so far | Upgradeable | Upgradeable | Upgradeable, legacy |
| Integration effort (rough) | Done | **~2–3 weeks**: graduate CPI, new router path, locker rewrite (simpler), off-chain quoting, devnet tests; plus an audit delta | 3+ weeks; needs active range management | Full redesign | Not worth it |
| Effect on locker design | — | `√k` math, `POOL_LEN` layout parsing and the LP-withdraw skim all go away. The locker would hold the NFT, call `permanent_lock_position` once, then `claim_position_fee` → fixed FUMPAD destinations. Principal safety moves from our √k check to Meteora's permanent lock (trusts Meteora's upgradeable program, as today we trust PumpSwap's) | — | — | — |

**"In addition to" PumpSwap** (two pools per coin) splits the same ~85 SOL into two shallower pools. Jupiter splits routes and arbitrage keeps prices aligned, so total fee capture does not rise. Every trader gets worse depth, and we pay two creations. **Not recommended.** Pick one venue per coin and keep the venue abstraction (SPEC §1) as a fallback.

---

## 6. Recommendation

**Move graduation to Meteora DAMM v2, but only after the devnet checks below. Keep PumpSwap as the fallback venue.**

### Reasoning
1. **More fee per unit of volume at our discretion.** On PumpSwap the fee is fixed at 0.25% and set globally by Pump's admin. On DAMM v2, FUMPAD keeps the same 80% share of a fee it chooses, gets a native decaying anti-sniper fee at graduation (when sniping is heaviest), and can earn the 4% referral share on its own routed swaps.
2. **A simpler, safer locker.** Fees are claimed separately from liquidity on a permanently locked position, so the √k accounting, the 287-byte layout pin and the LP-withdraw skim all disappear. That removes the riskiest code in §3.1.
3. **SOL-denominated fees** (`OnlyB`) make the 60/40 settle step direct.
4. **Discoverability is the same as PumpSwap** on Jupiter (both instant-routed). DAMM v2's swap account list has been stabler than PumpSwap's.

### Design choices if adopted
- **Collect-fee mode:** `OnlyB` (or `BothToken`) with `sqrt_min_price = MIN_SQRT_PRICE`, `sqrt_max_price = MAX_SQRT_PRICE` (full range). **Not `Compounding`**, because an operator can raise `compounding_fee_bps` to 100% and zero our claimable fees.
- **Base fee:** a time scheduler with a high cliff decaying over minutes to a moderate static fee. Choosing the static fee is a product decision: a higher fee captures more per trade, but **anyone can open a cheaper pool for the coin**, and Jupiter routes to the best net output. The more our fee exceeds ~0.25–0.3%, the stronger the incentive for third-party LPs (DLMM LP farmers are common on memecoins) to fragment volume away. No projection is made here.
- **Keep the 50/30/20 split:**
  - With `OnlyB`, no base tokens accrue, so the token side for the reward pool must come from SOL.
  - Route the 50% share into the existing `buyback_lamports` → `execute_buyback` crank instead of the current "tokens → reward vault" path.
  - This changes SPEC §4.
- **Pool creation path:**
  - Preferred: ask Meteora for a **private dynamic config** with `pool_creator_authority = FUMPAD graduation PDA` (no griefing, fees still set per pool).
  - Otherwise: `initialize_customizable_pool`, with the rule that **if the `cpool` PDA already exists, `graduate` falls back to PumpSwap**. This needs the venue abstraction in the `Coin` state and the router.

### Risks
- Meteora is upgradeable; the authority type is unknown and there is no verified build. Operators can pause swaps or change our base fee (≤10%) and dynamic fee. This is comparable to PumpSwap's admin risk, not lower.
- The permanent lock is enforced by Meteora's program, not by our immutable code. Today the principal also depends on PumpSwap's `withdraw` semantics, so this is a change of trusted party, not a new kind of trust.
- Griefing of the customizable pool, unless a private config is obtained.
- Terminal support is unverified.
- Re-audit is needed for the graduate / router / locker changes.

### Verify on devnet first (same program ID on devnet)
1. Create a FUMPAD-style Token-2022 mint (metadata-pointer + metadata) / WSOL **customizable** pool via **CPI from an Anchor program**, with `creator` = a PDA. Check:
   - full-range bounds
   - `OnlyB`
   - a time-scheduler cliff of e.g. 50% decaying to the target
   - CU and transaction size against the current ~270k CU / ~1011-byte graduate. Try a lookup table.
2. `permanent_lock_position` via PDA `invoke_signed`. Then confirm that `remove_liquidity` / `remove_all_liquidity` fail and that `claim_position_fee` succeeds and pays SOL only.
3. Front-run test: pre-create the `cpool` PDA from another wallet holding 1 token unit. Confirm that `graduate` detects it and falls back cleanly.
4. Run `swap2` through the FUMPAD router CPI with `referral_token_account` = FUMPAD WSOL ATA. Confirm the referral receives 20% of the protocol fee and check the required account type.
5. Confirm on-chain that the pool's `protocol_fee_percent` is 20 and `fee_version` is 1 (99% cap).
6. Mainnet smoke test with a throwaway coin: Jupiter quote within minutes, plus a chart and trading on Axiom / Photon / GMGN / BullX.
7. Ask Meteora:
   - Is the upgrade authority a multisig?
   - Will they create a private dynamic config for FUMPAD's PDA?
   - What policy governs `update_pool_fees` / `set_pool_status` on third-party pools?

---

## 7. What I could not verify
- That the deployed DAMM v2 bytecode is repo `0.2.4` (unverified build), and whether the upgrade authority `JADaUV8…` is a multisig.
- Trading-terminal behaviour for DAMM v2 vs PumpSwap pools of non-launchpad coins. No current primary docs exist; the Axiom and GMGN docs are outdated or silent.
- Whether Jupiter applies any undocumented penalty or filter to high-fee pools. The docs list none.
- DLMM pool-PDA uniqueness and griefing (I did not read the `lb_clmm` source).
- The content of the audit PDFs (only the listing was confirmed).
- CU, account count and transaction size of a one-transaction DAMM v2 graduate + lock.
- Whether the `MAX_FEE_CURVE_*` (1 day) / `MAX_HIGH_TAX_*` (10 min) constants in `constants.rs` constrain fee schedulers. They appear only in a config "timing" struct (`state/config.rs:237-268`), not in scheduler validation.
