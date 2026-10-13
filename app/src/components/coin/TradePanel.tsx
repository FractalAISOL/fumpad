"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFumpadTx } from "@/chain/tx";
import { keepSnapshot, type CoinDetail, type Side, type Ticket, type TradeQuote, getFumpadData } from "@/data";
import { AmountInput, Button, InfoTip, KV, Multiple, Price, Segmented, Sol, Tokens, cx, parseAmount, useToast } from "@/design";
import * as f from "@/design/format";
import { useRefresh } from "../shell/live";
import { useNow, useProtocolParams, useViewer } from "../shell/Providers";
import s from "./Coin.module.css";
import { minOutFromQuote } from "@/chain/build";

/** Solana's target slot time. */
const SLOT_SECS = 0.4;

/**
 * Seconds until the launch-window fee is gone, from the quoted rate. The DBC scheduler is linear,
 * start − d·(start − end)/W at slot offset d, so W − d slots remain.
 */
function snipeWaitSecs(bps: number, p: { snipeWindowSlots: number; snipeStartBps: number; feeBps: number }): number {
  const w = p.snipeWindowSlots > 0 ? p.snipeWindowSlots : 8;
  const span = Math.max(1, p.snipeStartBps - p.feeBps);
  const d = Math.max(0, Math.floor(((p.snipeStartBps - bps) * w) / span));
  return Math.max(1, Math.round((w - d) * SLOT_SECS));
}

/**
 * Apps that also trade FUMPAD coins (they trade Meteora DBC and DAMM v2 pools). Named so people
 * know a sell there counts too; not partners, and FUMPAD doesn't vouch for them.
 */
const ELSEWHERE = ["Axiom", "Jupiter", "GMGN", "Photon", "OKX"];

/**
 * Buy/sell with a live ticket preview. The preview explains the ticket price in one
 * sentence: your fill, unless FUMPAD's recent-average floor is higher (D10/D12).
 */
export function TradePanel({ coin, myTicket }: { coin: CoinDetail; myTicket?: Ticket }) {
  const data = getFumpadData();
  const { address, isDemo } = useViewer();
  const toast = useToast();
  const tx = useFumpadTx();
  const now = useNow();
  const [side, setSide] = useState<Side>("sell");
  const [raw, setRaw] = useState("2,000,000");
  const params = useProtocolParams();
  type Bal = { sol: number; tokens: number; maturedTokens: number };
  const [bal, setBal] = useState<Bal | null>(null);
  /** Balances after the viewer's confirmed trade, shown until the API reports the new ones. */
  const [optimistic, setOptimistic] = useState<{ bal: Bal; before: Bal; until: number } | null>(null);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const amount = parseAmount(raw);
  const balReq = useRef(0);

  // Balances: on mount, after own transactions (with follow-ups while the RPC catches up),
  // when a transaction touches this wallet, and every 15 s (held tokens mature with time).
  const loadBal = useCallback(() => {
    const id = ++balReq.current;
    data
      .getBalances(address, coin.mint)
      .then((b) => {
        if (id !== balReq.current) return;
        setBal(b);
        setOptimistic((o) => (o && (Date.now() > o.until || b.sol !== o.before.sol || b.tokens !== o.before.tokens) ? null : o));
      })
      .catch(keepSnapshot);
  }, [data, address, coin.mint]);
  useRefresh(loadBal, { wallets: [address], mints: [], pollMs: 15_000, debounceMs: 300 });
  const [balFor, setBalFor] = useState(address + coin.mint);
  if (balFor !== address + coin.mint) {
    setBalFor(address + coin.mint);
    setBal(null);
    setOptimistic(null);
  }

  // The quote follows the coin: price moves arrive with the pushed coin (reserves change).
  const quoteKey = `${coin.price}:${coin.status}:${coin.curveSol}:${coin.ammSol ?? ""}`;
  const balKey = bal ? `${bal.tokens}:${bal.maturedTokens}` : "";
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      data.quoteTrade({ mint: coin.mint, side, amount, wallet: address }).then((q) => live && setQuote(q)).catch(keepSnapshot);
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [data, coin.mint, side, amount, address, quoteKey, balKey]);

  const shown = optimistic?.bal ?? bal;
  const balance = shown ? (side === "buy" ? shown.sol : shown.tokens) : undefined;
  const over = balance !== undefined && amount > balance;
  const t = quote?.ticket;
  const files = side === "sell" && t?.files;
  // D33: a trade in the launch window pays the DBC scheduler's fee (quoted at the current slot), buys and sells alike.
  const snipe = quote?.snipeTaxSol && quote.snipeTaxBps ? { sol: quote.snipeTaxSol, pct: quote.snipeTaxBps / 100 } : null;
  const snipeWait = snipe ? snipeWaitSecs(quote!.snipeTaxBps!, params) : 0;
  const feePct = snipe ? snipe.pct : params.feeBps / 100;
  const completes = side === "buy" && !!quote?.partialFill;

  const submit = async () => {
    if (!quote || amount <= 0 || over) return;
    // M-9: the slippage bound comes from the quote on screen, so it must be the quote for this amount and side.
    if (quote.side !== side || quote.amountIn !== amount) {
      toast("The price is updating. Check the quote and try again.");
      return;
    }
    const before = bal;
    const minOut = minOutFromQuote(quote.amountOut);
    const res =
      side === "buy"
        ? await tx.buy({ mint: coin.mint, solIn: amount, minTokensOut: minOut, expectedOut: quote.amountOut })
        : await tx.sell({ mint: coin.mint, tokensIn: amount, minSolOut: minOut, expectedOut: quote.amountOut });
    if (!res) {
      toast(tx.lastError() ?? "The transaction didn't go through.");
      return;
    }
    if (before) {
      const next =
        side === "buy"
          ? { sol: Math.max(0, before.sol - amount), tokens: before.tokens + quote.amountOut, maturedTokens: before.maturedTokens }
          : { sol: before.sol + quote.amountOut, tokens: Math.max(0, before.tokens - amount), maturedTokens: Math.max(0, before.maturedTokens - amount) };
      setOptimistic({ bal: next, before, until: Date.now() + 20_000 });
    }
    if (side === "buy") toast(completes ? `Bought ${f.tokens(quote.amountOut)} ${coin.symbol}. That completed the curve.` : `Bought ${f.tokens(quote.amountOut)} ${coin.symbol}.`);
    else toast(files ? `Sold. Your $${coin.symbol} ticket is being verified; it shows in My fumbles.` : `Sold ${f.tokens(amount)} ${coin.symbol}.`, files ? "money" : "ink");
    tx.reset();
  };

  const hold = f.duration(params.minHoldSecs);
  const median = `${f.durationShort(params.oracleWindowSecs)} median`;
  const rebuyWindow = f.duration(params.rebuyWindowSecs);
  const label = side === "buy" ? (completes ? "Buy and complete the curve" : `Buy $${coin.symbol}`) : files ? "Sell and file a ticket" : `Sell $${coin.symbol}`;
  const busy = tx.status === "building" || tx.status === "signing" || tx.status === "confirming";

  return (
    <section className={cx(s.trade)} aria-labelledby="trade-h">
      <h2 id="trade-h" className="sr-only">
        Trade ${coin.symbol}
      </h2>

      {myTicket && (
        <Link href="/fumbles" className={cx(s.mine, myTicket.multiple >= 10 && s.mineHit)}>
          <span>
            Your ticket, sold {f.date(myTicket.sellTs)}
            <small>
              {myTicket.state === "verifying"
                ? "Verifying the sell"
                : myTicket.state === "challenge" && myTicket.claimableFrom
                  ? `Claimable from ${f.dateTime(myTicket.claimableFrom)}`
                  : myTicket.state === "claimable"
                ? "Claimable now"
                : myTicket.state === "queued"
                  ? `Queued, #${myTicket.queuePosition}`
                  : myTicket.state === "awaiting-graduation"
                    ? "Claims open at graduation"
                    : myTicket.expiresAt
                      ? `${f.daysLeft(myTicket.expiresAt, now)} days left`
                      : ""}
            </small>
          </span>
          <Multiple x={myTicket.multiple} size="lg" />
        </Link>
      )}

      <Segmented
        block
        label="Side"
        value={side}
        onChange={(v) => {
          setSide(v);
          setRaw(v === "sell" ? "2,000,000" : "5");
        }}
        items={[
          { value: "buy", label: "Buy" },
          { value: "sell", label: "Sell" },
        ]}
      />

      <div className={s.amount}>
        <AmountInput
          label={side === "buy" ? "You pay" : "You sell"}
          value={raw}
          onChange={setRaw}
          unit={side === "buy" ? "SOL" : coin.symbol}
          balance={balance}
          decimals={side === "buy" ? 2 : 0}
        />
      </div>

      {quote && (
        <KV
          className={s.quote}
          rows={[
            { k: "You receive", v: side === "buy" ? <Tokens value={quote.amountOut} symbol={coin.symbol} /> : <Sol value={quote.amountOut} /> },
            ...(completes && quote.usedSol !== undefined ? [{ k: "You pay, curve's last tokens", v: <Sol value={quote.usedSol} /> }] : []),
            { k: snipe ? `Fee, ${f.fixed(feePct, 1)}%, launch window` : `Fee, ${f.fixed(feePct, 2)}%`, v: <Sol value={quote.feeSol} /> },
            // D33: in the launch window FUMPAD's whole share of the fee goes to the pool.
            { k: `Of which buys ${coin.symbol} for the pool`, v: <Sol value={snipe ? quote.feePoolSol + quote.feePlatformSol + quote.feeCreatorSol : quote.feePoolSol} /> },
            { k: "Price impact", v: <span className="num">{f.fixed(Math.abs(quote.priceImpact), 2)}%</span> },
          ]}
        />
      )}

      {side === "sell" && t && amount > 0 && (
        <div className={cx(s.preview, t.files && s.previewOn)} aria-live="polite">
          {t.files ? (
            <>
              <p className={s.pvLead}>
                This sell counts: it files a <b>fumble ticket</b>.
              </p>
              <dl className={s.pvRows}>
                <div>
                  <dt>
                    Ticket price{" "}
                    <InfoTip label="How the ticket price is set">
                      FUMPAD prices your ticket at the higher of your fill and a 10-minute average of the price, scaled by your own slippage. Honest sells get
                      their real fill; a crash staged in the same block can&apos;t make a sell look cheaper than it was.
                    </InfoTip>
                  </dt>
                  <dd>
                    <Price value={t.ticketPrice} unit />
                  </dd>
                </div>
                <div>
                  <dt>10× unlocks at</dt>
                  <dd>
                    <Price value={t.triggerPrice} unit />
                  </dd>
                </div>
                <div>
                  <dt>Claim, 10% of sold</dt>
                  <dd>
                    <Tokens value={t.claimTokens} symbol={coin.symbol} />
                  </dd>
                </div>
              </dl>
              <p className={s.pvNote}>
                {t.floorApplied ? (
                  <>
                    Your fill is <Price value={t.execPrice} />. The price dropped in the last 10 minutes, so the ticket uses the recent-average floor instead.
                    It errs higher, never lower.
                  </>
                ) : (
                  <>Priced at your fill. The recent-average floor is below it, so it doesn&apos;t apply.</>
                )}{" "}
                {coin.status === "graduated"
                  ? `Claimable when the ${median} holds 10× within ${f.duration(params.claimWindowSecs)}.`
                  : `Counts toward 10× now; claims on $${coin.symbol} open when it graduates.`}{" "}
                {t.tokens < amount && (
                  <>
                    Only {f.tokens(t.tokens)} of these tokens have been held {hold}; the ticket counts those.{" "}
                  </>
                )}
                You&apos;ll have {t.openTickets + 1} of {t.maxOpenTickets} open tickets on this coin. FUMPAD&apos;s keepers verify the sell in about{" "}
                {f.duration(params.attestDelaySecs)}; claims open after a {f.duration(params.ticketChallengeSecs)} challenge window.
              </p>
            </>
          ) : (
            <p className={s.pvNote}>
              {t.reason === "under-min" && (
                <>
                  Sells under {f.usdRule(params.minSellUsd)} go through but don&apos;t file a ticket. This one is about <span className="num">{f.usd(t.usdValue)}</span>.
                </>
              )}
              {t.reason === "creator" && <>Creators can&apos;t file tickets on their own coin. The sell goes through without one.</>}
              {t.reason === "max-open" && (
                <>You already have {t.maxOpenTickets} open tickets on this coin, the most allowed. This sell goes through without one.</>
              )}
              {t.reason === "not-matured" && <>Tokens need {hold} in your wallet before a sell counts. This sell goes through without a ticket.</>}
              {t.reason === "no-oracle" && <>The SOL/USD price feed is stale right now, so this sell can&apos;t be valued. It goes through without a ticket.</>}
            </p>
          )}
        </div>
      )}

      {snipe && amount > 0 && (
        <p className={s.snipe} role="status">
          <b>Snipe protection:</b> this {side} pays a <span className={cx("num", s.snipePct)}>{f.fixed(snipe.pct, 0)}%</span> fee — wait ~{snipeWait} s.
          <small>
            Trades in the first {f.int(params.snipeWindowSlots)} slots after launch pay up to {f.fixed(params.snipeStartBps / 100, 0)}%, falling to{" "}
            {f.fixed(params.feeBps / 100, 2)}% in about {f.fixed(Math.max(1, params.snipeWindowSlots) * SLOT_SECS, 1)} s. FUMPAD&apos;s share goes to $
            {coin.symbol}&apos;s reward pool.
          </small>
        </p>
      )}

      {side === "buy" && quote && amount > 0 && (
        <div className={s.preview} aria-live="polite">
          {quote.rebuyWarning && quote.rebuyWarning.totalDebit > 0 ? (
            <p className={s.pvNote}>
              <b>Heads up.</b> You sold ${coin.symbol} {f.ago(now - quote.rebuyWarning.tickets[0].soldAgo, now)} ago. Buying back within {rebuyWindow} shrinks that
              ticket by what you buy: −<span className="num">{f.tokens(quote.rebuyWarning.totalDebit)}</span> tokens.
            </p>
          ) : (
            <p className={s.pvNote}>
              No ${coin.symbol} sells of yours in the last {rebuyWindow}, so buying doesn&apos;t shrink any ticket. Tokens you buy count toward future
              tickets after {hold}.
            </p>
          )}
          {completes && (
            <p className={s.pvNote}>
              <b>This buy completes the curve.</b> Only the last {f.tokens(quote.amountOut)} tokens are left, so you pay{" "}
              {quote.usedSol !== undefined ? <span className="num">{f.sol(quote.usedSol)} SOL</span> : "less"} and keep the rest. Then ${coin.symbol} graduates to a
              Meteora pool and claims can open.
            </p>
          )}
        </div>
      )}

      <Button block size="lg" onClick={submit} disabled={amount <= 0 || over} loading={busy} className={s.go}>
        {label}
      </Button>
      <p className={s.txStatus} role="status" aria-live="polite">
        {tx.status === "building"
          ? "Preparing the transaction…"
          : tx.status === "signing"
            ? tx.instant
              ? "Signing with your Trading wallet…"
              : "Approve it in your wallet."
            : tx.status === "confirming"
              ? "Confirming on Solana…"
              : optimistic
                ? "Confirmed. Updating your balance…"
                : ""}
      </p>
      {isDemo && <p className={s.demo}>Demo wallet. Trades are simulated until you log in.</p>}
      <p className={s.elsewhere}>
        Also trades on {ELSEWHERE.join(" · ")} and any app that routes Meteora. Every sell over {f.usdRule(params.minSellUsd)} counts, wherever you sell.{" "}
        <InfoTip label="About other apps">
          ${coin.symbol} trades on Meteora pools, so any Solana app can trade it. Those apps aren&apos;t affiliated with FUMPAD and FUMPAD doesn&apos;t vouch
          for them; their own fees apply on top.
        </InfoTip>
      </p>
    </section>
  );
}
