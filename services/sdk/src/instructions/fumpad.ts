/**
 * Instruction builders for EVERY fumpad v0.7 instruction (INTERFACE-v0.7 §3). The IDL drives account
 * order and flags (`idlMetas`), so a contract change that renames/reorders accounts fails loudly here.
 * Amounts are raw units (bigint lamports / base units).
 */
import { type AccountMeta, PublicKey, type TransactionInstruction } from "@solana/web3.js";

import { toIdl } from "../borsh.js";
import { FUMPAD_IDL, fumpadCoder } from "../coder.js";
import {
  DAMM_V2_MIGRATION_CONFIG,
  DAMM_V2_PROGRAM_ID,
  DBC_PROGRAM_ID,
  FUMPAD_PROGRAM_ID,
  MAX_CONFIGS,
  MAX_KEEPERS,
  MAX_OPERATORS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../constants.js";
import { dammSwapAccounts, dbcMigrationAccounts, dbcSwapAccounts } from "../meteora/instructions.js";
import { type FeePolicy, STANDARD_FEE_POLICY } from "../accounts.js";
import { type Params, paramsToIdl } from "../params.js";
import {
  ata,
  buybackPda,
  buybackWsol,
  claimQueuePda,
  coinAta,
  coinPda,
  consumedRebuyPda,
  consumedSellPda,
  dammPoolPda,
  dammPositionNftAccountPda,
  dammPositionPda,
  dammVaultPda,
  dbcPoolPda,
  dbcVaultPda,
  escrowPda,
  feeClaimerPda,
  feeWsolPda,
  globalPda,
  observationsPda,
  positionPda,
  programDataPda,
  rewardPoolPda,
  rewardVault,
  ticketPda,
  wsolAta,
} from "../pda.js";
import { type AccountsInput, idlMetas, makeIx, r, w } from "./metas.js";

function ix(name: string, accounts: AccountsInput, args: Record<string, unknown> = {}, remaining: AccountMeta[] = []): TransactionInstruction {
  const keys = idlMetas(FUMPAD_IDL, FUMPAD_PROGRAM_ID, name, accounts).concat(remaining);
  const data = fumpadCoder().instruction.encode(name, toIdl(args) as Record<string, unknown>);
  return makeIx(FUMPAD_PROGRAM_ID, keys, data);
}

/** The coin facts most builders need (from `CoinAccount`). */
export interface CoinRefs {
  mint: PublicKey;
  dbcConfig: PublicKey;
  /** default: derived from (dbcConfig, mint, WSOL) */
  dbcPool?: PublicKey;
  /** graduated pool (default: DAMM pool PDA of the Customizable migration config) */
  dammPool?: PublicKey;
  dammPosition?: PublicKey;
  creator?: PublicKey;
  /**
   * Wallet-split policy coins (`CoinAccount.feePolicyKind != 0`): the snapshot's policy wallet (`CoinAccount.feePolicy.wallet`),
   * passed by fee claims as `fee_wallet`; omitted/null = standard coin (None).
   */
  feeWallet?: PublicKey | null;
}
const dbcPoolOf = (c: CoinRefs) => c.dbcPool ?? dbcPoolPda(c.dbcConfig, c.mint);
const dammPoolOf = (c: CoinRefs) => c.dammPool ?? dammPoolPda(c.mint);

// ── admin / governance ──────────────────────────────────────────────────────
const pad = (keys: PublicKey[], n: number, what: string): PublicKey[] => {
  if (keys.length > n) throw new Error(`at most ${n} ${what}`);
  return [...keys, ...Array(n - keys.length).fill(PublicKey.default)];
};
/** Throws if a key is both an attestor (keeper) and an operator — the program refuses it (KeeperOperatorOverlap). */
function assertDisjoint(keepers: PublicKey[], operators: PublicKey[]): void {
  for (const o of operators) {
    if (!o.equals(PublicKey.default) && keepers.some((k) => k.equals(o))) throw new Error(`${o.toBase58()} can't be both an attestor and an operator`);
  }
}

/**
 * `initialize_global` — payer must be the fumpad program's upgrade authority. Bootstrap: `keepers` (≤ 3 attestors)
 * start with NO 6h attest freeze, `operators` (≤ 2 jobs keys, never attestors) are set at once, and `configs` (≤ 8
 * FUMPAD DBC configs, validated like `execute_config` add, passed as remaining accounts) are allow-listed with NO
 * 48h timelock. Later changes keep their freeze / timelock.
 */
export function initializeGlobalIx(a: {
  payer: PublicKey;
  admin: PublicKey;
  platformTreasury: PublicKey;
  clusterTag: number;
  params: Params;
  keepers?: PublicKey[];
  operators?: PublicKey[];
  configs?: PublicKey[];
  /** Fee policy of `configs[i]` (shorter list: the rest are standard). Trailing standard policies are dropped (tx size). */
  policies?: FeePolicy[];
}): TransactionInstruction {
  const keepers = a.keepers ?? [];
  if (keepers.length > MAX_KEEPERS) throw new Error(`at most ${MAX_KEEPERS} keepers`);
  const operators = a.operators ?? [];
  if (operators.length > MAX_OPERATORS) throw new Error(`at most ${MAX_OPERATORS} operators`);
  assertDisjoint(keepers, operators);
  const configs = a.configs ?? [];
  if (configs.length > MAX_CONFIGS) throw new Error(`at most ${MAX_CONFIGS} configs`);
  const policies = [...(a.policies ?? [])];
  if (policies.length > configs.length) throw new Error("more fee policies than configs");
  while (policies.length && isStandard(policies[policies.length - 1])) policies.pop();
  return ix(
    "initialize_global",
    { payer: a.payer, global: globalPda(), programData: programDataPda() },
    {
      admin: a.admin,
      platformTreasury: a.platformTreasury,
      clusterTag: a.clusterTag,
      params: paramsToIdl(a.params),
      keepers: [...keepers, ...Array(MAX_KEEPERS - keepers.length).fill(PublicKey.default)],
      operators,
      policies,
    },
    configs.map((pubkey) => r(pubkey)),
  );
}
export const queueParamsIx = (admin: PublicKey, params: Params) => ix("queue_params", { admin, global: globalPda() }, { params: paramsToIdl(params) });
export const executeParamsIx = (caller: PublicKey) => ix("execute_params", { caller, global: globalPda() });
export const cancelParamsIx = (authority: PublicKey) => ix("cancel_params", { authority, global: globalPda() });
export const setPauseIx = (authority: PublicKey, paused: number) => ix("set_pause", { authority, global: globalPda() }, { paused });
export function setKeepersIx(admin: PublicKey, keepers: PublicKey[]): TransactionInstruction {
  if (keepers.length > MAX_KEEPERS) throw new Error(`at most ${MAX_KEEPERS} keepers`);
  const list = [...keepers, ...Array(MAX_KEEPERS - keepers.length).fill(PublicKey.default)];
  return ix("set_keepers", { admin, global: globalPda() }, { keepers: list });
}
/** `set_operators` — admin, immediate: the jobs keys (samples, claim_for, pre-grad buybacks). Never an attestor key. */
export function setOperatorsIx(admin: PublicKey, operators: PublicKey[]): TransactionInstruction {
  return ix("set_operators", { admin, global: globalPda() }, { operators: pad(operators, MAX_OPERATORS, "operators") });
}
export const proposeAdminIx = (admin: PublicKey, newAdmin: PublicKey, platformTreasury: PublicKey, guardian: PublicKey) =>
  ix("propose_admin", { admin, global: globalPda() }, { newAdmin, platformTreasury, guardian });
export const acceptAdminIx = (newAdmin: PublicKey) => ix("accept_admin", { newAdmin, global: globalPda() });
export const cancelAdminIx = (authority: PublicKey) => ix("cancel_admin", { authority, global: globalPda() });
const isStandard = (p: FeePolicy) => p.kind === 0 && p.buybackShare === 0 && p.walletShare === 0 && p.maxCoins === 0 && p.wallet.equals(PublicKey.default);
/** `queue_config` — `policy` = the slot's fee policy when adding (default standard); must be standard when removing. */
export const queueConfigIx = (admin: PublicKey, config: PublicKey, add: boolean, policy: FeePolicy = STANDARD_FEE_POLICY) =>
  ix("queue_config", { admin, global: globalPda(), dbcConfig: config }, { config, add, policy });
export const executeConfigIx = (caller: PublicKey, pendingConfig: PublicKey) => ix("execute_config", { caller, global: globalPda(), dbcConfig: pendingConfig });
export const cancelConfigIx = (authority: PublicKey) => ix("cancel_config", { authority, global: globalPda() });
export const migrateGlobalIx = (admin: PublicKey) => ix("migrate_global", { admin, global: globalPda() });

// ── launch ──────────────────────────────────────────────────────────────────
/**
 * `register_coin` — 3rd instruction of the launch tx (after DBC init + the creator's top-level swap2).
 * `launchSigner`: the API's launch key, required (as a signer) iff `Global.params.launch_signer` is set
 * (off-chain review L1); omitted → the optional account is passed as the fumpad program id.
 */
export function registerCoinIx(a: { creator: PublicKey; mint: PublicKey; dbcConfig: PublicKey; launchSigner?: PublicKey | null }): TransactionInstruction {
  return ix("register_coin", {
    creator: a.creator,
    global: globalPda(),
    mint: a.mint,
    dbcConfig: a.dbcConfig,
    dbcPool: dbcPoolPda(a.dbcConfig, a.mint),
    coin: coinPda(a.mint),
    rewardPool: rewardPoolPda(),
    rewardVault: rewardVault(a.mint),
    launchSigner: a.launchSigner ?? null,
  });
}

// ── router ──────────────────────────────────────────────────────────────────
export type Venue = "dbc" | "damm_v2";

/** Venue swap2 accounts for a trader (canonical coin ATA + WSOL ATA), as the router's remaining accounts. */
export function routerVenueAccounts(c: CoinRefs, venue: Venue, trader: PublicKey, side: "buy" | "sell"): AccountMeta[] {
  const base = coinAta(trader, c.mint);
  const quote = wsolAta(trader);
  const [input, output] = side === "buy" ? [quote, base] : [base, quote];
  return venue === "dbc"
    ? dbcSwapAccounts({ config: c.dbcConfig, mint: c.mint, payer: trader, input, output })
    : dammSwapAccounts({ pool: dammPoolOf(c), mint: c.mint, payer: trader, input, output });
}

/** Router `buy` (mode 0 ExactIn, 1 PartialFill — use PartialFill near curve completion). */
export function routerBuyIx(a: { trader: PublicKey; coin: CoinRefs; venue: Venue; amountIn: bigint; minOut: bigint; mode?: number }): TransactionInstruction {
  return ix(
    "buy",
    { trader: a.trader, global: globalPda(), coin: coinPda(a.coin.mint), venueProgram: a.venue === "dbc" ? DBC_PROGRAM_ID : DAMM_V2_PROGRAM_ID },
    { amountIn: a.amountIn, minOut: a.minOut, mode: a.mode ?? 0 },
    routerVenueAccounts(a.coin, a.venue, a.trader, "buy"),
  );
}
export function routerSellIx(a: { trader: PublicKey; coin: CoinRefs; venue: Venue; amountIn: bigint; minOut: bigint }): TransactionInstruction {
  return ix(
    "sell",
    { trader: a.trader, global: globalPda(), coin: coinPda(a.coin.mint), venueProgram: a.venue === "dbc" ? DBC_PROGRAM_ID : DAMM_V2_PROGRAM_ID },
    { amountIn: a.amountIn, minOut: a.minOut },
    routerVenueAccounts(a.coin, a.venue, a.trader, "sell"),
  );
}

// ── fees ────────────────────────────────────────────────────────────────────
export function claimFeesIx(caller: PublicKey, c: CoinRefs): TransactionInstruction {
  const pool = dbcPoolOf(c);
  return ix("claim_fees", {
    caller,
    global: globalPda(),
    coin: coinPda(c.mint),
    mint: c.mint,
    dbcConfig: c.dbcConfig,
    dbcPool: pool,
    dbcBaseVault: dbcVaultPda(c.mint, pool),
    dbcQuoteVault: dbcVaultPda(WSOL_MINT, pool),
    feeClaimer: feeClaimerPda(),
    feeWsol: feeWsolPda(),
    rewardVault: rewardVault(c.mint),
    ...policyAccounts(c),
  });
}
/** The optional `fee_wallet` of claim_fees / claim_lp_fees. */
const policyAccounts = (c: CoinRefs) => ({ feeWallet: c.feeWallet ?? null });
export function claimLpFeesIx(caller: PublicKey, c: CoinRefs & { dammPosition: PublicKey; positionNftMint: PublicKey }): TransactionInstruction {
  const pool = dammPoolOf(c);
  return ix("claim_lp_fees", {
    caller,
    global: globalPda(),
    coin: coinPda(c.mint),
    mint: c.mint,
    dammPool: pool,
    dammPosition: c.dammPosition,
    positionNftAccount: dammPositionNftAccountPda(c.positionNftMint),
    dammTokenAVault: dammVaultPda(c.mint, pool),
    dammTokenBVault: dammVaultPda(WSOL_MINT, pool),
    feeClaimer: feeClaimerPda(),
    feeWsol: feeWsolPda(),
    rewardVault: rewardVault(c.mint),
    ...policyAccounts(c),
  });
}
/**
 * `claim_unregistered_fees` — DBC partner fees of a pool on a FUMPAD-shaped config whose mint never registered
 * (no Coin) → `platformTreasury` (= Global.platform_treasury). The base-side destination ATA(reward_pool, mint) must
 * exist: prepend `createAtaIdempotentIx(caller, rewardPoolPda(), mint, TOKEN_2022)`.
 */
export function claimUnregisteredFeesIx(caller: PublicKey, a: { mint: PublicKey; dbcConfig: PublicKey; platformTreasury: PublicKey; dbcPool?: PublicKey }): TransactionInstruction {
  const pool = a.dbcPool ?? dbcPoolPda(a.dbcConfig, a.mint);
  return ix("claim_unregistered_fees", {
    caller,
    global: globalPda(),
    mint: a.mint,
    coin: coinPda(a.mint),
    dbcConfig: a.dbcConfig,
    dbcPool: pool,
    dbcBaseVault: dbcVaultPda(a.mint, pool),
    dbcQuoteVault: dbcVaultPda(WSOL_MINT, pool),
    feeClaimer: feeClaimerPda(),
    feeWsol: feeWsolPda(),
    rewardVault: rewardVault(a.mint),
    platformTreasury: a.platformTreasury,
  });
}
/**
 * `claim_position_rewards(reward_index)` — DAMM v2 farming rewards of a fee_claimer-held position of a graduated
 * coin's pool. Destination: the coin's reward vault when `rewardMint == mint`, else ATA(platformTreasury,
 * rewardMint, token program) (must exist). `rewardVault` / `rewardMint` / `tokenFlag` from the pool's reward slot.
 */
export function claimPositionRewardsIx(
  caller: PublicKey,
  a: CoinRefs & { positionNftMint: PublicKey; rewardIndex: number; rewardMint: PublicKey; rewardVault: PublicKey; tokenFlag: number; platformTreasury: PublicKey },
): TransactionInstruction {
  const tokenProgram = a.tokenFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const destination = a.rewardMint.equals(a.mint) ? rewardVault(a.mint) : ata(a.platformTreasury, a.rewardMint, tokenProgram);
  return ix(
    "claim_position_rewards",
    {
      caller,
      global: globalPda(),
      coin: coinPda(a.mint),
      mint: a.mint,
      dammPool: dammPoolOf(a),
      dammPosition: a.dammPosition ?? dammPositionPda(a.positionNftMint),
      positionNftAccount: dammPositionNftAccountPda(a.positionNftMint),
      dammRewardVault: a.rewardVault,
      rewardMint: a.rewardMint,
      destination,
      feeClaimer: feeClaimerPda(),
      rewardTokenProgram: tokenProgram,
    },
    { rewardIndex: a.rewardIndex },
  );
}
export const withdrawCreatorFeesIx = (creator: PublicKey, mint: PublicKey) => ix("withdraw_creator_fees", { creator, coin: coinPda(mint) });
export const withdrawPlatformFeesIx = (caller: PublicKey, mint: PublicKey, platformTreasury: PublicKey) =>
  ix("withdraw_platform_fees", { caller, global: globalPda(), coin: coinPda(mint), platformTreasury });

// ── buyback ─────────────────────────────────────────────────────────────────
/** `execute_buyback(max_in)` — remaining = the venue swap2 accounts with payer = buyback PDA, input = buyback WSOL, output = reward vault. */
export function executeBuybackIx(a: { cranker: PublicKey; coin: CoinRefs; venue: Venue; maxIn: bigint }): TransactionInstruction {
  const c = a.coin;
  const payer = buybackPda();
  const remaining =
    a.venue === "dbc"
      ? dbcSwapAccounts({ config: c.dbcConfig, mint: c.mint, payer, input: buybackWsol(), output: rewardVault(c.mint) })
      : dammSwapAccounts({ pool: dammPoolOf(c), mint: c.mint, payer, input: buybackWsol(), output: rewardVault(c.mint) });
  // The buyback PDA signs inside the program: pass it as a non-signer.
  const fixed = remaining.map((m) => (m.pubkey.equals(payer) ? { ...m, isSigner: false } : m));
  return ix(
    "execute_buyback",
    {
      cranker: a.cranker,
      global: globalPda(),
      coin: coinPda(c.mint),
      mint: c.mint,
      observations: observationsPda(c.mint),
      buyback: payer,
      buybackWsol: buybackWsol(),
      rewardVault: rewardVault(c.mint),
      venueProgram: a.venue === "dbc" ? DBC_PROGRAM_ID : DAMM_V2_PROGRAM_ID,
    },
    { maxIn: a.maxIn },
    fixed,
  );
}

// ── graduation ──────────────────────────────────────────────────────────────
/** `migrate_pool` — wraps DBC migration_damm_v2 (records the flash-rent payer for the graduate refund). `nftMint` = fresh keypair, signs. */
export function migratePoolIx(a: { caller: PublicKey; coin: CoinRefs; nftMint: PublicKey; dammConfig?: PublicKey }): TransactionInstruction {
  return ix(
    "migrate_pool",
    { caller: a.caller, global: globalPda(), coin: coinPda(a.coin.mint) },
    {},
    dbcMigrationAccounts({ config: a.coin.dbcConfig, mint: a.coin.mint, nftMint: a.nftMint, payer: a.caller, dammConfig: a.dammConfig }),
  );
}

/** `graduate` — after the DBC pool migrated (any path). `migrator` = coin.migrator, or the caller when none. */
export function graduateIx(a: {
  caller: PublicKey;
  coin: CoinRefs;
  dammPosition: PublicKey;
  positionNftMint: PublicKey;
  migrator?: PublicKey;
  dammConfig?: PublicKey;
}): TransactionInstruction {
  const c = a.coin;
  const pool = dbcPoolOf(c);
  const dammConfig = a.dammConfig ?? DAMM_V2_MIGRATION_CONFIG;
  return ix("graduate", {
    caller: a.caller,
    global: globalPda(),
    coin: coinPda(c.mint),
    mint: c.mint,
    dbcConfig: c.dbcConfig,
    dbcPool: pool,
    dbcQuoteVault: dbcVaultPda(WSOL_MINT, pool),
    dbcBaseVault: dbcVaultPda(c.mint, pool),
    dammConfig,
    dammPool: c.dammPool ?? dammPoolPda(c.mint, dammConfig),
    dammPosition: a.dammPosition,
    positionNftAccount: dammPositionNftAccountPda(a.positionNftMint),
    feeClaimer: feeClaimerPda(),
    feeWsol: feeWsolPda(),
    rewardPool: rewardPoolPda(),
    rewardVault: rewardVault(c.mint),
    migrator: a.migrator ?? a.caller,
    observations: observationsPda(c.mint),
    claimQueue: claimQueuePda(c.mint),
  });
}
export const initObservationsIx = (payer: PublicKey, mint: PublicKey) => ix("init_observations", { payer, coin: coinPda(mint), observations: observationsPda(mint) });
export const initClaimQueueIx = (payer: PublicKey, mint: PublicKey) => ix("init_claim_queue", { payer, coin: coinPda(mint), claimQueue: claimQueuePda(mint) });

// ── oracle ──────────────────────────────────────────────────────────────────
/** `record_samples` — groups of [coin (w), pool, observations (w)]; pool = DBC pool pre-grad, DAMM pool after. Must be alone in its tx (+ compute budget). */
export function recordSamplesIx(sampler: PublicKey, groups: { mint: PublicKey; pool: PublicKey }[]): TransactionInstruction {
  if (groups.length < 1 || groups.length > 10) throw new Error("record_samples takes 1–10 groups");
  const remaining = groups.flatMap((g) => [w(coinPda(g.mint)), r(g.pool), w(observationsPda(g.mint))]);
  return ix("record_samples", { sampler, global: globalPda() }, {}, remaining);
}

// ── tickets (attestations) ──────────────────────────────────────────────────
/** `attest_sell` — must come IMMEDIATELY after the Ed25519 instruction (see attestation.ts). `seq` = position.next_ticket_seq (0 if no position). */
export function attestSellIx(a: { keeper: PublicKey; mint: PublicKey; trader: PublicKey; seq: bigint; signature: Uint8Array; ixKey: number }): TransactionInstruction {
  return ix("attest_sell", {
    keeper: a.keeper,
    global: globalPda(),
    coin: coinPda(a.mint),
    position: positionPda(a.mint, a.trader),
    ticket: ticketPda(a.mint, a.trader, a.seq),
    consumed: consumedSellPda(a.signature, a.ixKey),
  });
}
/** `attest_rebuy` — `queued`: the ticket is Queued (then the claim queue is passed). */
export function attestRebuyIx(a: { keeper: PublicKey; mint: PublicKey; owner: PublicKey; ticket: PublicKey; signature: Uint8Array; ixKey: number; queued: boolean }): TransactionInstruction {
  return ix("attest_rebuy", {
    keeper: a.keeper,
    global: globalPda(),
    coin: coinPda(a.mint),
    ticket: a.ticket,
    position: positionPda(a.mint, a.owner),
    consumed: consumedRebuyPda(a.signature, a.ixKey, a.ticket),
    claimQueue: a.queued ? claimQueuePda(a.mint) : null,
  });
}
/**
 * `void_ticket(reason, reopen)` — guardian/admin inside the challenge window. `consumed` = the ticket's sell
 * marker (`Ticket.consumed`). `reopen`: the attestation was wrong but the trade may be honest → one corrected
 * attestation of the same trade may follow; false (fraud) keeps the trade consumed.
 */
export const voidTicketIx = (a: { authority: PublicKey; ticket: PublicKey; mint: PublicKey; owner: PublicKey; consumed: PublicKey; reason: number; reopen: boolean }) =>
  ix(
    "void_ticket",
    { authority: a.authority, global: globalPda(), coin: coinPda(a.mint), mint: a.mint, ticket: a.ticket, position: positionPda(a.mint, a.owner), consumed: a.consumed },
    { reason: a.reason, reopen: a.reopen },
  );
export const closeConsumedIx = (caller: PublicKey, consumed: PublicKey, rentPayer: PublicKey, ticket: PublicKey) =>
  ix("close_consumed", { caller, global: globalPda(), consumed, rentPayer, ticket });

// ── claims ──────────────────────────────────────────────────────────────────
export function claimIx(a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey; ownerTokenAccount?: PublicKey }): TransactionInstruction {
  return ix("claim", {
    owner: a.owner,
    global: globalPda(),
    coin: coinPda(a.mint),
    mint: a.mint,
    ticket: a.ticket,
    position: positionPda(a.mint, a.owner),
    claimQueue: claimQueuePda(a.mint),
    observations: observationsPda(a.mint),
    rewardPool: rewardPoolPda(),
    rewardVault: rewardVault(a.mint),
    ownerTokenAccount: a.ownerTokenAccount ?? coinAta(a.owner, a.mint),
  });
}
/** `claim_for` (D17 auto-claim) — `keeper` must be an OPERATOR key (`Global.operators`), never an attestor. */
export function claimForIx(a: { keeper: PublicKey; mint: PublicKey; ticket: PublicKey; owner: PublicKey }): TransactionInstruction {
  return ix("claim_for", {
    keeper: a.keeper,
    global: globalPda(),
    coin: coinPda(a.mint),
    mint: a.mint,
    ticket: a.ticket,
    position: positionPda(a.mint, a.owner),
    claimQueue: claimQueuePda(a.mint),
    observations: observationsPda(a.mint),
    rewardPool: rewardPoolPda(),
    rewardVault: rewardVault(a.mint),
    ownerAta: coinAta(a.owner, a.mint),
    escrow: escrowPda(a.ticket),
  });
}
/** `process_queue(max_entries)` — remaining = [ticket, position, owner canonical ATA, escrow] per entry, in queue order. */
export function processQueueIx(a: { cranker: PublicKey; mint: PublicKey; entries: { ticket: PublicKey; owner: PublicKey }[]; maxEntries?: number }): TransactionInstruction {
  const remaining = a.entries.flatMap((e) => [w(e.ticket), w(positionPda(a.mint, e.owner)), w(coinAta(e.owner, a.mint)), w(escrowPda(e.ticket))]);
  return ix(
    "process_queue",
    { cranker: a.cranker, global: globalPda(), coin: coinPda(a.mint), mint: a.mint, claimQueue: claimQueuePda(a.mint), rewardPool: rewardPoolPda(), rewardVault: rewardVault(a.mint) },
    { maxEntries: a.maxEntries ?? a.entries.length },
    remaining,
  );
}
export function withdrawEscrowIx(a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey; destination: PublicKey; escrowPayer: PublicKey }): TransactionInstruction {
  return ix("withdraw_escrow", {
    owner: a.owner,
    global: globalPda(),
    mint: a.mint,
    ticket: a.ticket,
    escrow: escrowPda(a.ticket),
    rewardPool: rewardPoolPda(),
    destination: a.destination,
    escrowPayer: a.escrowPayer,
  });
}
export const setAutoClaimIx = (wallet: PublicKey, mint: PublicKey, enabled: boolean) => ix("set_auto_claim", { wallet, position: positionPda(mint, wallet) }, { enabled });
export function closeTicketIx(a: { caller: PublicKey; ticket: PublicKey; rentPayer: PublicKey; mint: PublicKey; owner: PublicKey; queued?: boolean }): TransactionInstruction {
  return ix("close_ticket", {
    caller: a.caller,
    global: globalPda(),
    ticket: a.ticket,
    rentPayer: a.rentPayer,
    position: positionPda(a.mint, a.owner),
    claimQueue: a.queued ? claimQueuePda(a.mint) : null,
    coin: coinPda(a.mint),
  });
}
/** `close_position` — remaining = ticket PDAs seq 0..next_ticket_seq (none may be live). */
export function closePositionIx(a: { signer: PublicKey; mint: PublicKey; wallet: PublicKey; rentPayer: PublicKey; nextTicketSeq: bigint }): TransactionInstruction {
  const remaining: AccountMeta[] = [];
  for (let s = 0n; s < a.nextTicketSeq; s++) remaining.push(r(ticketPda(a.mint, a.wallet, s)));
  return ix("close_position", { signer: a.signer, position: positionPda(a.mint, a.wallet), rentPayer: a.rentPayer }, {}, remaining);
}

