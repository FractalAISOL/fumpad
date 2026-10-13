/**
 * High-level client: reads the chain state an instruction needs (open tickets, next
 * ticket seq, pool reserves, buyback fee recipient…) and returns ready-to-sign
 * instruction lists with compute budgets. Browser-safe (no node: imports, no fs).
 */
import {
  type AddressLookupTableAccount,
  type Commitment,
  type Connection,
  type Keypair,
  PublicKey,
  type Signer,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import bs58 from "bs58";

import {
  accountDiscriminator,
  type ClaimQueueAccount,
  type CoinAccount,
  coinRewardParams,
  decodeClaimQueue,
  decodeCoin,
  decodeGlobal,
  decodeObservations,
  decodePosition,
  decodePumpPool,
  decodePythPriceUpdate,
  decodeTicket,
  decodeTokenAccount,
  type GlobalAccount,
  type ObservationsAccount,
  type PositionAccount,
  type QueueEntry,
  type TicketAccount,
} from "./accounts.js";
import {
  CLAIM_QUEUE_ACCOUNT_SIZE,
  OBSERVATIONS_ACCOUNT_SIZE,
  CU,
  initClaimQueueCu,
  SEEDS,
  FUMPAD_PROGRAM_ID,
  MAX_QUEUE_ENTRIES_PER_TX,
  PUMPSWAP_DEFAULT_FEE_BPS,
  PUMPSWAP_FEE_CONFIG,
  PUMPSWAP_GLOBAL_CONFIG,
  PYTH_SOL_USD_ACCOUNT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./constants.js";
import {
  buyIx,
  claimForIx,
  claimIx,
  closeTicketIx,
  setAutoClaimIx,
  createCoinIx,
  executeBuybackIx,
  executeParamsIx,
  graduateIx,
  initClaimQueueIx,
  initObservationsIx,
  processQueueIx,
  recordSamplesIx,
  registerHoldingsIx,
  sellIx,
  settleLpFeesIx,
  swapBuyIx,
  swapSellIx,
  withdrawCreatorFeesIx,
  withdrawEscrowIx,
  withdrawPlatformFeesIx,
} from "./instructions/fumpad.js";
import { skimIxs } from "./instructions/locker.js";
import { buybackFeeRecipientAta, initUserVolumeAccumulatorIx, parseBuybackFeeRecipients, parseFeeConfigFlatFees, parseGlobalConfigFees } from "./instructions/pumpswap.js";
import { computeBudgetIxs, createAtaIdempotentIx } from "./instructions/spl.js";
import { isCreatorLaunchBuy, snipeTaxBps } from "./math/fees.js";
import { planQueuePayments } from "./math/rewards.js";
import type { PoolReserves } from "./math/pumpswap.js";
import {
  coinAddresses,
  coinAta,
  coinPda,
  globalPda,
  poolAuthorityPda,
  pumpswapSignerPda,
  positionPda,
  ticketPda,
  userVolumeAccumulatorPda,
} from "./pda.js";
import { type BuyQuoteRaw, quoteCurveBuy, quoteCurveSell, quoteSwapBuy, quoteSwapSell, reservesOf, type SellQuoteRaw } from "./quote.js";
import { withSlippage } from "./units.js";

export interface ClientOptions {
  commitment?: Commitment;
  /** Pyth SOL/USD PriceUpdateV2 account passed to sells. */
  solUsdAccount?: PublicKey;
  /** Priority fee (micro-lamports per CU) added to every built transaction. */
  priorityMicroLamports?: number;
}

/** Ticket.status byte: 8 disc + bump 1 + owner 32 + mint 32 + seq 8 + tokens 8 + original 8 + price 16 + usd 8 + ts 8. */
export const TICKET_STATUS_OFFSET = 129;

export interface BuiltTx {
  instructions: TransactionInstruction[];
  /** Extra signers besides the fee payer (e.g. the new mint keypair). */
  signers?: Signer[];
}

export class FumpadClient {
  readonly commitment: Commitment;
  readonly solUsdAccount: PublicKey;
  priorityMicroLamports: number;
  private bfr?: PublicKey;
  private venueFee?: bigint;
  private globalCache?: { at: number; g: GlobalAccount };

  constructor(readonly connection: Connection, opts: ClientOptions = {}) {
    this.commitment = opts.commitment ?? "confirmed";
    this.solUsdAccount = opts.solUsdAccount ?? PYTH_SOL_USD_ACCOUNT;
    this.priorityMicroLamports = opts.priorityMicroLamports ?? 0;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  private async data(key: PublicKey): Promise<Uint8Array | null> {
    const a = await this.connection.getAccountInfo(key, this.commitment);
    return a && a.lamports > 0 ? new Uint8Array(a.data) : null;
  }

  async global(maxAgeMs = 30_000): Promise<GlobalAccount> {
    if (this.globalCache && Date.now() - this.globalCache.at < maxAgeMs) return this.globalCache.g;
    const d = await this.data(globalPda());
    if (!d) throw new Error("Global not initialized");
    const g = decodeGlobal(d);
    this.globalCache = { at: Date.now(), g };
    return g;
  }
  async coin(mint: PublicKey): Promise<CoinAccount | null> {
    const d = await this.data(coinPda(mint));
    return d ? decodeCoin(d) : null;
  }
  async position(mint: PublicKey, wallet: PublicKey): Promise<PositionAccount | null> {
    const d = await this.data(positionPda(mint, wallet));
    return d ? decodePosition(d) : null;
  }
  async ticket(key: PublicKey): Promise<TicketAccount | null> {
    const d = await this.data(key);
    return d ? decodeTicket(d) : null;
  }
  async observations(mint: PublicKey): Promise<ObservationsAccount | null> {
    const d = await this.data(coinAddresses(mint).observations);
    // D20: graduate pre-funds the PDA with rent before `init_observations` creates it, so an
    // existing-but-empty account means "not initialised yet".
    return d && d.length >= OBSERVATIONS_ACCOUNT_SIZE ? decodeObservations(d) : null;
  }
  async claimQueue(mint: PublicKey): Promise<ClaimQueueAccount | null> {
    const d = await this.data(coinAddresses(mint).claimQueue);
    // Header is written only once the account reaches full size.
    return d && d.length >= CLAIM_QUEUE_ACCOUNT_SIZE ? decodeClaimQueue(d) : null;
  }
  async tokenBalance(account: PublicKey): Promise<bigint> {
    const d = await this.data(account);
    return d ? decodeTokenAccount(d).amount : 0n;
  }
  /** Effective PumpSwap reserves of the coin's pool (quote incl. virtual_quote_reserves). */
  async poolReserves(mint: PublicKey): Promise<PoolReserves & { lpSupply: bigint }> {
    const c = coinAddresses(mint);
    const [pool, base, quote] = await this.connection.getMultipleAccountsInfo([c.pool, c.poolBase, c.poolQuote], this.commitment);
    if (!pool || !base || !quote) throw new Error("pool not found");
    const p = decodePumpPool(new Uint8Array(pool.data));
    const b = decodeTokenAccount(new Uint8Array(base.data)).amount;
    const q = decodeTokenAccount(new Uint8Array(quote.data)).amount;
    return { base: b, quote: q + p.virtualQuoteReserves, lpSupply: p.lpSupply };
  }
  /** WSOL ATA of the first configured PumpSwap buyback fee recipient (cached). */
  async buybackFeeRecipient(): Promise<PublicKey> {
    if (this.bfr) return this.bfr;
    const d = await this.data(PUMPSWAP_GLOBAL_CONFIG);
    if (!d) throw new Error("PumpSwap GlobalConfig missing");
    const rs = parseBuybackFeeRecipients(d);
    if (!rs.length) throw new Error("no buyback fee recipients in GlobalConfig");
    this.bfr = buybackFeeRecipientAta(rs[0]);
    return this.bfr;
  }
  /** Total PumpSwap fee on a FUMPAD (non-pump) pool: Pump Fees flat fees, else GlobalConfig. */
  async pumpswapFeeBps(): Promise<bigint> {
    if (this.venueFee !== undefined) return this.venueFee;
    const fc = await this.data(PUMPSWAP_FEE_CONFIG);
    if (fc && fc.length >= 65) {
      const f = parseFeeConfigFlatFees(fc);
      return (this.venueFee = f.lpFeeBps + f.protocolFeeBps + f.creatorFeeBps);
    }
    const d = await this.data(PUMPSWAP_GLOBAL_CONFIG);
    if (!d) return PUMPSWAP_DEFAULT_FEE_BPS;
    const g = parseGlobalConfigFees(d);
    return (this.venueFee = g.lpFeeBps + g.protocolFeeBps);
  }
  async solUsd(): Promise<{ price: bigint; exponent: number } | null> {
    const d = await this.data(this.solUsdAccount);
    if (!d) return null;
    const p = decodePythPriceUpdate(d);
    return { price: p.price - p.conf, exponent: p.exponent };
  }
  /** On-chain unix time (Clock sysvar) — what the program compares against, not wall time. */
  async chainTime(): Promise<bigint> {
    const a = await this.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, this.commitment);
    if (!a) throw new Error("clock sysvar unavailable");
    return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigInt64(32, true);
  }

  /**
   * Open/queued tickets listed in the wallet's position (what buys / register_holdings
   * must pass) and whether any is Queued (then the ClaimQueue must follow them).
   */
  async openTickets(mint: PublicKey, wallet: PublicKey): Promise<{ keys: PublicKey[]; anyQueued: boolean }> {
    const keys = (await this.position(mint, wallet))?.openTickets ?? [];
    if (!keys.length) return { keys, anyQueued: false };
    const infos = await this.connection.getMultipleAccountsInfo(keys, this.commitment);
    const anyQueued = infos.some((i) => i && i.data.length > 8 && decodeTicket(new Uint8Array(i.data)).status === "queued");
    return { keys, anyQueued };
  }

  // ── builders ───────────────────────────────────────────────────────────────

  private cb(units: number) {
    return computeBudgetIxs(units, this.priorityMicroLamports);
  }

  /**
   * create_coin (+ optional first buy in the same tx). The mint must sign: pass its
   * Keypair, or just its PublicKey when someone else co-signs (D18 vanity mints: the API
   * signs as the mint, the creator's wallet as fee payer).
   */
  async buildLaunch(a: { creator: PublicKey; mint: Keypair | PublicKey; name: string; symbol: string; uri: string; initialBuyLamports?: bigint; slippageBps?: number }): Promise<BuiltTx & { quote?: BuyQuoteRaw }> {
    const mintKp = "secretKey" in a.mint ? a.mint : null;
    const mint = mintKp ? mintKp.publicKey : (a.mint as PublicKey);
    const ixs = [createCoinIx({ creator: a.creator, mint, name: a.name, symbol: a.symbol, uri: a.uri })];
    let quote: BuyQuoteRaw | undefined;
    if (a.initialBuyLamports && a.initialBuyLamports > 0n) {
      const g = await this.global();
      const p = g.params;
      // New coin: its fee snapshot will be the current Global.params (D14). The creator's buy
      // bundled with create_coin is exempt from the D19 snipe tax (snipeBps = 0).
      quote = quoteCurveBuy({ virtualSol: p.initialVirtualSol, virtualToken: p.initialVirtualToken, realSol: 0n, realToken: p.curveSupply }, p, a.initialBuyLamports, 0)!;
      ixs.push(buyIx({ user: a.creator, mint, solIn: quote.solIn, minTokensOut: withSlippage(quote.tokensOut, a.slippageBps ?? 100), openTickets: [] }));
    }
    return { instructions: [...this.cb(quote ? CU.createCoinAndBuy : CU.createCoin), ...ixs], signers: mintKp ? [mintKp] : [], quote };
  }

  /** Buy for a total SOL budget (fee included); routes curve vs PumpSwap by coin status. */
  async buildBuy(a: { user: PublicKey; mint: PublicKey; budgetLamports: bigint; slippageBps?: number }): Promise<BuiltTx & { quote: BuyQuoteRaw }> {
    const [coin, open] = await Promise.all([this.coin(a.mint), this.openTickets(a.mint, a.user)]);
    if (!coin) throw new Error("coin not found");
    const slip = a.slippageBps ?? 100;
    if (coin.status === "curve") {
      // D19: quote at the current slot (pessimistic — the snipe tax only decays).
      const slot = BigInt(await this.connection.getSlot(this.commitment));
      const exempt = isCreatorLaunchBuy({ user: a.user.toBase58(), creator: coin.creator.toBase58(), slot, launchSlot: coin.snipe.launchSlot, tradeCount: coin.tradeCount });
      const q = quoteCurveBuy(reservesOf(coin), coin.fees, a.budgetLamports, exempt ? 0 : snipeTaxBps(coin.snipe, slot));
      if (!q || q.tokensOut === 0n) throw new Error("amount too small");
      return {
        quote: q,
        instructions: [...this.cb(CU.buy), buyIx({ user: a.user, mint: a.mint, solIn: q.solIn, minTokensOut: withSlippage(q.tokensOut, slip), openTickets: open.keys, anyQueued: open.anyQueued })],
      };
    }
    if (coin.status !== "graduated") throw new Error("coin is complete — waiting for graduation");
    const [pool, fee, bfr] = await Promise.all([this.poolReserves(a.mint), this.pumpswapFeeBps(), this.buybackFeeRecipient()]);
    const q = quoteSwapBuy(pool, coin.fees, a.budgetLamports, fee);
    return {
      quote: q,
      instructions: [
        ...this.cb(CU.swapBuy),
        swapBuyIx({ user: a.user, mint: a.mint, solIn: q.solIn, minTokensOut: withSlippage(q.tokensOut, slip), openTickets: open.keys, anyQueued: open.anyQueued, buybackFeeRecipient: bfr }),
      ],
    };
  }

  async buildSell(a: { user: PublicKey; mint: PublicKey; tokensIn: bigint; slippageBps?: number }): Promise<BuiltTx & { quote: SellQuoteRaw; ticket: PublicKey }> {
    const [coin, pos] = await Promise.all([this.coin(a.mint), this.position(a.mint, a.user)]);
    if (!coin) throw new Error("coin not found");
    const seq = pos?.nextTicketSeq ?? 0n;
    const ticket = ticketPda(a.mint, a.user, seq);
    const slip = a.slippageBps ?? 100;
    if (coin.status === "curve") {
      const q = quoteCurveSell(reservesOf(coin), coin.fees, a.tokensIn);
      if (!q) throw new Error("curve cannot pay this sell");
      return {
        quote: q,
        ticket,
        instructions: [...this.cb(CU.sell), sellIx({ user: a.user, mint: a.mint, tokensIn: a.tokensIn, minSolOut: withSlippage(q.net, slip), nextTicketSeq: seq, solUsdPrice: this.solUsdAccount })],
      };
    }
    if (coin.status !== "graduated") throw new Error("coin is complete — waiting for graduation");
    const [pool, fee, bfr] = await Promise.all([this.poolReserves(a.mint), this.pumpswapFeeBps(), this.buybackFeeRecipient()]);
    const q = quoteSwapSell(pool, coin.fees, a.tokensIn, fee);
    return {
      quote: q,
      ticket,
      instructions: [
        ...this.cb(CU.swapSell),
        swapSellIx({ user: a.user, mint: a.mint, tokensIn: a.tokensIn, minSolOut: withSlippage(q.net, slip), nextTicketSeq: seq, buybackFeeRecipient: bfr, solUsdPrice: this.solUsdAccount }),
      ],
    };
  }

  /** Claim; creates the owner's ATA first if it was closed. */
  buildClaim(a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey }): BuiltTx {
    return {
      instructions: [
        ...this.cb(CU.claim),
        createAtaIdempotentIx(a.owner, a.owner, a.mint, TOKEN_2022_PROGRAM_ID),
        claimIx(a),
      ],
    };
  }

  /**
   * D17 auto-claim (registered keeper): idempotent owner-ATA create paid by the keeper (so
   * the payout lands directly instead of in escrow), then `claim_for`.
   */
  buildClaimFor(a: { keeper: PublicKey; mint: PublicKey; ticket: PublicKey; owner: PublicKey }): BuiltTx {
    return {
      instructions: [
        ...this.cb(CU.claimFor),
        createAtaIdempotentIx(a.keeper, a.owner, a.mint, TOKEN_2022_PROGRAM_ID),
        claimForIx(a),
      ],
    };
  }

  /** Opt this wallet in/out of keeper auto-claim on one coin (needs an existing Position). */
  buildSetAutoClaim(a: { wallet: PublicKey; mint: PublicKey; enabled: boolean }): BuiltTx {
    return { instructions: [...this.cb(CU.setAutoClaim), setAutoClaimIx(a)] };
  }

  async buildRegisterHoldings(a: { user: PublicKey; mint: PublicKey }): Promise<BuiltTx> {
    const open = await this.openTickets(a.mint, a.user);
    return { instructions: [...this.cb(CU.default), registerHoldingsIx({ ...a, openTickets: open.keys, anyQueued: open.anyQueued })] };
  }

  async buildCloseTicket(a: { caller: PublicKey; ticket: PublicKey }): Promise<BuiltTx> {
    const t = await this.ticket(a.ticket);
    if (!t) throw new Error("ticket not found");
    return { instructions: [closeTicketIx({ caller: a.caller, ticket: a.ticket, owner: t.owner, mint: t.mint, queued: t.queuedAt !== 0n })] };
  }

  /** D16: withdraw an escrowed payout to the owner's canonical ATA (created if missing). */
  async buildWithdrawEscrow(a: { owner: PublicKey; ticket: PublicKey }): Promise<BuiltTx> {
    const t = await this.ticket(a.ticket);
    if (!t) throw new Error("ticket not found");
    return {
      instructions: [
        createAtaIdempotentIx(a.owner, a.owner, t.mint, TOKEN_2022_PROGRAM_ID),
        withdrawEscrowIx({ owner: a.owner, mint: t.mint, ticket: a.ticket, escrowPayer: t.escrowPayer }),
      ],
    };
  }

  /** D15: apply a queued params change once its 48h timelock has passed (permissionless). */
  buildExecuteParams(caller: PublicKey): BuiltTx {
    return { instructions: [executeParamsIx(caller)] };
  }

  buildWithdrawCreatorFees(a: { creator: PublicKey; mint: PublicKey }): BuiltTx {
    return { instructions: [withdrawCreatorFeesIx(a)] };
  }
  async buildWithdrawPlatformFees(a: { caller: PublicKey; mint: PublicKey }): Promise<BuiltTx> {
    const g = await this.global();
    return { instructions: [withdrawPlatformFeesIx({ ...a, platformTreasury: g.platformTreasury })] };
  }

  // ── cranks ─────────────────────────────────────────────────────────────────

  buildGraduate(a: { payer: PublicKey; mint: PublicKey }): BuiltTx {
    return { instructions: [...this.cb(CU.graduate), graduateIx(a)] };
  }

  /**
   * After graduation: [init_observations], [9× init_claim_queue in one tx (v0.4, 1024
   * entries, ~69k CU)], and (once, globally) PumpSwap init_user_volume_accumulator for the
   * buyback signer (v0.6 L-1: `pumpswap_signer`, was the pool authority) — each its own tx.
   * Already-done steps are skipped.
   */
  async buildPostGraduation(a: { payer: PublicKey; mint: PublicKey }): Promise<BuiltTx[]> {
    const c = coinAddresses(a.mint);
    const pa = pumpswapSignerPda();
    const [obs, queue, uva] = await this.connection.getMultipleAccountsInfo([c.observations, c.claimQueue, userVolumeAccumulatorPda(pa)], this.commitment);
    const out: BuiltTx[] = [];
    // D20: graduate pre-funds both PDAs with rent, so "exists" ≠ "initialised" — check the size.
    if (!obs || obs.data.length < OBSERVATIONS_ACCOUNT_SIZE) out.push({ instructions: [...this.cb(CU.initObservations), initObservationsIx(a)] });
    const full = CLAIM_QUEUE_ACCOUNT_SIZE;
    if (!queue || queue.data.length < full) {
      const have = queue?.data.length ?? 0;
      const calls = Math.max(1, Math.ceil((full - have) / 10_240));
      // Budget by the queue PDA's actual bump: each call re-derives it (a low bump costs ~1.5k CU per attempt).
      const [, bump] = PublicKey.findProgramAddressSync([SEEDS.claimQueue, a.mint.toBytes()], FUMPAD_PROGRAM_ID);
      out.push({ instructions: [...this.cb(initClaimQueueCu(bump) * calls), ...Array.from({ length: calls }, () => initClaimQueueIx(a))] });
    }
    if (!uva) out.push({ instructions: [initUserVolumeAccumulatorIx(a.payer, pa)] });
    return out;
  }

  /** [CU, create ATA(coin, WSOL), skim, settle_lp_fees] — nets ~0 rent for the cranker. */
  buildSkimSettle(a: { payer: PublicKey; mint: PublicKey }): BuiltTx {
    return { instructions: [...this.cb(CU.skimSettle), ...skimIxs(a.payer, a.mint), settleLpFeesIx({ cranker: a.payer, mint: a.mint })] };
  }

  /** Isolated sampling tx (only compute-budget instructions may accompany it). */
  buildRecordSamples(a: { sampler: PublicKey; mints: PublicKey[] }): BuiltTx {
    const units = CU.recordSamplesBase + CU.recordSamplesPerCoin * a.mints.length;
    return { instructions: [...this.cb(units), recordSamplesIx(a)] };
  }

  async buildExecuteBuyback(a: { cranker: PublicKey; mint: PublicKey; maxLamports: bigint }): Promise<BuiltTx> {
    return {
      instructions: [
        ...this.cb(CU.executeBuyback),
        executeBuybackIx({ ...a, buybackFeeRecipient: await this.buybackFeeRecipient() }),
      ],
    };
  }

  /**
   * process_queue for exactly the entries the program's skip-ahead walk will pay right now
   * (≤ `maxEntries`, ≤ 13), planned with `planQueuePayments` against the reward-vault balance
   * and the coin's per-claim cap — services review H-4: passing the first 13 entries paid
   * nothing whenever those didn't fit, however many later entries did. `null` = nothing
   * payable. `pool` / `maxClaimPoolBps` override the chain reads (tests, callers that already
   * have them). An owner whose ATA is missing/closed is paid into the ticket's escrow (D16,
   * rent refunded to the cranker by `withdraw_escrow`); `buildCreateAtas(owners)` first lands
   * payouts directly, but don't pay ATA rent for untrusted owners on a schedule (they can
   * close it and farm the rent).
   */
  async buildProcessQueue(a: {
    cranker: PublicKey;
    mint: PublicKey;
    maxEntries?: number;
    pool?: bigint;
    maxClaimPoolBps?: number;
  }): Promise<(BuiltTx & { owners: PublicKey[]; entries: QueueEntry[] }) | null> {
    const q = await this.claimQueue(a.mint);
    if (!q || q.len === 0) return null;
    const pool = a.pool ?? (await this.tokenBalance(coinAddresses(a.mint).rewardVault));
    let bps = a.maxClaimPoolBps;
    if (bps === undefined) {
      const coin = await this.coin(a.mint);
      if (!coin) return null;
      bps = coinRewardParams(coin, (await this.global()).params).maxClaimPoolBps;
    }
    const { pay } = planQueuePayments(q.entries, pool, bps, Math.min(a.maxEntries ?? MAX_QUEUE_ENTRIES_PER_TX, MAX_QUEUE_ENTRIES_PER_TX));
    if (!pay.length) return null;
    return {
      entries: pay,
      owners: [...new Map(pay.map((e) => [e.owner.toBase58(), e.owner])).values()],
      instructions: [...this.cb(CU.processQueue), processQueueIx({ cranker: a.cranker, mint: a.mint, maxEntries: pay.length, entries: pay })],
    };
  }

  /** Idempotent create of owners' Token-2022 ATAs for `mint` that don't exist yet (≤ 8 per tx). */
  async buildCreateAtas(a: { payer: PublicKey; mint: PublicKey; owners: PublicKey[] }): Promise<BuiltTx[]> {
    const atas = a.owners.map((o) => coinAta(o, a.mint));
    const infos = await this.connection.getMultipleAccountsInfo(atas, this.commitment);
    const missing = a.owners.filter((_, i) => !infos[i]);
    const out: BuiltTx[] = [];
    for (let i = 0; i < missing.length; i += 8) {
      out.push({ instructions: missing.slice(i, i + 8).map((o) => createAtaIdempotentIx(a.payer, o, a.mint, TOKEN_2022_PROGRAM_ID)) });
    }
    return out;
  }

  // ── scans (getProgramAccounts) ─────────────────────────────────────────────

  /** Every Coin account (keeper discovery; the indexer DB is the scalable alternative). */
  async scanCoins(): Promise<CoinAccount[]> {
    const disc = accountDiscriminator("Coin");
    const res = await this.connection.getProgramAccounts(FUMPAD_PROGRAM_ID, {
      commitment: this.commitment,
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
    });
    return res.map((r) => decodeCoin(new Uint8Array(r.account.data)));
  }

  /** Open tickets (status byte at offset 129 = Open), optionally for one mint. */
  async scanOpenTickets(mint?: PublicKey): Promise<{ key: PublicKey; ticket: TicketAccount }[]> {
    const filters: { memcmp: { offset: number; bytes: string } }[] = [
      { memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Ticket")) } },
      { memcmp: { offset: TICKET_STATUS_OFFSET, bytes: bs58.encode(Uint8Array.from([0])) } },
    ];
    if (mint) filters.push({ memcmp: { offset: 41, bytes: mint.toBase58() } });
    const res = await this.connection.getProgramAccounts(FUMPAD_PROGRAM_ID, { commitment: this.commitment, filters });
    return res.map((r) => ({ key: r.pubkey, ticket: decodeTicket(new Uint8Array(r.account.data)) }));
  }

  /** WSOL ATA a PumpSwap buyback-fee recipient must have (exists on mainnet/devnet; local validators need it). */
  async ensureBuybackFeeRecipientIx(payer: PublicKey): Promise<TransactionInstruction | null> {
    const d = await this.data(PUMPSWAP_GLOBAL_CONFIG);
    if (!d) return null;
    const rs = parseBuybackFeeRecipients(d);
    return rs.length ? createAtaIdempotentIx(payer, rs[0], WSOL_MINT, TOKEN_PROGRAM_ID) : null;
  }

  // ── send ───────────────────────────────────────────────────────────────────

  /** Build a v0 transaction (optionally with lookup tables). */
  async toTransaction(payer: PublicKey, b: BuiltTx, lookupTables: AddressLookupTableAccount[] = []): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.commitment);
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: b.instructions }).compileToV0Message(lookupTables);
    return { tx: new VersionedTransaction(msg), blockhash, lastValidBlockHeight };
  }

  /**
   * Sign with `payer` (+ b.signers), send, and confirm by POLLING signature statuses
   * (re-broadcasting every ~2 s) until `commitment` or blockhash expiry. Polling works on
   * HTTP-only RPCs and doesn't depend on a websocket. Node/scripts/keeper use.
   */
  async send(payer: Signer, b: BuiltTx, opts: { lookupTables?: AddressLookupTableAccount[]; skipPreflight?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const { tx, lastValidBlockHeight } = await this.toTransaction(payer.publicKey, b, opts.lookupTables);
    tx.sign([payer, ...(b.signers ?? [])]);
    const raw = tx.serialize();
    const sig = await this.connection.sendRawTransaction(raw, { skipPreflight: opts.skipPreflight ?? false, maxRetries: 0, preflightCommitment: this.commitment });
    await confirmSignature(this.connection, sig, lastValidBlockHeight, this.commitment, raw, opts.timeoutMs);
    return sig;
  }
}

export class TxFailedError extends Error {
  constructor(readonly signature: string, readonly err: unknown, readonly logs?: string[] | null) {
    super(`tx ${signature} failed: ${JSON.stringify(err)}`);
  }
}

const RANK: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };

/** Poll until the signature reaches `commitment`; throws on failure or blockhash expiry. */
export async function confirmSignature(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  commitment: Commitment = "confirmed",
  rebroadcast?: Uint8Array,
  timeoutMs = 90_000,
): Promise<void> {
  const want = RANK[commitment] ?? 1;
  const t0 = Date.now();
  let lastSend = Date.now();
  for (;;) {
    const st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: false })).value[0];
    if (st?.err) {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
      throw new TxFailedError(signature, st.err, tx?.meta?.logMessages);
    }
    if (st && RANK[st.confirmationStatus ?? "processed"] >= want) return;
    if (rebroadcast && Date.now() - lastSend > 2_000) {
      lastSend = Date.now();
      connection.sendRawTransaction(rebroadcast, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    if (Date.now() - t0 > timeoutMs || (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      const again = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (again && !again.err && RANK[again.confirmationStatus ?? "processed"] >= want) return;
      throw new Error(`tx ${signature} expired or timed out before ${commitment}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

