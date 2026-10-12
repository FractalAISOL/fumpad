/**
 * Instruction builders for EVERY `fumpad` instruction (lib.rs). This module and
 * `locker.ts` are the only places that know account lists; the IDL drives order and
 * flags (`idlMetas`), so a contract change surfaces here first.
 *
 * Amounts are raw units (bigint lamports / base units). Convert display amounts with
 * `units.ts` before calling.
 */
import { type AccountMeta, PublicKey, type TransactionInstruction } from "@solana/web3.js";

import { bytesToHex, hexToBytes, toIdl } from "../borsh.js";
import { FUMPAD_IDL, fumpadCoder } from "../coder.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  FUMPAD_PROGRAM_ID,
  MAX_KEEPERS,
  PUMPSWAP_GLOBAL_CONFIG,
  PYTH_SOL_USD_ACCOUNT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../constants.js";
import type { Params } from "../params.js";
import {
  ata,
  coinAddresses,
  coinAta,
  coinPda,
  escrowPda,
  globalPda,
  graduationWsolPda,
  mintAuthorityPda,
  poolAuthorityPda,
  positionPda,
  programDataPda,
  pumpEventAuthorityPda,
  ticketPda,
  wsolAta,
} from "../pda.js";
import { type AccountsInput, idlMetas, makeIx, r, w } from "./metas.js";
import { userVenueAccounts, venueAccounts, type VenuePool } from "./pumpswap.js";

function ix(name: string, accounts: AccountsInput, args: Record<string, unknown> = {}, remaining: AccountMeta[] = []) {
  const keys = idlMetas(FUMPAD_IDL, FUMPAD_PROGRAM_ID, name, accounts).concat(remaining);
  const data = fumpadCoder().instruction.encode(name, toIdl(args) as Record<string, unknown>);
  return makeIx(FUMPAD_PROGRAM_ID, keys, data);
}

/**
 * Rebuy-rule accounts: the position's open tickets, then — iff any of them is Queued —
 * the coin's ClaimQueue (v0.3: the rebuy updates the queue entry in place).
 */
const openTicketMetas = (tickets: PublicKey[], mint?: PublicKey, anyQueued?: boolean) =>
  anyQueued && mint ? [...tickets.map(w), w(coinAddresses(mint).claimQueue)] : tickets.map(w);

// ── admin ───────────────────────────────────────────────────────────────────

export function paramsToIdl(p: Params): Record<string, unknown> {
  const { solUsdFeedId, ...rest } = p;
  return { ...(toIdl(rest) as Record<string, unknown>), sol_usd_feed_id: hexToBytes(solUsdFeedId) };
}
export function paramsFromIdl(raw: Record<string, unknown>): Params {
  // raw is normalized (camelCase, bigint).
  const feed = raw.solUsdFeedId as number[];
  return { ...(raw as unknown as Params), solUsdFeedId: bytesToHex(feed) };
}

/** `initialize_global` — payer must be the fumpad program's upgrade authority. */
export function initializeGlobalIx(a: {
  payer: PublicKey;
  admin: PublicKey;
  platformTreasury: PublicKey;
  params: Params;
}): TransactionInstruction {
  const keys = idlMetas(FUMPAD_IDL, FUMPAD_PROGRAM_ID, "initialize_global", {
    payer: a.payer,
    global: globalPda(),
    program: FUMPAD_PROGRAM_ID,
    programData: programDataPda(),
  });
  const data = fumpadCoder().instruction.encode("initialize_global", {
    admin: a.admin,
    platform_treasury: a.platformTreasury,
    params: paramsToIdl(a.params),
  });
  return makeIx(FUMPAD_PROGRAM_ID, keys, data);
}

/** D15: queue a params change (admin); `executeParamsIx` applies it after 48h. */
export function queueParamsIx(admin: PublicKey, params: Params): TransactionInstruction {
  const keys = idlMetas(FUMPAD_IDL, FUMPAD_PROGRAM_ID, "queue_params", { admin, global: globalPda() });
  return makeIx(FUMPAD_PROGRAM_ID, keys, fumpadCoder().instruction.encode("queue_params", { params: paramsToIdl(params) }));
}

/** D15: apply the queued params once `Global.pending_eta` has passed (permissionless). */
export function executeParamsIx(caller: PublicKey): TransactionInstruction {
  return ix("execute_params", { caller, global: globalPda() });
}

/** D15: drop the queued params change (admin). */
export function cancelParamsIx(admin: PublicKey): TransactionInstruction {
  return ix("cancel_params", { admin, global: globalPda() });
}

export function setPauseIx(admin: PublicKey, paused: number): TransactionInstruction {
  return ix("set_pause", { admin, global: globalPda() }, { paused });
}

export function setKeepersIx(admin: PublicKey, keepers: PublicKey[]): TransactionInstruction {
  if (keepers.length > MAX_KEEPERS) throw new Error(`at most ${MAX_KEEPERS} keepers`);
  const slots = [...keepers];
  while (slots.length < MAX_KEEPERS) slots.push(PublicKey.default);
  return ix("set_keepers", { admin, global: globalPda() }, { keepers: slots });
}

export function setAdminIx(admin: PublicKey, newAdmin: PublicKey, platformTreasury: PublicKey): TransactionInstruction {
  return ix("set_admin", { admin, global: globalPda() }, { newAdmin, platformTreasury });
}

/**
 * v0.5: grow a Global written by an older program (672 bytes, v0.3/v0.4) to the current layout
 * in place, right after the program upgrade. `admin` = `Global.admin` (signs, pays the extra
 * rent). Only the newly appended params are set (in `params` and `pending_params`); no-op on a
 * current Global. Check with `globalNeedsMigration(data)` first.
 */
export function migrateGlobalIx(a: { admin: PublicKey; snipeWindowSlots: number; snipeStartBps: number }): TransactionInstruction {
  return ix("migrate_global", { admin: a.admin, global: globalPda() }, { args: { snipeWindowSlots: a.snipeWindowSlots, snipeStartBps: a.snipeStartBps } });
}

// ── curve ───────────────────────────────────────────────────────────────────

/** `create_coin` — `mint` is a fresh keypair that must also sign. */
export function createCoinIx(a: {
  creator: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}): TransactionInstruction {
  const c = coinAddresses(a.mint);
  return ix(
    "create_coin",
    {
      creator: a.creator,
      global: globalPda(),
      mint: a.mint,
      mintAuthority: mintAuthorityPda(),
      coin: c.coin,
      poolAuthority: poolAuthorityPda(),
      rewardVault: c.rewardVault,
      curveVault: c.curveVault,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    },
    { name: a.name, symbol: a.symbol, uri: a.uri },
  );
}

/**
 * Curve `buy`. `openTickets` = EVERY open/queued ticket in the user's Position (rebuy
 * rule); `anyQueued` = one of them is Queued (then the ClaimQueue is passed too).
 */
export function buyIx(a: {
  user: PublicKey;
  mint: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
  openTickets: PublicKey[];
  anyQueued?: boolean;
}): TransactionInstruction {
  const c = coinAddresses(a.mint);
  return ix(
    "buy",
    {
      user: a.user,
      global: globalPda(),
      coin: c.coin,
      mint: a.mint,
      poolAuthority: poolAuthorityPda(),
      curveVault: c.curveVault,
      rewardVault: c.rewardVault,
      userTokenAccount: coinAta(a.user, a.mint),
      position: positionPda(a.mint, a.user),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    },
    { solIn: a.solIn, minTokensOut: a.minTokensOut },
    openTicketMetas(a.openTickets, a.mint, a.anyQueued),
  );
}

/**
 * Curve `sell`. `nextTicketSeq` = position.next_ticket_seq (0 for a new position): the
 * ticket PDA is created only if the sell qualifies. `solUsdPrice` = Pyth PriceUpdateV2
 * account (a stale/missing price never blocks the sell; it just files no ticket).
 */
export function sellIx(a: {
  user: PublicKey;
  mint: PublicKey;
  tokensIn: bigint;
  minSolOut: bigint;
  nextTicketSeq: bigint;
  solUsdPrice?: PublicKey;
}): TransactionInstruction {
  const c = coinAddresses(a.mint);
  return ix(
    "sell",
    {
      user: a.user,
      global: globalPda(),
      coin: c.coin,
      mint: a.mint,
      poolAuthority: poolAuthorityPda(),
      curveVault: c.curveVault,
      rewardVault: c.rewardVault,
      userTokenAccount: coinAta(a.user, a.mint),
      position: positionPda(a.mint, a.user),
      ticket: ticketPda(a.mint, a.user, a.nextTicketSeq),
      solUsdPrice: a.solUsdPrice ?? PYTH_SOL_USD_ACCOUNT,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    },
    { tokensIn: a.tokensIn, minSolOut: a.minSolOut },
  );
}

/** `graduate` (permissionless). ~270k CU; send with `CU.graduate` (400k). */
export function graduateIx(a: { payer: PublicKey; mint: PublicKey; extra?: AccountMeta[] }): TransactionInstruction {
  const c = coinAddresses(a.mint);
  const pa = poolAuthorityPda();
  return ix(
    "graduate",
    {
      payer: a.payer,
      global: globalPda(),
      coin: c.coin,
      mint: a.mint,
      poolAuthority: pa,
      curveVault: c.curveVault,
      graduationWsol: graduationWsolPda(a.mint),
      ammPool: c.pool,
      ammGlobalConfig: PUMPSWAP_GLOBAL_CONFIG,
      lpMint: c.lpMint,
      poolAuthorityLp: ata(pa, c.lpMint, TOKEN_2022_PROGRAM_ID),
      poolBaseVault: c.poolBase,
      poolQuoteVault: c.poolQuote,
      ammEventAuthority: pumpEventAuthorityPda(),
      lpLock: c.lock,
      lpLockerAuthority: c.lockerAuthority,
      lpVault: c.lpVault,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      // D20 (v0.5): pre-funded with their rent out of the graduation fee.
      observations: c.observations,
      claimQueue: c.claimQueue,
    },
    {},
    a.extra ?? [],
  );
}

// ── rewards ─────────────────────────────────────────────────────────────────

export function registerHoldingsIx(a: { user: PublicKey; mint: PublicKey; openTickets: PublicKey[]; anyQueued?: boolean }): TransactionInstruction {
  return ix(
    "register_holdings",
    {
      user: a.user,
      global: globalPda(),
      coin: coinPda(a.mint),
      mint: a.mint,
      position: positionPda(a.mint, a.user),
      userTokenAccount: coinAta(a.user, a.mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    },
    {},
    openTicketMetas(a.openTickets, a.mint, a.anyQueued),
  );
}

export function claimIx(a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey }): TransactionInstruction {
  const c = coinAddresses(a.mint);
  return ix("claim", {
    owner: a.owner,
    global: globalPda(),
    coin: c.coin,
    mint: a.mint,
    ticket: a.ticket,
    position: positionPda(a.mint, a.owner),
    claimQueue: c.claimQueue,
    observations: c.observations,
    poolAuthority: poolAuthorityPda(),
    rewardVault: c.rewardVault,
    ownerTokenAccount: coinAta(a.owner, a.mint),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
}

/**
 * D17 `claim_for` (registered keeper only): claims `ticket` on its owner's behalf. Payout
 * always goes to the owner's canonical Token-2022 ATA (or escrow if it can't receive);
 * the keeper pays escrow rent. Fails `AutoClaimDisabled` if the owner opted out.
 */
export function claimForIx(a: { keeper: PublicKey; mint: PublicKey; ticket: PublicKey; owner: PublicKey }): TransactionInstruction {
  const c = coinAddresses(a.mint);
  return ix("claim_for", {
    keeper: a.keeper,
    global: globalPda(),
    coin: c.coin,
    mint: a.mint,
    ticket: a.ticket,
    position: positionPda(a.mint, a.owner),
    claimQueue: c.claimQueue,
    observations: c.observations,
    poolAuthority: poolAuthorityPda(),
    rewardVault: c.rewardVault,
    ownerAta: coinAta(a.owner, a.mint),
    escrow: escrowPda(a.ticket),
  });
}

/** D17 `set_auto_claim(enabled)`: the wallet's Position on `mint` must exist. */
export function setAutoClaimIx(a: { wallet: PublicKey; mint: PublicKey; enabled: boolean }): TransactionInstruction {
  return ix("set_auto_claim", { wallet: a.wallet, position: positionPda(a.mint, a.wallet) }, { enabled: a.enabled });
}

/**
 * `process_queue`. `entries` = (ticket, owner) for a subsequence of the queue, IN QUEUE
 * ORDER, ≤ 13 per tx. Remaining = quadruples [ticket, position, owner ATA, escrow PDA]; a
 * missing/refusing ATA escrows the payout (D16), so create owner ATAs first.
 */
export function processQueueIx(a: {
  cranker: PublicKey;
  mint: PublicKey;
  maxEntries: number;
  entries: { ticket: PublicKey; owner: PublicKey }[];
}): TransactionInstruction {
  const c = coinAddresses(a.mint);
  const rem = a.entries.flatMap((e) => [w(e.ticket), w(positionPda(a.mint, e.owner)), w(coinAta(e.owner, a.mint)), w(escrowPda(e.ticket))]);
  return ix(
    "process_queue",
    {
      cranker: a.cranker,
      global: globalPda(),
      coin: c.coin,
      mint: a.mint,
      claimQueue: c.claimQueue,
      poolAuthority: poolAuthorityPda(),
      rewardVault: c.rewardVault,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    },
    { maxEntries: a.maxEntries },
    rem,
  );
}

/** `close_ticket`. Pass `queued: true` when the ticket was ever queued (queue account optional otherwise). */
export function closeTicketIx(a: {
  caller: PublicKey;
  ticket: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  queued: boolean;
}): TransactionInstruction {
  return ix("close_ticket", {
    caller: a.caller,
    global: globalPda(),
    ticket: a.ticket,
    owner: a.owner,
    position: positionPda(a.mint, a.owner),
    claimQueue: a.queued ? coinAddresses(a.mint).claimQueue : null,
  });
}

export function withdrawCreatorFeesIx(a: { creator: PublicKey; mint: PublicKey }): TransactionInstruction {
  return ix("withdraw_creator_fees", { creator: a.creator, coin: coinPda(a.mint) });
}

/** Permissionless; pays `Global.platform_treasury`. */
export function withdrawPlatformFeesIx(a: {
  caller: PublicKey;
  mint: PublicKey;
  platformTreasury: PublicKey;
}): TransactionInstruction {
  return ix("withdraw_platform_fees", {
    caller: a.caller,
    global: globalPda(),
    coin: coinPda(a.mint),
    platformTreasury: a.platformTreasury,
  });
}

/**
 * D16: move an escrowed payout to `destination` (default: the owner's canonical ATA) and
 * refund the escrow rent to `escrowPayer` (= ticket.escrow_payer).
 */
export function withdrawEscrowIx(a: {
  owner: PublicKey;
  mint: PublicKey;
  ticket: PublicKey;
  escrowPayer: PublicKey;
  destination?: PublicKey;
}): TransactionInstruction {
  return ix("withdraw_escrow", {
    owner: a.owner,
    global: globalPda(),
    mint: a.mint,
    ticket: a.ticket,
    escrow: escrowPda(a.ticket),
    poolAuthority: poolAuthorityPda(),
    destination: a.destination ?? coinAta(a.owner, a.mint),
    escrowPayer: a.escrowPayer,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
}

/** Grows the queue by ≤10 KiB per call; send CLAIM_QUEUE_INIT_CALLS (9) in one tx after graduation. */
export function initClaimQueueIx(a: { payer: PublicKey; mint: PublicKey }): TransactionInstruction {
  const c = coinAddresses(a.mint);
  return ix("init_claim_queue", { payer: a.payer, coin: c.coin, claimQueue: c.claimQueue });
}

// ── venue ───────────────────────────────────────────────────────────────────

function venuePool(mint: PublicKey): VenuePool {
  const c = coinAddresses(mint);
  return { pool: c.pool, mint, poolBase: c.poolBase, poolQuote: c.poolQuote };
}

/**
 * Router buy on PumpSwap. The program wraps exactly `solIn`, swaps, charges FUMPAD's fee
 * on top in native SOL, and closes the user's WSOL ATA (no client-side wrap needed).
 * remaining = [open tickets…, (ClaimQueue iff any Queued), 17 PumpSwap accounts].
 */
export function swapBuyIx(a: {
  user: PublicKey;
  mint: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
  openTickets: PublicKey[];
  anyQueued?: boolean;
  buybackFeeRecipient: PublicKey;
}): TransactionInstruction {
  return ix(
    "swap_buy",
    {
      user: a.user,
      global: globalPda(),
      coin: coinPda(a.mint),
      mint: a.mint,
      position: positionPda(a.mint, a.user),
      userTokenAccount: coinAta(a.user, a.mint),
      userWsol: wsolAta(a.user),
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    },
    { solIn: a.solIn, minTokensOut: a.minTokensOut },
    [...openTicketMetas(a.openTickets, a.mint, a.anyQueued), ...userVenueAccounts(venuePool(a.mint), a.user, a.buybackFeeRecipient)],
  );
}

/** Router sell on PumpSwap; `minSolOut` bounds the NET SOL (after FUMPAD's fee). */
export function swapSellIx(a: {
  user: PublicKey;
  mint: PublicKey;
  tokensIn: bigint;
  minSolOut: bigint;
  nextTicketSeq: bigint;
  buybackFeeRecipient: PublicKey;
  solUsdPrice?: PublicKey;
}): TransactionInstruction {
  return ix(
    "swap_sell",
    {
      user: a.user,
      global: globalPda(),
      coin: coinPda(a.mint),
      mint: a.mint,
      position: positionPda(a.mint, a.user),
      ticket: ticketPda(a.mint, a.user, a.nextTicketSeq),
      solUsdPrice: a.solUsdPrice ?? PYTH_SOL_USD_ACCOUNT,
      userTokenAccount: coinAta(a.user, a.mint),
      userWsol: wsolAta(a.user),
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    },
    { tokensIn: a.tokensIn, minSolOut: a.minSolOut },
    userVenueAccounts(venuePool(a.mint), a.user, a.buybackFeeRecipient),
  );
}

/**
 * Post-graduation buyback crank (permissionless). The PumpSwap `user` is the pool
 * authority PDA; one-time setup: `initUserVolumeAccumulatorIx(payer, poolAuthorityPda())`.
 */
export function executeBuybackIx(a: {
  cranker: PublicKey;
  mint: PublicKey;
  maxLamports: bigint;
  buybackFeeRecipient: PublicKey;
}): TransactionInstruction {
  const c = coinAddresses(a.mint);
  const pa = poolAuthorityPda();
  return ix(
    "execute_buyback",
    {
      cranker: a.cranker,
      global: globalPda(),
      coin: c.coin,
      mint: a.mint,
      observations: c.observations,
      rewardVault: c.rewardVault,
      poolAuthority: pa,
      buybackWsol: wsolAta(pa),
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    },
    { maxLamports: a.maxLamports },
    venueAccounts(venuePool(a.mint), pa, c.rewardVault, wsolAta(pa), a.buybackFeeRecipient),
  );
}

export function initObservationsIx(a: { payer: PublicKey; mint: PublicKey }): TransactionInstruction {
  const c = coinAddresses(a.mint);
  return ix("init_observations", { payer: a.payer, coin: c.coin, observations: c.observations });
}

/**
 * `record_samples` for up to 10 coins (5 per legacy tx). MUST be the only
 * non-compute-budget instruction in its transaction (instruction-sysvar check).
 */
export function recordSamplesIx(a: { sampler: PublicKey; mints: PublicKey[] }): TransactionInstruction {
  if (a.mints.length === 0 || a.mints.length > 10) throw new Error("record_samples takes 1..10 coins");
  const rem = a.mints.flatMap((m) => {
    const c = coinAddresses(m);
    return [w(c.coin), w(c.observations), r(c.pool), r(c.poolBase), r(c.poolQuote)];
  });
  return ix("record_samples", { sampler: a.sampler, global: globalPda() }, {}, rem);
}

/** Unwrap skimmed LP-fee WSOL (ATA(coin, WSOL)) into the coin's fee counters. */
export function settleLpFeesIx(a: { cranker: PublicKey; mint: PublicKey }): TransactionInstruction {
  const c = coinAddresses(a.mint);
  return ix("settle_lp_fees", {
    cranker: a.cranker,
    coin: c.coin,
    lpFeeWsol: c.lpFeeWsol,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
}

