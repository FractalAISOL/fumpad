/**
 * Chain-backed endpoints: quotes, balances, SOL/USD. Quotes read the live Coin / pool /
 * Position accounts (RPC, cached ~2 s) so they match what the program will compute
 * (curve: exact; PumpSwap: CP approximation), including the D10/D12 ticket preview.
 */
import { type Connection, PublicKey } from "@solana/web3.js";

import {
  coinAta,
  decodePythPriceUpdate,
  decodeTicket,
  FumpadClient,
  maturedNow,
  previewRebuy,
  previewTicket,
  PYTH_SOL_USD_ACCOUNT,
  q64ToSolPerToken,
  quoteCurveBuy,
  quoteCurveSell,
  quoteSwapBuy,
  quoteSwapSell,
  reservesOf,
  solToLamports,
  tokensToBase,
  type CoinAccount,
} from "@fumpad/sdk";

import type { TtlCache } from "./cache.js";
import type { Side, TradeQuote } from "./generated/app-types.js";

const tok = (v: bigint) => Number(v) / 1e6;
const lam = (v: bigint) => Number(v) / 1e9;
const px = (q: bigint) => q64ToSolPerToken(q);

export class ChainReader {
  readonly client: FumpadClient;
  constructor(readonly conn: Connection, private cache: TtlCache, private opts: { solUsdFallback: number; pythAccount?: string }) {
    this.client = new FumpadClient(conn, { solUsdAccount: opts.pythAccount ? new PublicKey(opts.pythAccount) : PYTH_SOL_USD_ACCOUNT });
  }

  async solUsd(): Promise<number> {
    return this.cache.get("chain:solusd", 10_000, async () => {
      try {
        const a = await this.conn.getAccountInfo(this.client.solUsdAccount);
        if (a) {
          const p = decodePythPriceUpdate(new Uint8Array(a.data));
          const v = Number(p.price) * 10 ** p.exponent;
          if (v > 0) return v;
        }
      } catch {
        /* fall back */
      }
      return this.opts.solUsdFallback;
    });
  }

  private coin(mint: PublicKey): Promise<CoinAccount | null> {
    return this.cache.get(`chain:coin:${mint.toBase58()}`, 2_000, () => this.client.coin(mint));
  }

  async balances(wallet: string, mint: string): Promise<{ sol: number; tokens: number; maturedTokens: number }> {
    const w = new PublicKey(wallet);
    const m = new PublicKey(mint);
    const [lamports, bal, pos, g, now] = await Promise.all([
      this.conn.getBalance(w),
      this.client.tokenBalance(coinAta(w, m)),
      this.client.position(m, w),
      this.client.global(),
      this.client.chainTime(),
    ]);
    const matured = pos ? maturedNow(pos, bal, now, g.params.minHoldSecs) : 0n;
    return { sol: lam(BigInt(lamports)), tokens: tok(bal), maturedTokens: tok(matured) };
  }

  async quote(args: { mint: string; side: Side; amount: number; wallet?: string; symbol?: string }): Promise<TradeQuote> {
    const m = new PublicKey(args.mint);
    const coin = await this.coin(m);
    if (!coin) throw Object.assign(new Error("coin not found"), { statusCode: 404 });
    if (coin.status === "complete") throw Object.assign(new Error("coin is complete — waiting for graduation"), { statusCode: 409 });
    const g = await this.client.global();
    const fees = coin.fees;
    const onCurve = coin.status === "curve";
    const pool = onCurve ? null : await this.cache.get(`chain:pool:${args.mint}`, 2_000, () => this.client.poolReserves(m));
    const venueFeeBps = onCurve ? 0n : await this.cache.get("chain:venuefee", 60_000, () => this.client.pumpswapFeeBps());
    const amt = Math.max(0, args.amount || 0);
    const split = (f: { total: bigint; pool: bigint; platform: bigint; creator: bigint }) => ({
      feeSol: lam(f.total),
      feePoolSol: lam(f.pool),
      feePlatformSol: lam(f.platform),
      feeCreatorSol: lam(f.creator),
    });
    const wallet = args.wallet ? new PublicKey(args.wallet) : null;
    const [pos, now] = await Promise.all([wallet ? this.client.position(m, wallet) : null, this.client.chainTime()]);

    if (args.side === "buy") {
      const budget = solToLamports(amt);
      const q = onCurve ? quoteCurveBuy(reservesOf(coin), fees, budget) : quoteSwapBuy(pool!, fees, budget, venueFeeBps);
      if (!q) throw Object.assign(new Error("quote unavailable"), { statusCode: 422 });
      let rebuyWarning: TradeQuote["rebuyWarning"];
      if (wallet && pos && pos.openTickets.length && q.tokensOut > 0n) {
        const infos = await this.conn.getMultipleAccountsInfo(pos.openTickets);
        const ts = pos.openTickets
          .map((k, i) => ({ k, a: infos[i] }))
          .filter((x) => x.a)
          .map((x) => ({ k: x.k, t: decodeTicket(new Uint8Array(x.a!.data)) }));
        const hits = previewRebuy(ts.map((x) => ({ id: x.k.toBase58(), sellTs: x.t.sellTs, seq: x.t.seq, tokens: x.t.tokens, status: x.t.status })), q.tokensOut, now, g.params.rebuyWindowSecs);
        if (hits.length) {
          rebuyWarning = {
            tickets: hits.map((h) => {
              const t = ts.find((x) => x.k.toBase58() === h.id)!.t;
              return { id: h.id, symbol: args.symbol ?? "", tokens: tok(t.tokens), debit: tok(h.debit), soldAgo: Number(now - t.sellTs) * 1000 };
            }),
            totalDebit: tok(hits.reduce((a, h) => a + h.debit, 0n)),
          };
        }
      }
      return {
        side: "buy",
        amountIn: amt,
        amountOut: tok(q.tokensOut),
        ...split(q.fee),
        venueFeeSol: lam(q.venueFee),
        spotBefore: px(q.spotBeforeQ64),
        execPrice: px(q.execPriceQ64),
        priceImpact: q.priceImpactBps / 100,
        venue: q.venue,
        partialFill: q.partialFill || undefined,
        rebuyWarning,
      };
    }

    const tokensIn = tokensToBase(amt);
    const q = onCurve ? quoteCurveSell(reservesOf(coin), fees, tokensIn) : quoteSwapSell(pool!, fees, tokensIn, venueFeeBps);
    if (!q) throw Object.assign(new Error("the curve cannot pay this sell"), { statusCode: 422 });
    const balance = wallet ? await this.client.tokenBalance(coinAta(wallet, m)) : tokensIn;
    const solUsd = await this.client.solUsd().catch(() => null);
    const t = previewTicket({ coin, params: g.params, position: pos, wallet: wallet?.toBase58() ?? "", balanceBefore: balance, quote: q, now, solUsd });
    const reason = t.reason === "zero-price" ? "under-min" : t.reason;
    return {
      side: "sell",
      amountIn: amt,
      amountOut: lam(q.net),
      ...split(q.fee),
      venueFeeSol: lam(q.venueFee),
      spotBefore: px(q.spotBeforeQ64),
      execPrice: px(q.execPriceQ64),
      priceImpact: q.priceImpactBps / 100,
      venue: q.venue,
      ticket: {
        files: t.files && amt > 0,
        reason: reason as NonNullable<TradeQuote["ticket"]>["reason"],
        usdValue: t.usdCents !== null ? Number(t.usdCents) / 100 : 0,
        tokens: tok(t.tokens),
        execPrice: px(t.execPriceQ64),
        floorPrice: px(t.floorPriceQ64),
        ticketPrice: px(t.ticketPriceQ64),
        floorApplied: t.ticketPriceQ64 > t.execPriceQ64,
        triggerPrice: px(t.triggerPriceQ64),
        claimTokens: tok(t.claimTokens),
        openTickets: t.openTickets,
        maxOpenTickets: g.params.maxOpenTickets,
      },
    };
  }
}

