"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { CoinSummary, FumbleSell, ProtocolParams, WalletCoinFumbles, WalletFumbles } from "@/data";
import { getFumpadData } from "@/data";
import { Badge, Button, CoinTile, CopyButton, EmptyState, IconExternal, IconSearch, Loading, Skeleton, TextInput, Tokens, cx } from "@/design";
import * as f from "@/design/format";
import { useClock } from "./hooks";
import { checkLabel, checkName, feeNote, steps, parseWalletInput, reasonText, solscan, targetProgress, ticketStatus } from "./model";
import s from "./Checker.module.css";

type Status = { kind: "idle" } | { kind: "loading"; wallet: string } | { kind: "done"; wallet: string; data: WalletFumbles } | { kind: "error"; wallet: string; message: string };

/**
 * "Did you fumble?": paste any wallet (no connect, no login, nothing to sign) → its sells, each with the three ticket
 * conditions, the ticket's state on its path (verifying → 6-hour check → open → claimable → paid) and the claim
 * target as a market cap. `mint` limits it to one coin (the launch window); without it, every coin the wallet sold.
 * The address lives in `?wallet=` so a result is a link.
 */
export function FumbleCheck({
  mint,
  params,
  solUsd,
  clusterQuery,
  liveCoin,
  coinLinks = false,
  serverNow,
  headingId,
}: {
  mint?: string;
  params: ProtocolParams;
  solUsd: number;
  clusterQuery: string;
  /** The page's live coin (launch window): its market cap drives the progress bars. */
  liveCoin?: CoinSummary | null;
  /** Link coin names to their app page (full app only; the launch-window page has no other routes). */
  coinLinks?: boolean;
  serverNow: number;
  headingId?: string;
}) {
  const data = getFumpadData();
  const search = useSearchParams();
  const fromUrl = search.get("wallet") ?? "";
  const [value, setValue] = useState(fromUrl);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const now = useClock(1_000, serverNow);
  const reqId = useRef(0);
  const resultsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    (wallet: string, quiet = false) => {
      const id = ++reqId.current;
      if (!quiet) setStatus({ kind: "loading", wallet });
      data
        .getWalletFumbles(wallet, mint)
        .then((d) => id === reqId.current && setStatus({ kind: "done", wallet, data: d }))
        .catch((e: unknown) => {
          if (id !== reqId.current || quiet) return;
          const st = (e as { status?: number }).status;
          setStatus({
            kind: "error",
            wallet,
            message:
              st === 429
                ? "Too many lookups from your network. Wait a minute and try again."
                : st === 400
                  ? "That address was refused. Check it and try again."
                  : "Couldn’t reach FUMPAD’s indexer. Try again in a moment.",
          });
        });
    },
    [data, mint],
  );

  // The URL is the source of truth: a shared ?wallet= link checks on load; back/forward re-checks.
  useEffect(() => {
    const p = parseWalletInput(fromUrl);
    if (p.ok) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror the URL into the field
      setValue(p.address);
      load(p.address);
    } else if (!fromUrl) setStatus({ kind: "idle" });
  }, [fromUrl, load]);

  // Live: refetch when an indexed transaction touches this wallet (or the coin), and every 30 s while anything is
  // still moving (verifying, in its 6-hour check, open).
  const wallet = status.kind === "done" ? status.wallet : null;
  useEffect(() => {
    if (!wallet) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      clearTimeout(t);
      t = setTimeout(() => load(wallet, true), 900);
    };
    const unsub = data.subscribeLive((m) => {
      if (m.type === "resync") again();
      else if (m.type === "coins" && (m.wallets?.includes(wallet) || (mint && m.mints.includes(mint)))) again();
    });
    const poll = setInterval(() => load(wallet, true), 30_000);
    return () => {
      unsub();
      clearInterval(poll);
      clearTimeout(t);
    };
  }, [wallet, data, load, mint]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = parseWalletInput(value);
    if (!p.ok) {
      setError(p.error ?? "Paste a wallet address first.");
      return;
    }
    setError(null);
    setValue(p.address);
    const url = new URL(window.location.href);
    url.searchParams.set("wallet", p.address);
    // Shallow: Next's router picks up the native history update (useSearchParams), no server round-trip.
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
    if (p.address === fromUrl) load(p.address);
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const clear = () => {
    setValue("");
    setError(null);
    reqId.current++;
    setStatus({ kind: "idle" });
    const url = new URL(window.location.href);
    url.searchParams.delete("wallet");
    window.history.pushState(null, "", url.pathname + url.search + url.hash);
  };

  return (
    <div className={s.checker}>
      <form className={s.form} onSubmit={submit} role="search" aria-labelledby={headingId}>
        <TextInput
          label="Wallet address"
          name="wallet"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Paste any Solana wallet address"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="text"
          maxLength={200}
          error={error ?? undefined}
          hint="Read-only. Nothing to connect, nothing to sign: just paste an address."
          className={s.field}
        />
        <div className={s.formActions}>
          <Button type="submit" size="lg" icon={<IconSearch width={16} height={16} />} loading={status.kind === "loading"}>
            Check
          </Button>
          {status.kind !== "idle" && (
            <Button variant="ghost" size="lg" onClick={clear}>
              Clear
            </Button>
          )}
        </div>
      </form>

      <div ref={resultsRef} className={s.results} aria-live="polite" aria-busy={status.kind === "loading"}>
        {status.kind === "loading" && (
          <Loading label="Checking the wallet">
            <div className={s.sellSkel}>
              <Skeleton h={18} w="40%" />
              <Skeleton h={14} />
              <Skeleton h={14} w="70%" />
              <Skeleton h={56} />
            </div>
          </Loading>
        )}
        {status.kind === "error" && (
          <EmptyState title="Couldn’t check that wallet" compact action={<Button variant="line" onClick={() => load(status.wallet)}>Try again</Button>}>
            {status.message}
          </EmptyState>
        )}
        {status.kind === "done" && (
          <Results
            res={status.data}
            mint={mint}
            params={params}
            solUsd={solUsd}
            now={now}
            clusterQuery={clusterQuery}
            liveCoin={liveCoin ?? null}
            coinLinks={coinLinks}
          />
        )}
      </div>
    </div>
  );
}

function Results({
  res,
  mint,
  params,
  solUsd,
  now,
  clusterQuery,
  liveCoin,
  coinLinks,
}: {
  res: WalletFumbles;
  mint?: string;
  params: ProtocolParams;
  solUsd: number;
  now: number;
  clusterQuery: string;
  liveCoin: CoinSummary | null;
  coinLinks: boolean;
}) {
  const coins = res.coins.filter((c) => c.sells.length > 0);
  const sells = coins.reduce((n, c) => n + c.sells.length, 0);
  const tickets = coins.reduce((n, c) => n + c.sells.filter((x) => x.outcome === "ticket").length, 0);
  const one = mint ? res.coins[0]?.coin : undefined;
  const sym = one ? `$${one.symbol}` : "a FUMPAD coin";
  return (
    <>
      <div className={s.walletBar}>
        <span className={s.walletLabel}>Wallet</span>
        <span className={cx("num", s.walletAddr)} title={res.wallet}>
          {f.shortAddr(res.wallet, 6, 6)}
        </span>
        <CopyButton value={res.wallet} label="Copy wallet address" />
        <a className={s.ext} href={solscan("account", res.wallet, clusterQuery)} target="_blank" rel="noopener noreferrer">
          Solscan <IconExternal width={12} height={12} aria-hidden="true" />
        </a>
        {sells > 0 && (
          <span className={s.walletSum}>
            {sells} {sells === 1 ? "sell" : "sells"} · {tickets} {tickets === 1 ? "ticket" : "tickets"}
          </span>
        )}
      </div>
      {!res.found ? (
        <EmptyState title={mint ? `No trades of ${sym} yet` : "No FUMPAD trades yet"} compact>
          This wallet hasn&rsquo;t traded {sym}
          {mint ? "" : " on any app"} as far as the indexer has seen. A trade from the last minute may still be on its way: check again shortly.
        </EmptyState>
      ) : coins.length === 0 ? (
        <EmptyState title="Nothing fumbled. Yet." compact>
          This wallet bought {mint ? sym : "FUMPAD coins"} but hasn&rsquo;t sold any. Sell {f.usdRule(params.minSellUsd)} or more after holding {f.duration(params.minHoldSecs)} and the
          ticket shows up here.
        </EmptyState>
      ) : (
        coins.map((c) => (
          <CoinFumbles
            key={c.coin.mint}
            c={c}
            params={params}
            solUsd={solUsd}
            now={now}
            clusterQuery={clusterQuery}
            live={liveCoin && liveCoin.mint === c.coin.mint ? liveCoin : null}
            single={!!mint}
            link={coinLinks}
          />
        ))
      )}
      {res.truncated && <p className={s.note}>Showing the 20 coins this wallet sold most recently.</p>}
    </>
  );
}

function CoinFumbles({
  c,
  params,
  solUsd,
  now,
  clusterQuery,
  live,
  single,
  link,
}: {
  c: WalletCoinFumbles;
  params: ProtocolParams;
  solUsd: number;
  now: number;
  clusterQuery: string;
  live: CoinSummary | null;
  single: boolean;
  link: boolean;
}) {
  const coin = live ?? c.coin;
  const note = feeNote(coin.symbol, c.fees, params.feeBps, "This coin");
  const name = (
    <>
      <span className={s.cfName}>{coin.name}</span> <span className="ticker">${coin.symbol}</span>
    </>
  );
  return (
    <section className={s.coinFumbles} aria-label={`${coin.symbol} sells`}>
      {!single && (
        <header className={s.cfHead}>
          <CoinTile symbol={coin.symbol} variant={coin.tile} size="md" mint={coin.mint} imageUrl={coin.imageUrl} />
          <div className={s.cfTitle}>
            {link ? (
              <Link href={`/coin/${encodeURIComponent(coin.mint)}`} className={s.cfLink}>
                {name}
              </Link>
            ) : (
              name
            )}
            <span className={s.cfMeta}>
              {coin.status === "graduated" ? "graduated" : "on the curve"} · market cap {f.usd(coin.marketCapSol * solUsd)}
            </span>
          </div>
        </header>
      )}
      {c.isCreator && <p className={s.note}>This wallet launched ${coin.symbol}. Creators never get tickets on their own coin.</p>}
      {note && <p className={s.note}>{note}</p>}
      <ol className={s.sells}>
        {c.sells.map((x) => (
          <li key={`${x.signature}:${x.ixKey ?? 0}:${x.ticket?.id ?? ""}`}>
            <SellCard sell={x} coin={coin} params={params} solUsd={solUsd} now={now} clusterQuery={clusterQuery} />
          </li>
        ))}
      </ol>
    </section>
  );
}

const CHECK_GLYPH = { ok: "✓", fail: "✕", unknown: "?" } as const;

function SellCard({ sell, coin, params, solUsd, now, clusterQuery }: { sell: FumbleSell; coin: CoinSummary; params: ProtocolParams; solUsd: number; now: number; clusterQuery: string }) {
  const st = ticketStatus(sell, now, params);
  const app = sell.app === "fumpad" ? "FUMPAD" : f.appName(sell.app);
  const where = [sell.venue === "damm" ? "Meteora pool" : sell.venue === "dbc" ? "bonding curve" : null, app ? `via ${app}` : null].filter(Boolean).join(" · ");
  const STEPS = steps(params.ticketChallengeSecs);
  const stepIdx = st.step ? STEPS.findIndex((x) => x.key === st.step) : -1;
  const target = sell.target;
  const grad = coin.status === "graduated";
  const mcNow = coin.status === "graduated" && coin.median ? coin.median * params.totalSupply : coin.marketCapSol;
  const prog = target ? targetProgress(mcNow, target.targetMarketCapSol, params.triggerMultiple) : null;
  const closed = st.closed || sell.ticket?.state === "claimed";
  const usdLabel = sell.usdBasis === "attested" ? "at sell time (attested)" : sell.usdBasis === "nearby" ? "≈ at sell time" : "≈ today’s SOL price";
  return (
    <article className={cx(s.sell, sell.outcome === "no-ticket" && s.sellDim)}>
      <header className={s.sellHead}>
        <div className={s.sellWhen}>
          <span className="num">{f.dateTime(sell.ts)} UTC</span>
          {where && <span className={s.muted}>{where}</span>}
          {sell.signature && (
            <a className={s.ext} href={solscan("tx", sell.signature, clusterQuery)} target="_blank" rel="noopener noreferrer">
              tx <IconExternal width={11} height={11} aria-hidden="true" />
            </a>
          )}
        </div>
        <OutcomeBadge sell={sell} title={st.title} money={!!st.money} check={checkName(params.ticketChallengeSecs)} />
      </header>

      <p className={s.sellLine}>
        Sold <Tokens value={sell.tokens} compact symbol={coin.symbol} /> for{" "}
        <span className="num">
          {f.sol(sell.sol)} SOL
        </span>{" "}
        <span className={s.muted}>
          · <span className="num">{f.usd(sell.usd)}</span> {usdLabel}
          {sell.outcome === "ticket" && sell.countedTokens < sell.tokens ? ` (the ${f.compact(sell.countedTokens)} held ${Math.round(params.minHoldSecs / 60)} min+)` : ""}
        </span>
      </p>

      <ul className={s.checks} aria-label="Ticket conditions">
        {(["usd", "hold", "creator"] as const).map((k) => (
          <li key={k} className={cx(s.check, s[`c_${sell.checks[k]}`])}>
            <span className={s.checkGlyph} aria-hidden="true">
              {CHECK_GLYPH[sell.checks[k]]}
            </span>
            <span>{checkLabel(k, params)}</span>
            <span className="sr-only">{sell.checks[k] === "ok" ? "met" : sell.checks[k] === "fail" ? "not met" : "checked by the keepers"}</span>
          </li>
        ))}
      </ul>

      {sell.outcome === "no-ticket" && sell.reason && <p className={s.reason}>{reasonText(sell.reason, params)}</p>}
      {sell.checks.hold === "unknown" && sell.outcome === "verifying" && (
        <p className={s.reason}>Some of these tokens arrived by transfer, which this page can&rsquo;t time. The keepers can: they check the full history.</p>
      )}

      {st.step && (
        <div className={s.path}>
          <ol className={s.steps} aria-label="Ticket progress">
            {STEPS.map((x, i) => (
              <li key={x.key} className={cx(s.step, i < stepIdx && s.stepDone, i === stepIdx && s.stepNow, i === stepIdx && st.money && s.stepMoney)} aria-current={i === stepIdx ? "step" : undefined}>
                <span className={s.stepDot} aria-hidden="true" />
                <span className={s.stepLabel}>{x.label}</span>
              </li>
            ))}
          </ol>
          <p className={s.stepText}>
            <b>{st.title}.</b> {st.detail}
          </p>
        </div>
      )}
      {st.closed && st.title !== "No ticket" && (
        <p className={s.stepText}>
          <b>{st.title}.</b> {st.detail}
        </p>
      )}

      {target && prog && !closed && (
        <div className={s.target}>
          <p className={s.targetLead}>
            Claims when ${coin.symbol} holds a market cap of at least
          </p>
          <div className={s.targetNums}>
            <span className={cx("num", s.targetUsd)}>{f.usd(target.targetMarketCapSol * solUsd)}</span>
            <span className={cx("num", s.muted)}>{f.sol(target.targetMarketCapSol)} SOL</span>
            <span className={s.muted}>for {f.duration(params.oracleWindowSecs)}</span>
          </div>
          <div
            className={s.bar}
            role="meter"
            aria-label="Market cap toward the claim target"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(prog.fraction * 100)}
            aria-valuetext={`${f.usd(mcNow * solUsd)} of ${f.usd(target.targetMarketCapSol * solUsd)}, ${f.multiple(prog.multiple)} of the ticket price`}
          >
            <span className={cx(s.barFill, prog.reached && s.barHit)} style={{ width: `${Math.max(1.5, prog.fraction * 100)}%` }} />
          </div>
          <div className={s.barLegend}>
            <span>
              Now <span className="num">{f.usd(mcNow * solUsd)}</span> · <span className="num">{f.multiple(prog.multiple)}</span> of the ticket price
            </span>
            <span className="num">{f.fixed(prog.fraction * 100, prog.fraction < 0.1 ? 1 : 0)}%</span>
          </div>
          <p className={s.targetPays}>
            The claim pays {f.fixed(params.claimBps / 100, 0)}% of the tokens {sell.outcome === "ticket" ? "on the ticket" : "you sold"}:{" "}
            <b className="num">
              {f.compact(target.claimTokens)} ${coin.symbol}
            </b>
            , worth <b className={cx("num", s.money)}>{f.usd(target.claimValueSolAtTarget * solUsd)}</b> <span className={s.muted}>({f.sol(target.claimValueSolAtTarget)} SOL)</span> at the target.
            {target.estimated ? " Estimated from the fill price; the ticket’s price can only be higher." : ""}
          </p>
          {!grad && <p className={s.targetNote}>Claims open after graduation. Until then the ticket tracks, and the target holds.</p>}
          <p className={s.targetFine}>
            Dollar figures at today&rsquo;s SOL price ({f.usd(solUsd)}). Ticket price <span className="num">{f.priceText(target.sellPrice)}</span> SOL ×{" "}
            {params.triggerMultiple} × {f.compact(params.totalSupply)} supply. Claims pay while the coin&rsquo;s reward pool can cover them.
          </p>
        </div>
      )}
      {sell.ticket?.state === "claimed" && sell.ticket.claimedAt && (
        <p className={s.stepText}>
          Paid <b className={cx("num", s.money)}>{f.compact(sell.ticket.claimAmount)} ${coin.symbol}</b> on {f.date(sell.ticket.claimedAt)}
          {sell.ticket.claimMultiple ? ` at ${f.multiple(sell.ticket.claimMultiple)}` : ""}.
        </p>
      )}
    </article>
  );
}

function OutcomeBadge({ sell, title, money, check }: { sell: FumbleSell; title: string; money: boolean; check: string }) {
  if (sell.outcome === "no-ticket") return <Badge tone="muted">No ticket</Badge>;
  if (sell.outcome === "verifying")
    return (
      <Badge tone="muted" dot>
        Verifying
      </Badge>
    );
  const t = sell.ticket!;
  if (t.state === "claimable") return <Badge tone="flare">Claimable</Badge>;
  if (money) return <Badge tone="flare-line">{title.split(":")[0]}</Badge>;
  if (t.state === "expired" || t.state === "voided") return <Badge tone="muted">{title}</Badge>;
  if (t.state === "challenge") return <Badge tone="ink">Ticket · {check}</Badge>;
  return <Badge tone="ink">Ticket · open</Badge>;
}
