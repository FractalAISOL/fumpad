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
  globalPda,
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

const openTicketMetas = (tickets: PublicKey[]) => tickets.map(w);

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

export function updateParamsIx(admin: PublicKey, params: Params): TransactionInstruction {
  const keys = idlMetas(FUMPAD_IDL, FUMPAD_PROGRAM_ID, "update_params", { admin, global: globalPda() });
  return makeIx(FUMPAD_PROGRAM_ID, keys, fumpadCoder().instruction.encode("update_params", { params: paramsToIdl(params) }));
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

/** Curve `buy`. `openTickets` = EVERY open/queued ticket in the user's Position (rebuy rule). */
export function buyIx(a: {
  user: PublicKey;
  mint: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
  openTickets: PublicKey[];
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
    openTicketMetas(a.openTickets),
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

/** `graduate` (permissionless). Needs ~300–310k CU; send with `CU.graduate`. */
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
      poolAuthorityWsol: wsolAta(pa),
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
    },
    {},
    a.extra ?? [],
  );
}

// ── rewards ─────────────────────────────────────────────────────────────────

export function registerHoldingsIx(a: { user: PublicKey; mint: PublicKey; openTickets: PublicKey[] }): TransactionInstruction {
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
    openTicketMetas(a.openTickets),
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

/** `process_queue`. `entries` = (ticket, owner) for a subsequence of the queue, IN QUEUE ORDER. */
export function processQueueIx(a: {
  cranker: PublicKey;
  mint: PublicKey;
  maxEntries: number;
  entries: { ticket: PublicKey; owner: PublicKey }[];
}): TransactionInstruction {
  const c = coinAddresses(a.mint);
  const rem = a.entries.flatMap((e) => [w(e.ticket), w(positionPda(a.mint, e.owner)), w(coinAta(e.owner, a.mint))]);
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

/** `close_ticket`. Pass `queued: true` when the ticket was ever queued (ticket.queued_at ≠ 0). */
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

/** Grows the queue by ≤10 KiB per call; send 3 in one tx after graduation. */
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
 * remaining = [open tickets…, 17 PumpSwap accounts].
 */
export function swapBuyIx(a: {
  user: PublicKey;
  mint: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
  openTickets: PublicKey[];
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
    [...openTicketMetas(a.openTickets), ...userVenueAccounts(venuePool(a.mint), a.user, a.buybackFeeRecipient)],
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

