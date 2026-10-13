/**
 * Chain-backed endpoints (v0.7): quotes, balances, SOL/USD. Quotes read the live Coin, DBC pool + config
 * (curve) or DAMM v2 pool and Position accounts (RPC, cached ~2 s) and run Meteora's exact swap math
 * (@fumpad/sdk meteora/quote.ts), the D33 launch-window fee, the 50/30/20 split and the v0.7 ticket preview.
 * The D10/D12 reference lives in the keepers' engine (off chain), so the preview's floor is the execution
 * price (the attested floor can only be ≥ it).
 */
import { type Connection, PublicKey } from "@solana/web3.js";

import { planRebuy } from "@fumpad/engine";
import {
  BPS_DENOM,
  type CoinAccount,
  coinAta,
  coinPda,
  type DbcPoolConfig,
  decodeCoin,
  decodeDammPool,
  decodeDbcConfig,
  decodeDbcPool,
  decodeGlobal,
  decodePosition,
  decodePythPriceUpdate,
  decodeTicket,
  decodeTokenAccount,
  type GlobalAccount,
  globalPda,
  lamportsToSol,
  positionPda,
  PYTH_SOL_USD_ACCOUNT,
  priceQ64FromSqrt,
  pythUsd,
  q64ToSolPerToken,
  quoteDammBuy,
  quoteDammSell,
  quoteDbcBuy,
  quoteDbcSell,
  type SwapQuote,
  solToLamports,
  TOKEN_2022_PROGRAM_ID,
  tokensToBase,
} from "@fumpad/sdk";

import type { TtlCache } from "./cache.js";
import type { Side, TradeQuote } from "./generated/app-types.js";

const tok = (v: bigint) => Number(v) / 1e6;
const lam = (v: bigint) => Number(v) / 1e9;
const px = (q: bigint) => q64ToSolPerToken(q);
const NORMAL_FEE_NUMERATOR = 12_500_000n;

export class ChainReader {
  constructor(
    readonly conn: Connection,
    private cache: TtlCache,
    private opts: { solUsdFallback: number; pythAccount?: string; recentAcquired?: (wallet: string, mint: string, sinceTs: number) => Promise<bigint> },
  ) {}

  async solUsd(): Promise<number> {
    return this.cache.get("chain:solusd", 10_000, async () => {
      try {
        const a = await this.conn.getAccountInfo(this.opts.pythAccount ? new PublicKey(this.opts.pythAccount) : PYTH_SOL_USD_ACCOUNT);
        if (a) {
          const v = pythUsd(decodePythPriceUpdate(new Uint8Array(a.data)));
          if (v > 0) return v;
        }
      } catch {
        /* fall back */
      }
      return this.opts.solUsdFallback;
    });
  }

  global(): Promise<GlobalAccount> {
    return this.cache.get("chain:global", 10_000, async () => {
      const a = await this.conn.getAccountInfo(globalPda());
      if (!a) throw Object.assign(new Error("program not initialized"), { statusCode: 503 });
      return decodeGlobal(new Uint8Array(a.data));
    });
  }

  coin(mint: PublicKey): Promise<CoinAccount | null> {
    return this.cache.get(`chain:coin:${mint.toBase58()}`, 2_000, async () => {
      const a = await this.conn.getAccountInfo(coinPda(mint));
      return a ? decodeCoin(new Uint8Array(a.data)) : null;
    });
  }

  private dbcConfig(config: PublicKey): Promise<DbcPoolConfig> {
    return this.cache.get(`chain:dbccfg:${config.toBase58()}`, 600_000, async () => {
      const a = await this.conn.getAccountInfo(config);
      if (!a) throw new Error("DBC config missing");
      return decodeDbcConfig(new Uint8Array(a.data));
    });
  }

  async tokenBalance(account: PublicKey): Promise<bigint> {
    const a = await this.conn.getAccountInfo(account);
    return a ? decodeTokenAccount(new Uint8Array(a.data)).amount : 0n;
  }

  /**
   * SOL + canonical-ATA token balance + an estimate of the tokens held ≥ the coin's hold time: the balance
   * minus what the wallet acquired (indexed trades on the coin's pools) within the hold window. The keepers'
   * engine (complete history incl. transfers) is authoritative.
   */
  async balances(wallet: string, mint: string): Promise<{ sol: number; tokens: number; maturedTokens: number }> {
    const matured = await this.maturedBase(wallet, mint);
    return { sol: matured.sol, tokens: tok(matured.balance), maturedTokens: tok(matured.matured) };
  }

  async maturedBase(wallet: string, mint: string): Promise<{ sol: number; balance: bigint; matured: bigint }> {
    const w = new PublicKey(wallet);
    const m = new PublicKey(mint);
    const [lamports, bal, coin] = await Promise.all([this.conn.getBalance(w), this.tokenBalance(coinAta(w, m)), this.coin(m)]);
    const hold = coin ? Number(coin.rewards.minHoldSecs) : 600;
    const recent = this.opts.recentAcquired ? await this.opts.recentAcquired(wallet, mint, Math.floor(Date.now() / 1000) - hold) : 0n;
    return { sol: lam(BigInt(lamports)), balance: bal, matured: bal > recent ? bal - recent : 0n };
  }

  /** The wallet's canonical Token-2022 ATA balances per mint (one RPC call, cached a few seconds). */
  async tokenBalances(wallet: string): Promise<Map<string, bigint>> {
    return this.cache.get(`chain:tokacc:${wallet}`, 5_000, async () => {
      const owner = new PublicKey(wallet);
      const r = await this.conn.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed");
      const out = new Map<string, bigint>();
      for (const { pubkey, account } of r.value) {
        const a = decodeTokenAccount(new Uint8Array(account.data));
        if (a.amount === 0n || !a.owner.equals(owner)) continue;
        if (!coinAta(owner, a.mint).equals(pubkey)) continue;
        out.set(a.mint.toBase58(), a.amount);
      }
      return out;
    });
  }

  /**
   * Off-chain quote mirroring Meteora's math. `maturedTokens` (sells): tokens the wallet has held ≥ the
   * hold time per the indexed history (the keepers' engine is authoritative).
   */
  async quote(args: { mint: string; side: Side; amount: number; wallet?: string; symbol?: string; maturedTokens?: bigint }): Promise<TradeQuote> {
    const m = new PublicKey(args.mint);
    const coin = await this.coin(m);
    if (!coin) throw Object.assign(new Error("coin not found"), { statusCode: 404 });
    if (coin.status === "complete") throw Object.assign(new Error("the curve is complete — waiting for the DAMM v2 migration"), { statusCode: 409 });
    const g = await this.global();
    const graduated = coin.status === "graduated";
    const slot = BigInt(await this.cache.get("chain:slot", 400, () => this.conn.getSlot("confirmed")));
    const cfg = await this.dbcConfig(coin.dbcConfig);
    const poolAcc = await this.cache.get(`chain:pool:${args.mint}`, 2_000, () => this.conn.getAccountInfo(graduated ? coin.dammPool : coin.dbcPool));
    if (!poolAcc) throw Object.assign(new Error("pool not found"), { statusCode: 503 });
    const data = new Uint8Array(poolAcc.data);
    const dbc = graduated ? null : decodeDbcPool(data);
    const damm = graduated ? decodeDammPool(data) : null;
    const sqrtBefore = graduated ? damm!.sqrtPrice : dbc!.sqrtPrice;
    const spotBefore = priceQ64FromSqrt(sqrtBefore);
    const amt = Math.max(0, args.amount || 0);
    const split = (q: SwapQuote) => {
      const s = coin.feeSplit;
      const platform = (q.tradingFee * BigInt(s.platformBps)) / BPS_DENOM;
      const creator = (q.tradingFee * BigInt(s.creatorBps)) / BPS_DENOM;
      return { feeSol: lam(q.fee), feePoolSol: lam(q.tradingFee - platform - creator), feePlatformSol: lam(platform), feeCreatorSol: lam(creator), venueFeeSol: lam(q.protocolFee) };
    };
    const snipe = (q: SwapQuote, feeBase: bigint) =>
      !graduated && q.feeNumerator > NORMAL_FEE_NUMERATOR
        ? { snipeTaxSol: lam(q.fee - (feeBase * NORMAL_FEE_NUMERATOR) / 1_000_000_000n), snipeTaxBps: Number(q.feeNumerator / 100_000n) }
        : {};
    const fail = (e: unknown) => Object.assign(new Error(String((e as Error).message ?? e)), { statusCode: 422 });
    const wallet = args.wallet ? new PublicKey(args.wallet) : null;
    const now = BigInt(Math.floor(Date.now() / 1000));

    if (args.side === "buy") {
      const budget = solToLamports(amt);
      let q: SwapQuote;
      try {
        q = graduated ? quoteDammBuy(damm!, budget) : quoteDbcBuy(cfg, dbc!, budget, slot, { partialFill: true });
      } catch (e) {
        throw fail(e);
      }
      const exec = q.amountOut > 0n ? (q.amountInAfterFee << 64n) / q.amountOut : 0n;
      let rebuyWarning: TradeQuote["rebuyWarning"];
      if (wallet && q.amountOut > 0n) {
        const pa = await this.conn.getAccountInfo(positionPda(m, wallet));
        const pos = pa ? decodePosition(new Uint8Array(pa.data)) : null;
        const keys = pos ? pos.openTickets.filter((k) => !k.equals(PublicKey.default)) : [];
        if (keys.length) {
          const infos = await this.conn.getMultipleAccountsInfo(keys);
          const ts = keys.map((k, i) => ({ k, a: infos[i] })).filter((x) => x.a).map((x) => ({ k: x.k, t: decodeTicket(new Uint8Array(x.a!.data)) }));
          const debits = planRebuy(
            ts.map((x) => ({ sellTs: x.t.sellTs, seq: x.t.seq, tokens: x.t.tokens, active: x.t.status === "open" || x.t.status === "queued" })),
            q.amountOut,
            now,
            coin.rewards.rebuyWindowSecs,
          );
          const hits = ts.map((x, i) => ({ ...x, debit: debits[i] })).filter((x) => x.debit > 0n);
          if (hits.length)
            rebuyWarning = {
              tickets: hits.map((h) => ({ id: h.k.toBase58(), symbol: args.symbol ?? "", tokens: tok(h.t.tokens), debit: tok(h.debit), soldAgo: Number(now - h.t.sellTs) * 1000 })),
              totalDebit: tok(hits.reduce((a, h) => a + h.debit, 0n)),
            };
        }
      }
      return {
        side: "buy",
        amountIn: amt,
        amountOut: tok(q.amountOut),
        ...split(q),
        spotBefore: px(spotBefore),
        execPrice: px(exec),
        priceImpact: spotBefore > 0n ? Math.max(0, (Number(exec) / Number(spotBefore) - 1) * 100) : 0,
        venue: graduated ? "damm" : "dbc",
        partialFill: q.partialFill || undefined,
        usedSol: q.partialFill ? lam(q.amountIn) : undefined,
        rebuyWarning,
        ...snipe(q, q.amountIn),
      };
    }

    const tokensIn = tokensToBase(amt);
    let q: SwapQuote;
    try {
      q = graduated ? quoteDammSell(damm!, tokensIn) : quoteDbcSell(cfg, dbc!, tokensIn, slot);
    } catch (e) {
      throw fail(e);
    }
    const gross = q.amountOut + q.fee;
    const exec = tokensIn > 0n ? (gross << 64n) / tokensIn : 0n;
    const usd = await this.solUsd();
    let openTickets = 0;
    if (wallet) {
      const pa = await this.conn.getAccountInfo(positionPda(m, wallet));
      openTickets = pa ? decodePosition(new Uint8Array(pa.data)).openCount : 0;
    }
    const matured = args.maturedTokens ?? tokensIn;
    const ticketTokens = matured < tokensIn ? matured : tokensIn;
    const ticketLamports = tokensIn > 0n ? (gross * ticketTokens) / tokensIn : 0n;
    const usdValue = lamportsToSol(ticketLamports) * usd;
    const isCreator = !!wallet && wallet.equals(coin.creator);
    const reason: NonNullable<TradeQuote["ticket"]>["reason"] = isCreator
      ? "creator"
      : ticketTokens === 0n
        ? "not-matured"
        : openTickets >= coin.rewards.maxOpenTickets
          ? "max-open"
          : usdValue * 100 < Number(coin.rewards.minSellUsdCents)
            ? "under-min"
            : undefined;
    void g;
    return {
      side: "sell",
      amountIn: amt,
      amountOut: lam(q.amountOut),
      ...split(q),
      spotBefore: px(spotBefore),
      execPrice: px(exec),
      priceImpact: spotBefore > 0n ? Math.max(0, (1 - Number(exec) / Number(spotBefore)) * 100) : 0,
      venue: graduated ? "damm" : "dbc",
      ...snipe(q, gross),
      ticket: {
        files: !reason && amt > 0,
        reason,
        usdValue,
        tokens: tok(ticketTokens),
        execPrice: px(exec),
        floorPrice: px(exec),
        ticketPrice: px(exec),
        floorApplied: false,
        triggerPrice: px((exec * BigInt(coin.rewards.triggerMultipleBps)) / BPS_DENOM),
        claimTokens: tok((ticketTokens * BigInt(coin.rewards.claimBps)) / BPS_DENOM),
        openTickets,
        maxOpenTickets: coin.rewards.maxOpenTickets,
      },
    };
  }
}
