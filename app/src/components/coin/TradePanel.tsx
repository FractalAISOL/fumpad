"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useFumpadTx } from "@/chain/tx";
import { type CoinDetail, type Side, type Ticket, type TradeQuote, getFumpadData } from "@/data";
import { AmountInput, Button, InfoTip, KV, Multiple, Price, Segmented, Sol, Tokens, cx, parseAmount, useToast } from "@/design";
import * as f from "@/design/format";
import { useNow, useViewer } from "../shell/Providers";
import s from "./Coin.module.css";

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
  const [bal, setBal] = useState<{ sol: number; tokens: number; maturedTokens: number } | null>(null);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const amount = parseAmount(raw);

  useEffect(() => {
    let live = true;
    data.getBalances(address, coin.mint).then((b) => live && setBal(b));
    return () => {
      live = false;
    };
  }, [data, address, coin.mint]);

  useEffect(() => {
    let live = true;
    data.quoteTrade({ mint: coin.mint, side, amount, wallet: address }).then((q) => live && setQuote(q));
    return () => {
      live = false;
    };
  }, [data, coin.mint, side, amount, address]);

  const balance = bal ? (side === "buy" ? bal.sol : bal.tokens) : undefined;
  const over = balance !== undefined && amount > balance;
  const t = quote?.ticket;
  const files = side === "sell" && t?.files;

  const submit = async () => {
    if (!quote || amount <= 0 || over) return;
    const res =
      side === "buy"
        ? await tx.buy({ mint: coin.mint, solIn: amount, minTokensOut: quote.amountOut * 0.98, openTickets: [] })
        : await tx.sell({ mint: coin.mint, tokensIn: amount, minSolOut: quote.amountOut * 0.98 });
    if (!res) {
      toast(tx.error ?? "The transaction didn't go through.");
      return;
    }
    if (side === "buy") toast(`Bought ${f.tokens(quote.amountOut)} ${coin.symbol}.`);
    else toast(files ? `Sold. Ticket filed for $${coin.symbol}, claimable at 10×.` : `Sold ${f.tokens(amount)} ${coin.symbol}.`, files ? "money" : "ink");
    tx.reset();
  };

  const label = side === "buy" ? `Buy $${coin.symbol}` : files ? "Sell and file a ticket" : `Sell $${coin.symbol}`;
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
              {myTicket.state === "claimable"
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
            { k: "Fee, 1%", v: <Sol value={quote.feeSol} /> },
            { k: `Of which buys ${coin.symbol} for the pool`, v: <Sol value={quote.feePoolSol} /> },
            ...(quote.venueFeeSol > 0 ? [{ k: "PumpSwap fee, 0.25%", v: <Sol value={quote.venueFeeSol} /> }] : []),
            { k: "Price impact", v: <span className="num">{f.fixed(Math.abs(quote.priceImpact), 2)}%</span> },
          ]}
        />
      )}

      {side === "sell" && t && amount > 0 && (
        <div className={cx(s.preview, t.files && s.previewOn)} aria-live="polite">
          {t.files ? (
            <>
              <p className={s.pvLead}>
                This sell files a <b>fumble ticket</b>.
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
                  ? "Claimable when the 30-min median holds 10× within 90 days."
                  : `Counts toward 10× now; claims on $${coin.symbol} open when it graduates.`}{" "}
                {t.tokens < amount && <>Only {f.tokens(t.tokens)} of these tokens have been held 10 minutes; the ticket counts those. </>}
                You&apos;ll have {t.openTickets + 1} of {t.maxOpenTickets} open tickets on this coin.
              </p>
            </>
          ) : (
            <p className={s.pvNote}>
              {t.reason === "under-min" && (
                <>
                  Sells under $50 go through but don&apos;t file a ticket. This one is about <span className="num">{f.usd(t.usdValue)}</span>.
                </>
              )}
              {t.reason === "creator" && <>Creators can&apos;t file tickets on their own coin. The sell goes through without one.</>}
              {t.reason === "max-open" && <>You already have 5 open tickets on this coin, the most allowed. This sell goes through without one.</>}
              {t.reason === "not-matured" && <>Tokens need 10 minutes in your wallet before a sell counts. This sell goes through without a ticket.</>}
              {t.reason === "no-oracle" && <>The SOL/USD price feed is stale right now, so this sell can&apos;t be valued. It goes through without a ticket.</>}
            </p>
          )}
        </div>
      )}

      {side === "buy" && quote && amount > 0 && (
        <div className={s.preview} aria-live="polite">
          {quote.rebuyWarning && quote.rebuyWarning.totalDebit > 0 ? (
            <p className={s.pvNote}>
              <b>Heads up.</b> You sold ${coin.symbol} {f.ago(now - quote.rebuyWarning.tickets[0].soldAgo, now)} ago. Buying back within 7 days shrinks that
              ticket by what you buy: −<span className="num">{f.tokens(quote.rebuyWarning.totalDebit)}</span> tokens.
            </p>
          ) : (
            <p className={s.pvNote}>
              No ${coin.symbol} sells of yours in the last 7 days, so buying doesn&apos;t shrink any ticket. Tokens you buy count toward future tickets after 10
              minutes.
            </p>
          )}
          {quote.partialFill && <p className={s.pvNote}>This buy completes the curve. You&apos;re charged only for the tokens left.</p>}
        </div>
      )}

      <Button block size="lg" onClick={submit} disabled={amount <= 0 || over} loading={busy} className={s.go}>
        {label}
      </Button>
      {isDemo && <p className={s.demo}>Demo wallet. Trades are simulated until you connect.</p>}
    </section>
  );
}
