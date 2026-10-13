# FUMPAD × Meteora DBC / DAMM v2: devnet feasibility spike

2026-10-12 · devnet only · branch `worktree-agent-a36d6bd4c25af6ece` · code: `spike/meteora/`

**Bottom line:** every FUMPAD mechanism we need worked against Meteora's real devnet programs, using real transactions. That covers PDA fee claimer, an 8% reward pool via leftover, the D17 curve, a 1.25% fee with anti-snipe, CPI buy and sell with exact amounts, PDA fee claims with a 50/30/20 split, graduation with the LP 100% locked to our PDA, CPI swaps on DAMM v2, price reads, and keeper event parsing.

The main caveat is that **devnet DBC is not mainnet DBC**. Devnet runs the unreleased 0.2.2 branch. Mainnet is still on 0.2.1, which has no `create_config2` and no `EvtSwap3`. Section 1 has the evidence; section 13 lists the other surprises.

All links are `https://solscan.io/tx/<sig>?cluster=devnet` (full signatures and links are in `state.json` → `txs`). CU is the whole transaction, including a ~150 CU compute-budget instruction.

## Verdict table

| # | Item | Verdict |
|---|---|---|
| 1 | Program IDs on devnet vs mainnet | **PARTIAL**: same IDs, **different bytecode** (devnet DBC = 0.2.2, mainnet DBC = 0.2.1) |
| 2 | Config: PDA fee_claimer + leftover_receiver, WSOL, Token-2022, fixed 1B, DAMM v2, 100% partner lock | **PASS** |
| 3 | 8% reward pool via leftover | **PASS**: 80,000,080.39 tokens = 8.000008% landed in our PDA's ATA |
| 4 | D17 curve shape, 0.85 SOL devnet threshold | **PASS**: start MC 30.39 SOL, grad price ×14.7, curve 729.655M / LP 190.345M |
| 5 | 1.25% fee + anti-snipe + creator first-buy min fee | **PASS**: 99% → 1.25% over 8 slots; creator 1.25% vs sniper 99% in the same tx (with caveats, §5) |
| 6 | Claim partner fees via CPI with PDA signer + on-chain 50/30/20 | **PASS**; creator fee routed by us (DBC creator share set to 0) |
| 7 | Caller-chosen (vanity `…fmbL`) mint keypair | **PASS** |
| 8 | FUMPAD-routed DBC buy/sell via CPI with exact amounts | **PASS**: DBC routed 67.3k / 65.5k CU |
| 9 | Graduation → DAMM v2, LP NFT to our PDA, claim position fees via CPI | **PASS**: we called the permissionless migration ourselves |
| 10 | DAMM v2 CPI swaps + spot price from account data | **PASS**: routed 46.9k / 46.3k CU; price read 1.9k CU |
| 11 | Keeper data source (trader, side, in/out, fee) for third-party swaps | **PASS**: EvtSwap3 (devnet) / EvtSwap2 (mainnet) parsers, cross-checked equal |
| 12 | Blockers / complications / Meteora admin powers | No blocker; several design changes needed (§12) |

Devnet SOL (deployer `9HXgtr92…`): **4.749910952 → 4.498985357 SOL**, so **0.2509 SOL net spent**.

- Peak in-flight spend was about 1.9 SOL: 0.69 SOL program rent plus about 0.85 SOL for the curve raise.
- Recovered afterwards: the tokens were sold back on DAMM v2, the helper wallets were swept back to the deployer, and `solana program close` reclaimed 0.688467 SOL.
- The spike program `8zt6gZTFwn6Dn5YRhu7jsywR5tQnZZCx1YmrbqLVTbeW` is closed. Its PDAs still own the devnet LP NFT and the reward-pool tokens, which are now permanently stranded. That is fine on devnet.
- Deploy tx: `4NsEUArBQwbPJgqzq5AGC8QvpjeVAuXGE9g139a7ZA5Nnd5qwAyxmuzSXLMnFdFwFjRRkAAzaqAhKAkP1AL2vnUa`.

---

## 1. Program IDs, devnet vs mainnet: PARTIAL

`scripts/01_program_ids.ts`, `01b_ix_diff.ts` and `08_mainnet_event_check.ts`. All mainnet access was read-only `getAccountInfo` / `getTransaction`; no mainnet transaction was sent.

| | DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
|---|---|---|
| programdata (both clusters) | `HUfnSSiJxgspQm6C1rkqv6L3XgVtn7AESApgCQpCXCYh` | `AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH` |
| devnet last deploy | slot 508712305, **2026-10-08** | slot 503166267, 2026-09-23 |
| mainnet last deploy | slot 445503633, 2026-09-09 | slot 445230614, 2026-09-08 |
| ELF sha256 devnet | `9f652df38b27…1753b0d` (1,693,313 B) | `f838b2ae3ed2…d8a29a9c` (1,430,785 B) |
| ELF sha256 mainnet | `b3f7b765e1b9…9dfe6c44` (1,670,513 B) | `7c479dd7de72…5719d94e0` (1,433,913 B) |
| upgrade authority devnet | `DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX` | same |
| upgrade authority mainnet | `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd` | same |

- **Devnet DBC is the unreleased `release_0.2.2` branch of github.com/MeteoraAg/dynamic-bonding-curve.** `main` is still at 0.2.1. The evidence:
  - The devnet ELF contains the `CreateConfig2Instruction` and `InvalidFeeClaimer` strings; mainnet does not.
  - The 15 most recent successful mainnet DBC transactions inspected emit only `EvtSwap` + `EvtSwap2`. Devnet swaps also emit `EvtSwap3`.
  - So **`create_config2` and `EvtSwap3` exist only on devnet today.**
  - The 0.2.2 changelog adds `create_config2`, transfer-fee base mints, `EvtSwap3` and `EvtCreateConfig3`, and deprecates `create_config`.
- **DAMM v2:** the devnet build is newer than mainnet, but the instruction and identifier strings are identical. Every DAMM v2 call we made matches the public 0.2.4 source.
- **Implication for the rewrite:**
  - Code against `create_config` (still accepted on 0.2.2, deprecated) or feature-detect `create_config2`.
  - The keeper parser must read DBC `EvtSwap2` on mainnet. `events.ts` does this as a fallback, verified equal to EvtSwap3.
  - Re-run `01_program_ids.ts` before mainnet. Meteora can upgrade either program at any time.
- **Upgrade authorities:** both are system-owned accounts with no data. That is consistent with a plain keypair or a Squads vault PDA. **UNVERIFIED** whether either is a multisig.
- The on-chain Anchor IDL accounts on both clusters are stale (DBC 0.1.10, DAMM 0.2.0), so don't use them. Use the SDK IDLs or the source.

## 2. Config with PDAs as fee_claimer and leftover_receiver: PASS

`scripts/02_config.ts`. Config `Fy6YvfaHVYmh7cr7fZYUaxAqTU7yPYLNuSABwQDe2UGt`, created with **`create_config2`**, tx `29FUdAGmfQei86mHXyx2bhXD3NeHGZAC5G3jgRpeF8pW93JjLbDkt7qfCwHuquTCBmA7vqcQ42f2RJNWMGinR3bW`, 36,857 CU, rent 0.00597 SOL (1,048 B).

**Mechanism:**
- SDK 1.5.13 only knows `create_config`. Its instruction was rewritten with:
  - discriminator `create_config2` = `[9,202,24,203,143,212,252,81]`
  - the same `CreateConfigCtx` accounts
  - a trailing `0u8` for `Option<TransferFeeParameters>::None`
- `fee_claimer` = `PDA["fee_claimer"]` = `62zbYVRGAHGgURnZcsZyZQnGRZW1YxiyP2pbRtauUYTz`.
- `leftover_receiver` = `PDA["reward_pool"]` = `BTSbBbkd3Wmuywc4aAJmaK6Z7X8wUrPN68YiHwZ3vUuy`.
- Neither needs to sign at creation. Both are `UncheckedAccount`; the only check is that `fee_claimer` is not the default key for partner-authority token options.

Decoded on-chain:

| Field | Value |
|---|---|
| quote | WSOL |
| `tokenType` | 1 (Token-2022) |
| `activationType` | 0 (slot) |
| `collectFeeMode` | 0 (quote) |
| `migrationOption` | 1 (DAMM v2) |
| `migrationFeeOption` | 6 (Customizable) |
| `partnerPermanentLockedLiquidityPercentage` | **100** |
| `creatorTradingFeePercentage` | 0 |
| fixed supply | pre = post = 1,000,000,000.000000 |
| `migratedPoolFeeBps` | 125 |
| migrated collect mode | quote (→ DAMM `OnlyB`) |
| `enableFirstSwapWithMinFee` | 1 |

Notes:
- **100% partner permanent lock is allowed.** The rule is that ≥10% of liquidity must be locked at day 1 (`MIN_LOCKED_LIQUIDITY_BPS`), so 100% passes. The six liquidity percentages must sum to 100.
- **Token-2022 blocks nothing.** The DBC-created mint has only the MetadataPointer and TokenMetadata extensions; mint authority and freeze authority are both `None` after init (§7). This matches SPEC §3. Do not use the transfer-hook config.
- One config serves every coin: we created a second pool on it (§7). Fee claimer and leftover receiver are global, but all accounting is per pool / per mint.
- **Parameter changes = a new config**, just as D14 snapshots params per coin. DBC configs are immutable, and existing pools keep their config.

## 3. 8% reward pool via leftover: PASS

`scripts/05_graduate.ts`.

**Mechanism:**
- Fixed supply 1B. On chain the config computed `swap_base_amount` = 729,655,071.047103 (curve) and `migration_base_threshold` = 190,344,848.558628 (DAMM deposit).
- Leftover = 1B − curve − migration = **80,000,080.394269** (config expectation).
- After `migration_damm_v2`, the permissionless `withdraw_leftover` (tx `2yR8YRpnuYsAXDnagKR7aeiQ4WGBN3WnNo39pZJfr8g3woEAfknhFFP3eRKAMzmSJYa4S5CTW7cwJLakyvQffzqn`, 16,893 CU) moved **80,000,080.394278** tokens into the canonical Token-2022 ATA of `PDA["reward_pool"]`. That is **8.000008% of supply**.
- Mint supply stays exactly 1,000,000,000: nothing is burned because post = pre.
- It is exact because 0.2.x swaps can never pass the migration price (§4). The tokens sold at completion always equal `swap_base_amount`. The 0.2% protocol migration base fee is excluded from the leftover separately (380,689.697117 tokens stayed in the DBC vault for Meteora).

**Constraints:**
- `withdraw_leftover` pays only to `ATA(leftover_receiver, mint)`. FUMPAD's reward vault must therefore be that ATA, not a custom `["reward_vault", mint]` PDA vault.
- The 8% only arrives **after migration**. Before graduation the reward pool holds only buyback tokens. That is compatible with D1 (only graduated coins are claimable).
- It is permissionless, and becomes signer-gated only if the leftover has a transfer fee. A keeper or the migrator can call it in the same flow.

**Alternatives considered:**
- *Locked vesting* (`lockedVesting` → Meteora Locker escrow): worse. It adds a vesting escrow owned by the Locker program, cliff/period semantics, and an extra claim CPI. It also takes the tokens out of the fixed-supply math (`pre ≥ swap + migration + vesting`).
- *Partner first buy*: buys at the curve price. That costs SOL and is not a fixed share.

Leftover is the cleanest mechanism.

## 4. Curve shape (D17): PASS

`scripts/curve.ts`. The SDK builder is `buildCurve(percentageSupplyOnMigration = 19.0344827586, migrationQuoteThreshold, leftover = 80M)`. A one-segment DBC curve (constant liquidity between two sqrt prices) is exactly a constant-product curve with virtual reserves. With F = 0 (DBC has no graduation fee) it reproduces SPEC §3's "v0.4 (F = 0)" column:

| | Mainnet (threshold 85 SOL) | Devnet (0.85 SOL), on chain |
|---|---|---|
| start price / MC | 3.03896e-8 SOL, **MC 30.39 SOL** (= pump's 30 SOL virtual over 987.18M tokens) | 3.03896e-10 SOL, MC 0.304 SOL |
| graduation price | 4.46558e-7 SOL (×14.69 = (115/30)²) | 4.46558e-9 SOL |
| curve tokens | 729,655,162 | 729,655,071 |
| LP tokens | ≈190.345M | 190,344,849 |
| reward (leftover) | 80M | 80,000,080 |
| `sqrt_start_price` / migration sqrt | 101690894105090057 / 389815088656433800 | 10169090682030081 / 38981508865643380 |

- **Minimums:**
  - `migration_quote_threshold > 0` is the only threshold rule. 0.85 SOL worked end to end, including the DAMM v2 migration.
  - `MIN_SQRT_PRICE` = 4295048016.
  - Token decimals 6–9.
  - At most 16 curve points.
  - Pool creation fee is 0, or between 0.001 and 100 SOL.
- **Overshoot fails:** a buy that would cross the migration price fails with `InsufficientLiquidity` (6033; reproduced in simulation). The completing buy must use `swap2` with **PartialFill** (`2BNBMLCHdaD3AUt2CcidYSQPxt9762mhguvoA3v7hUiCsE4yWTcnYeJpfskSVoC7yMBLGHiSgquqT2MuH7VQiYuB`, 50,592 CU), which takes only what fits. The curve then completed at quote reserve 850,000,002 (2 lamports of surplus).
- **The SDK adds a second segment up to MAX_SQRT_PRICE.** It exists only to satisfy the fixed-supply buffer check (`pre ≥ min(1.25·swap, base on curve) + migration_base`), and nothing can trade on it.

## 5. Fees, anti-snipe, creator first buy: PASS (with caveats)

`scripts/03_launch.ts`.

**Base fee:** linear scheduler with cliff 99% (990,000,000 / 1e9), reduction 122,187,500 per period, 8 periods, period = 1 slot (activation type slot). That gives 99 / 86.8 / 74.6 / 62.3 / 50.1 / 37.9 / 25.7 / 13.5% at slot offsets 0–7 and 1.25% from offset 8, about 3.2 s.
- **The finest granularity is 1 slot** (activation type slot, `period_frequency = 1`). With timestamp activation the finest granularity is 1 second.
- Fee bounds: minimum 0.25%, maximum 99%.

**Fee split, measured on every swap:** `trading_fee : protocol_fee` = 80 : 20. 1.25% total gives **1.00% to us** (partner, creator share 0) and 0.25% to Meteora. Collected in SOL (WSOL) on both buys and sells.

**Launch tx** `4nd6oVwaF1rxpMq64Yi1XyYaqouWJckd54jwwrYhRf1zgferP3wt37xhRkdVMZHXoTLpQpc3iijBvZTwtD7Y4Cyi` (188,748 CU, slot 510462803 = pool `activation_point`), all in one transaction: `initialize_virtual_pool_with_token2022` → creator `swap2` 0.02 SOL → sniper `swap2` 0.01 SOL. Both swaps were top-level and passed the instructions sysvar as a remaining account.
- Creator: fee **1.25%** (200,000 + 50,000 lamports). `eligible_for_first_swap_with_min_fee`.
- Sniper, same tx and same slot: fee **99%** (7,920,000 + 1,980,000).
- Later probes (`5Rrf6WZK…` and nine more):
  - offset 7 paid **13.4687%** (= 99 − 7 × 12.21875)
  - offsets 8–20 paid **1.25%**
  - Probes for offsets 1–6 did not land in time; the schedule is deterministic from the source (`FeeScheduler::get_base_fee_numerator`).

**Caveats vs D19:**
1. **The exemption is not creator-bound.** It goes to whichever swap is the pool's first, in the creation tx, after the init instruction (`validate_contain_initialize_pool_ix_and_no_cpi`). FUMPAD's backend builds and co-signs the launch tx (D18), so it controls the order.
2. **The exempt swap must be top-level.** The check requires the current instruction's program id to be DBC, with no referral account. So the creator's first buy **cannot go through the FUMPAD router**: no Position or ticket bookkeeping in that instruction. This is source-verified; we did not send a failing CPI variant.
3. **The snipe fee also applies to sells** in the window (the scheduler ignores trade direction). D19 taxed buys only.
4. **The snipe fee is not paid to the reward pool.** It joins the ordinary fee pot: 80% to us, 20% to Meteora. FUMPAD's 50/30/20 split then sends 50% of our share to buyback. To keep "100% of the tax → reward pool", either:
   - reconstruct the tax per coin from swap events off-chain, or
   - let `claim_fees` send everything claimed from the launch window to buyback (`partner_quote_fee` is cumulative per pool, so claim right after the window).

   The spike did not test this.
5. `RateLimiter` mode (size-based) is deprecated for new configs. It would also block CPI swaps during its window (`validate_single_swap_instruction`). Don't use it.

## 6. Partner fee claim via CPI + 50/30/20: PASS

`spike_program::claim_and_split`.

**Mechanism:**
- CPI into DBC `claim_trading_fee(u64::MAX, u64::MAX)` with `fee_claimer` = `PDA["fee_claimer"]` signed through `invoke_signed`.
- Destinations: `token_a` = PDA's Token-2022 ATA, `token_b` = PDA's WSOL ATA.
- Measure the WSOL delta, then `transfer_checked` ×3 with the PDA as signer, all in the same instruction.
- The program only accepts the DBC `claim_trading_fee` and DAMM `claim_position_fee` discriminators.

**Result, DBC** `3pt9ujZ7iTWcHAXH882KpwBt9DiicFHL79QtiXF69Ku27UjEB1CWJQvPkrDUaaa4zyHYcFUKwpjRdxyLivqXGbB2`, **37,130 CU**:
- `partner_quote_fee` was 8,934,810. Claimed **8,934,810**.
- Split: buyback 4,467,405, platform 2,680,443, creator 1,786,962 (the measured ATA deltas are identical).
- Base claimed: 0, because quote-only fee mode.

**Creator fee:**
- With `creator_trading_fee_percentage = 0`, DBC gives the creator nothing. The full non-protocol fee goes to our PDA, and our split pays the creator's 20% to any account we choose. This is the recommended approach.
- If it were > 0, only `pool.creator` could claim it (`claim_creator_trading_fee`, creator signs). FUMPAD could route that share only if a FUMPAD PDA were the pool creator. That needs either a CPI of `initialize_virtual_pool_*` with a PDA as `creator` (it is a `Signer`), or `transfer_pool_creator` afterwards. **UNVERIFIED on chain**, and not needed.
- Creator liquidity is 0%, so after graduation the creator has no DAMM position.
- Surplus and migration-fee creator shares follow the same percentage, so they are 0 as well.

## 7. Caller-chosen mint keypair: PASS

`initialize_virtual_pool_with_token2022` takes `base_mint` as `init, signer`, so any keypair works.
- Main test coin: random keypair `CVs2xp3PVzkejERMXDYL1QHUa3yRLcGXMuog5y59VC2z`, pool `AazodqeqJvkyMtFi9kNisQidxhf3ncWxY7DU41K4yWCb`. The launch tx label in `state.json` says "vanity mint", but that run used the random key.
- Vanity: freshly ground `wEZG3B6gBgS2mrZPpBUZRVzWuxyF63uc9kWKDnsfmbL` (`09_vanity_pool.ts`, tx `5J5f6fTpzPyAyXCWJZaP5U8aAzwoZ5tqhHxcng6vqU6QQL5dNPFoXb1FWeGpwD6b8ZCqKwJKfc4kqL8jsEu63tLn`, 72,899 CU), a second pool `2TvRL13HXaekswCAHmrouyKNuzZH3HYcXj3i6QhQFJq6` on the same config.
- The pre-ground `SM5k4…fmbL` in `~/fumpad-keys/devnet` already exists on devnet, so it was not reused.

Resulting mint: Token-2022, 6 decimals, supply 1B minted to the DBC base vault, mint authority **None**, freeze authority **None**, metadata update authority **None** (`TokenAuthorityOption::Immutable`), metadata pointer to itself.

Launch rent per coin: virtual pool 0.00280 + base vault 0.00149 + quote vault 0.00204 + mint 0.00247 SOL ≈ **0.0088 SOL**.

## 8. FUMPAD-routed DBC swaps with exact amounts: PASS

`spike_program::routed_swap`.

**Mechanism:**
- User signs. Remaining accounts = DBC's `swap2` account list (15 accounts: pool_authority, config, pool, input, output, base_vault, quote_vault, base_mint, quote_mint, payer, base/quote token programs, referral(None = program id), event_authority, program).
- The program checks the target program id and the swap/swap2 discriminator, and checks the user owns both token accounts.
- It reads `amount` (bytes 64..72) of the user's input and output accounts, invokes, and reads them again. The deltas go to `set_return_data` (16 bytes) and to a `RoutedSwapMeasured` event.

| | tx | CU | measured | DBC EvtSwap3 |
|---|---|---|---|---|
| buy 0.02 SOL | `5fTexSbKHcXpC7gwzxUzqRfRx7zVsxgUt8mQtaVna21VPizDCQRYaxuwAY1siUikwJBAfJ3bAVRBnGfnwTwWD3Hw` | **67,271** | spent 20,000,000 lamports / received 47,996,279.844197 tokens | identical |
| sell | `3HQ5t5Jv9hW31nM1xa5crZBs14PzqpeYQa9Fy7mzoB9xsSQcoeUNVbMTBN4m1h9uJGzc1gAz3K4RBzwqAYgASCsB` | **65,473** | spent 23,998,139.922098 / received 10,027,301 | identical |

A direct (top-level) DBC buy costs about 37.4k CU. The CPI wrapper adds about 30k, and most of that is the spike's `msg!` with base58 pubkeys plus the event. Production should log less.

## 9. Graduation → DAMM v2, LP to our PDA, fee claim via CPI: PASS

**Migration** `64faFn5fGowfJ2FbwEsySV1Rm2oG8Lm39F8NibDabgp8mhtQHC3RTs3cexy17TH6PvCnBseQiNRmjU97LNPXzALm`, 156,867 CU, 600k limit set:
- `migration_damm_v2` is permissionless. We called it ourselves on devnet. **UNVERIFIED** whether Meteora's mainnet keepers ever run on devnet.
- Remaining account: DAMM v2 config `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` (the SDK constant for `Customizable`; it exists on devnet).
- The DBC pool authority fronts "flash rent". On devnet it holds about 99 SOL. The caller refunds the rent used: **0.0165 SOL**, paid by the migrator.

**DAMM v2 pool** `G2A8QLXMs1Tsf39FYcvBqBDs7ftVGUvisVicjArjtVwW`:
- Opens at the curve's final sqrt price (38981508865643380).
- Reserves: 189,964,158.86 tokens and 0.8483 SOL (0.2% protocol migration fee = 1,700,000 lamports + 380,689.70 tokens).
- Fee 1.25% static (cliff 12,500,000), `collect_fee_mode` 1 (`OnlyB`, SOL), `protocol_fee_percent` 20.
- Pool creator = DBC pool authority.

**Position:** NFT `Cxdg3MZk6FosBPsjSs9r1jxiUUotT9M3hXNf258kNZwV`, NFT account `D48CPABktVcn8ZcvgtwCAjFbqt2kHRKqXmyeHG5KCYeC`, position `6pkWtp6eFMpd2ctPaZf1jPTv9ftyowxSRdmFzRds4VT1`.
- **NFT owner = `PDA["fee_claimer"]`**, amount 1.
- `permanent_locked_liquidity` = 7405089542818110235538564234081 = **100% of pool liquidity**. Unlocked 0, vested 0.
- No second position was created.

**Fee claim** `claim_and_split` → DAMM `claim_position_fee` with `owner` / `signer` = PDA (`7HeNKf6RMtZsuoFfoL6gzwPT6XLrxH1y2wgy34KnHCpbKHzbyQ35X9xH5CvRhnPcXXis86QBuUktWUnCVhSfSoY`, **39,875 CU**):
- Claimed **1,202,049 lamports**. That is the sum of the four post-graduation swaps' LP fees (1,202,050) minus 1 lamport of rounding, so the locked position earns 100% of LP fees.
- Split: buyback 601,024, platform 360,614, creator 240,411.

## 10. DAMM v2 CPI swaps + price: PASS

| | tx | CU | measured |
|---|---|---|---|
| routed buy 0.03 SOL | `3RH1sfeFQjZbxTd8L1NuvcRkRsqS8V4ToqcQMqWrLQCBNrJRDUSjEHxdYJLN62Fn2PVGwP56QQMwztbsYbfp9Lo4` | **46,892** | 30,000,000 → 6,410,214.548088 tokens |
| routed sell | `2R1gCRM76adUhWENuBqUSpgHHSdpeus6pSaXuWvAQUc1MyYGjbq8mpaNNffSy6DYWZMpBsBLmdqE19zJjxciD9uF` | **46,281** | 3,205,107.274044 → 14,878,374 lamports |

These match DAMM `EvtSwap2` exactly. A direct DAMM swap costs about 35k CU. DAMM uses a custom pinocchio entrypoint for `swap` / `swap2`, and CPI into it works.

DAMM `swap2` account order: pool_authority, pool, input, output, token_a_vault, token_b_vault, token_a_mint, token_b_mint, payer, token_a_program, token_b_program, referral(None), event_authority, program.

**Spot price, read on chain** (`read_price`, ~1.9k CU, matches the SDK decode on both venues):

| Venue | `sqrt_price` field | Data offset (incl. 8-byte discriminator) |
|---|---|---|
| DBC `VirtualPool` | u128 LE Q64.64 | **280** |
| DAMM v2 `Pool` | u128 LE Q64.64 | **456** |

**Price formula** (token A/base = coin, token B = WSOL in both venues): `price_SOL_per_token = (sqrt_price / 2^64)^2 × 10^(base_dec − quote_dec) = (sqrt_price / 2^64)^2 × 10^-3`.
- Example (DAMM v2 read): sqrt 36563035070389125 → 3.9287e-9 SOL/token, MC 3.93 SOL on devnet.

DAMM v2 also stores `token_a_amount` / `token_b_amount` (reserves) for the D10/§4 depth checks, such as the ±3% median band and the 0.5%-of-depth slice cap.

## 11. Keeper attestation data source: PASS

`scripts/events.ts` (`parseSwaps`) is the exact parsing code.

**Mechanism:**
- Both programs `emit_cpi!`: a self-CPI inner instruction to the venue whose data = `e445a52e51cb9a1d` (EVENT_IX_TAG_LE) ‖ `sha256("event:Name")[..8]` ‖ borsh. It lives in `meta.innerInstructions`, never in logs, so log truncation cannot drop it.
- **Trader:** not in the event. It is the `payer` account of the swap instruction that emitted it (DBC index 9, DAMM v2 index 8). That is the closest preceding venue swap instruction.
- **Side:** `trade_direction`. DBC: 0 = base→quote (sell), 1 = buy. DAMM: 0 = A→B (sell), 1 = buy.
- **Amounts in/out:**
  - DBC `EvtSwap3.included_transfer_fee_amount_in` / `excluded_transfer_fee_amount_out`
  - DAMM `EvtSwap2.included_transfer_fee_amount_in` / `excluded_transfer_fee_amount_out`
- **Fees:**
  - DBC `trading_fee + protocol_fee + referral_fee` (quote)
  - DAMM `claiming_fee + compounding_fee + protocol_fee + referral_fee`
- **Router:** `topLevel` / `viaProgram` identify CPI routing (FUMPAD vs other aggregators).

**Third-party swaps** (official SDKs, no FUMPAD), all parsed correctly:

| Venue | Side | tx | trader | in | out | fees (trading + protocol) |
|---|---|---|---|---|---|---|
| DBC (DBC SDK) | buy | `2Hbkq8vcWHCQS1yVxaMGa4tS39i1njwPmEy8VRaKkbBAsDeKbDesKPavspSGSwQkm7mU3DbT86naVnjRRsGkXmt7` | `3gK2gsq5…` | 5,000,000 | 11,841,125.189446 | 50,000 + 12,500 |
| DBC (DBC SDK) | sell | `3cUt59nAhKxvUnmLCtajwhxNegD9P6X8YBowggAmu8jii9VkBdGfZdHFRZkeaAC8SvU7k4B1sG48MoKjr4YZyDzD` | `3gK2gsq5…` | 16,337,715.498029 | 6,691,871 | 67,767 + 16,941 |
| DAMM v2 (cp-amm-sdk) | buy | `Kb14shdELcHjSJuK5ahrTmsTM7WnXW7QvxQXVX6wJBT1c97eyfPPAeppHN7p6v5sjEJh5cGMcT3UGG3R2aTxP4j` | `3gK2gsq5…` | 4,000,000 | 851,051.127525 | 40,000 + 10,000 |
| DAMM v2 (cp-amm-sdk) | sell | `58tiN2L4cNCucFgANbk9gTfr5xLXw1pXsDiCoZupG4DR9uHdFyJC7H1L44HbyGisHtQoRtcdVVZUk7qsraRttrdG` | `3gK2gsq5…` | 16,621,399.207205 | 70,248,929 | 711,382 + 177,845 |

**Mainnet:** DBC 0.2.1 emits no `EvtSwap3`. The parser falls back to DBC `EvtSwap2` (`pool, config, dir u8, has_referral, SwapParameters2{u64,u64,u8}, SwapResult2{included_fee_input, excluded_fee_input, amount_left, output, next_sqrt u128, trading_fee, protocol_fee, referral_fee}, quote_reserve, threshold, ts`). `07_verify_and_cleanup.ts` re-parsed all 17 devnet DBC swap transactions with only `EvtSwap2` and got identical results, with one cosmetic exception: the `curveComplete` flag is not attached in that mode. Recent mainnet DBC transactions contain `EvtSwap` and `EvtSwap2` (§1).

## 12. What complicates FUMPAD, and Meteora admin powers

**Hold-time tracking, `register_holdings`, rebuy rule: no blocker.**
- There is no transfer hook (by decision), so FUMPAD still only sees balances at its own observations. That is the existing `last_balance` model (SPEC §5.3), unchanged.
- From launch, tokens move freely through Axiom, Jupiter and bots. Most balance changes will therefore be "unseen" and need `register_holdings` or keeper attestations. Product consequence: fewer wallets will have matured FUMPAD-tracked credit unless the app nudges `register_holdings`.
- The creator's bundled first buy is invisible to the router (§5 caveat 2).

**Claim payouts in tokens from the reward pool: works.**
- `pay_reward`: `transfer_checked` from `ATA(PDA["reward_pool"], mint)` with the PDA as signer, Token-2022, `2pHFM59q5GsPuUSHKDP2unB398ovEx9pqREk1XeDTHheWJbKWWQbTGs1FQnucYGuiWeJgiKJ3PraAtWiLsiEWVK6`, **10,271 CU**.
- The vault is shared per mint, owned by one global PDA. Per-coin accounting is by mint.

**Buyback: works on the curve and after graduation.**
- `buyback_swap` with `PDA["buyback"]` as the DBC/DAMM `payer`:
  - DBC: `22wBp5kKzceqMYdpfZ81aSfYfxG5ydu9a76VdcCMtANymqRvuB2ePBd64VmHgWGaGJCTFSBw6SCMJNefLPSHcYRf`, 68.8k CU
  - DAMM: `2pk4SRh1PopwV9oDvdtYavvpXYsTUpN8rFdQ3AMSavbtzLN21WJGyp7Ex4icE8aUtB1xcYouqQFz1G5CZtF2yTJw`, 48.4k CU
- Output goes straight into the reward pool ATA (+10,707,430.68 tokens and +150,959.31 tokens).
- Post-graduation guard against the 30-min median: read `sqrt_price` on chain (§10).

**Gone or changed vs the current design:**
- No own curve, no PumpSwap, no `fumpad_lp_locker`. The Meteora DAMM v2 permanent lock replaces it, but it is Meteora-upgradeable, not immutable (see admin powers).
- **D13 escape hatch:** not needed while trading, since the DBC curve never pauses sells. But a **completed-but-not-migrated** pool cannot trade at all until someone calls `migration_damm_v2`. It is permissionless, and Meteora runs keepers on mainnet.
- **D20 graduation fee:** DBC has no graduation fee. The migrator pays about 0.0165 SOL of rent. FUMPAD's setup rent (claim queue ≈0.57 SOL + observations) needs another source. Options:
  - `pool_creation_fee` (0.001–100 SOL at pool creation; the partner gets 90% via `claim_partner_pool_creation_fee`, Meteora 10%)
  - DBC `migration_fee` (% of the raise, partner/creator split)
  - part of the fee split
- **D19 differences:** see §5 caveats 1–4.
- **Surplus:** quote above the threshold (2 lamports here). The partner claims via `partner_withdraw_surplus` (80% of surplus split partner/creator, 20% protocol).
- **0.2% protocol liquidity migration fee** on both sides at graduation.
- **Meteora's 20% protocol fee on both venues:** 1.25% fee → 1.00% to FUMPAD.
- **Router fee:** the router can't skim Meteora's fee. If FUMPAD wants an extra router-only fee, it must charge it in its router instruction itself. That is not needed: the partner fee already earns 1% on all volume, on any app.
- **D10/D12 reference price:** the router can read `sqrt_price` before the CPI (1.9k CU).

**Meteora admin powers** (source-verified: DBC `release_0.2.2`, DAMM v2 0.2.4):
- **Both programs are upgradeable** by a single system-owned authority per cluster (`JADaUV8k…` on mainnet). Multisig status **UNVERIFIED**. An upgrade can change anything: fees, locks, layouts. This is the biggest residual risk for FUMPAD.
- **DAMM v2 operators** (admin-created `Operator` accounts with permission bits):
  - `SetPoolStatus` can **disable** any pool. That blocks swaps, add-liquidity, position create/lock/split. Remove-liquidity and fee claims are not gated by status.
  - `UpdatePoolFees` can change a pool's **static base fee** (`cliff_fee_numerator`) plus dynamic and compounding fee, which includes ours.
  - Also `FixPool`, rewards (`InitializeReward` etc.), configs, and token badges.
  - `protocol_fee_percent` is fixed at pool creation; the update instruction does not touch it.
- **DBC operators:** only `ClaimProtocolFee`, `CreateTokenBadge`, `CloseTokenBadge`. There is no pause and no fee change for existing pools or configs.
- The `pool_creator_authority` of the DAMM v2 migration config is the DBC pool authority. Nobody else can pre-create our canonical DAMM pool (pool PDA = [config, mint, WSOL]). But anyone can create *other* DAMM v2, Raydium or other pools for the coin. That fragments liquidity; it is not a security issue.
- **Router robustness:** CPI account lists should come through `remaining_accounts` with only the critical keys validated, plus balance-delta measurement. That makes Meteora account-list changes a client update, as in SPEC §5.2. This spike already works that way.

## 13. Surprises (ranked)

1. **Devnet ≠ mainnet.** DBC 0.2.2 (`create_config2`, `EvtSwap3`) is only on devnet. Mainnet is 0.2.1.
2. **The anti-snipe min-fee exemption is "first top-level swap in the creation tx", not "the creator".** It cannot be routed through FUMPAD. The snipe fee also taxes sells, and it lands in the general 80/20 fee pot, not the reward pool.
3. **Swaps can't pass the migration price.** ExactIn buys that would overshoot revert; the final buy must be PartialFill (aggregators must handle this). The upside is that the leftover / 8% reward pool is exact.
4. **The reward vault must be the ATA of the config's `leftover_receiver`.** It is funded only after migration.
5. **DAMM v2 operators can disable our pool or change its fee.** Both programs are upgradeable by a single authority (multisig UNVERIFIED).

## Recommended rewrite architecture

**PDAs:** `fee_claimer` (DBC config fee_claimer + LP NFT owner), `reward_pool` (config leftover_receiver; vault = its Token-2022 ATA per mint), `buyback` (DBC/DAMM swap payer for fee-funded buybacks), plus the existing `Coin[mint]` (now storing `dbc_pool`, `config`, `damm_pool`, `position_nft`) / `Position` / `Ticket` / claim queue / observations.

**Instructions:**

1. `admin_create_dbc_config(params)`
   - Direct TS call or CPI: `create_config` (mainnet 0.2.1) or `create_config2` (0.2.2).
   - fee_claimer = `fee_claimer` PDA, leftover_receiver = `reward_pool` PDA, WSOL, Token-2022, `Immutable`.
   - Fixed 1B supply, leftover 80M, 100% partner permanent lock, Customizable migrated fee 125 bps `OnlyB`.
   - Snipe scheduler (8 × 1 slot), `enable_first_swap_with_min_fee`, creator fee 0%.
   - One config per parameter version (= the D14 snapshot).
2. `register_coin(mint)`
   - Runs in the launch tx after DBC `initialize_virtual_pool_with_token2022` and the top-level creator first-buy `swap2`. The vanity mint is co-signed server-side.
   - Records `Coin` and observes the creator's balance (the first buy can't be routed).
3. `buy` / `sell(amount, min_out, mode)`
   - CPI DBC `swap2` (status Curve) or DAMM v2 `swap2` (Graduated) through `remaining_accounts`.
   - Validate program, pool == `Coin.pool`, and the user's canonical ATAs. Measure deltas. Read `sqrt_price` before the CPI for the D12 floor.
   - Update Position and Ticket. Use PartialFill when the buy may complete the curve.
4. `graduate(coin)`
   - Permissionless. Either CPI `migration_damm_v2` (+ DAMM config remaining account) followed by `withdraw_leftover`, or let Meteora's keeper migrate and then observe.
   - Store `damm_pool` and the position NFT, and set status Graduated. Also claim the surplus (`partner_withdraw_surplus`).
5. `claim_fees(coin)`
   - Permissionless. CPI DBC `claim_trading_fee` (and after graduation DAMM `claim_position_fee`) signed by `fee_claimer`.
   - Split: 50% → buyback WSOL ATA, 30% → platform, 20% → creator vault.
6. `execute_buyback(coin)`
   - Permissionless. CPI swap with `buyback` PDA as payer via DBC or DAMM, output to the reward pool ATA, guarded by the 30-min median ±3% band.
7. `attest_external_swap(...)` (2-of-3 keepers)
   - Uses the fields from `events.ts`: trader = swap payer, side, in/out, fee, pool, ts.
   - DBC `EvtSwap2` on mainnet, `EvtSwap3` on 0.2.2.
8. `claim` / `claim_for` / `withdraw_escrow` / queue keep their current logic, paying from `ATA(reward_pool, mint)` (`pay_reward` pattern).

**Delete:** own curve, PumpSwap `graduate`, `fumpad_lp_locker`, PumpSwap router, D13 hatch. Re-scope D19 and D20 as in §12.

## Files

- `program/`: Anchor 1.2.1 workspace, `fumpad_dbc_spike`. Raw CPI with hard-coded discriminators; no Meteora crates needed, so no anchor version conflict.
- `scripts/`:

| Script | What it does |
|---|---|
| `00_check` | preflight |
| `01_program_ids`, `01b_ix_diff`, `01c_idl` | program comparison (item 1) |
| `curve` | D17 config builder |
| `02_config` | config (items 2–4) |
| `03_launch` | launch (items 5, 7) |
| `04_curve_cpi` | curve CPI (items 6, 8, 10, 11, 12) |
| `05_graduate` | graduation (items 3, 9) |
| `06_damm` | DAMM v2 (items 9–12) |
| `07_verify_and_cleanup` | verification and SOL recovery |
| `08_mainnet_event_check` | read-only mainnet event check |
| `09_vanity_pool` | vanity mint pool (item 7) |
| `events.ts` | keeper parser (item 11) |
| `spike.ts` | spike program client |
| `dbc.ts` | DBC instruction builders |
| `sol.sh` | devnet-only solana CLI wrapper; redacts the RPC key |

- `state.json`: every address, signature, CU figure and decoded result. Public data only.
- Throwaway keypairs are in `.keys/` (gitignored). The RPC URL is read from `~/fumpad-keys/devnet/rpc.env` and is never printed or committed.
- Run order: `anchor build` and `bash scripts/sol.sh program deploy …` (in `program/`), then `npx tsx scripts/<n>.ts` in numeric order.
