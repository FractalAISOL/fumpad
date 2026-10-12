"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { FeedEvent } from "@/data";
import { Avatar, Badge, type BadgeTone, CoinTile, CurveMeter, Gauge, IconReply, IconRepost, Mark, Multiple, Sol, cx } from "@/design";
import * as f from "@/design/format";
import { useNow } from "../shell/Providers";
import s from "./Feed.module.css";
import { coinHref } from "@/components/coin/ident";

const KIND: Record<FeedEvent["kind"], [string, BadgeTone]> = {
  cross: ["10× crossed", "flare"],
  claim: ["Claim paid", "flare-line"],
  fumble: ["Fumble", "neutral"],
  graduation: ["Graduated", "ink"],
  launch: ["Launch", "neutral"],
};

function pickLine(id: string, lines: ReactNode[]): ReactNode {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return lines[h % lines.length];
}

function Tick({ e }: { e: FeedEvent }) {
  return (
    <Link href={coinHref(e)} className={cx("ticker", s.tickerLink)}>
      ${e.symbol}
    </Link>
  );
}

/** The post copy. Written by the actor, in the product's voice: dry, exact, a little sorry. */
function body(e: FeedEvent): ReactNode {
  switch (e.kind) {
    case "fumble":
      return (
        <>
          Sold {f.tokens(e.tokens)} <Tick e={e} /> for {f.sol(e.sol)} SOL.{" "}
          {pickLine(e.id, [
            "Ticket filed. See you at 10×, or never.",
            "Calling the top. Logging the ticket in case I'm wrong.",
            "Rent is due.",
            "Taking profit. Keeping the receipt.",
            "I'll be fine. The ticket says otherwise.",
          ])}
        </>
      );
    case "cross":
      return e.multiple >= 18 ? (
        <>
          <Tick e={e} /> ticket crossed 10× and kept going. The market would like to apologise.
        </>
      ) : (
        <>
          <Tick e={e} /> held {f.multiple(e.multiple)} of my sell for thirty minutes.{" "}
          {pickLine(e.id, [
            "My ticket is live. My dignity is not.",
            "Not a spike, the median held. Claim open.",
            "Claim open. Should I wait? It might go higher.",
          ])}
        </>
      );
    case "claim":
      return e.skippedAhead ? (
        <>
          Claim for {f.tokens(e.tokens)} <Tick e={e} /> skipped the queue. Small claims fit first. Being poor finally paid off.
        </>
      ) : e.fromQueue ? (
        <>
          Queued claim for {f.tokens(e.tokens)} <Tick e={e} /> just paid. The pool grew into it.
        </>
      ) : e.auto ? (
        <>
          Auto-claimed {f.tokens(e.tokens)} <Tick e={e} /> while I wasn&apos;t looking. The keeper clicked the button for me.{" "}
          {pickLine(e.id, ["Didn't even have to watch the chart.", "Slept through my own comeback.", "Fumbled the sell, not the claim."])}
        </>
      ) : (
        <>
          Claimed {f.tokens(e.tokens)} <Tick e={e} />. Paid in the same transaction.{" "}
          {pickLine(e.id, ["I'm a holder again, God help me.", "Same tokens, more SOL.", "Congratulations to me, sort of."])}
        </>
      );
    case "graduation":
      return (
        <>
          <Tick e={e} /> graduated. {raisedSol(e.raisedSol)} SOL on the curve, liquidity now on PumpSwap and locked for good. {f.int(e.ticketsUnlocked)} fumble tickets can claim at
          10×.
        </>
      );
    case "launch":
      return (
        <>
          Launched <Tick e={e} />. 8% of supply already sits in its fumble pool. Sell it early, I dare you.
          {e.snipeTaxSol ? (
            <>
              {" "}
              Snipers paid <span className="num">{f.sol(e.snipeTaxSol)}</span> SOL of snipe tax into it on the way in.
            </>
          ) : null}
        </>
      );
  }
}

function Embed({ e }: { e: FeedEvent }) {
  if (e.kind === "cross" || e.kind === "claim") {
    const tokens = e.kind === "cross" ? e.claimTokens : e.tokens;
    const sol = e.kind === "cross" ? e.claimSol : e.sol;
    return (
      <div className={cx(s.embed, e.kind === "cross" && s.embedHit)}>
        <div className={s.embedRow}>
          <CoinTile symbol={e.symbol} variant={e.tile} size="sm" />
          <div className={s.grow}>
            <div className="ticker">${e.symbol}</div>
            <div className={s.meta}>
              {e.kind === "cross" ? "claim open" : "paid"}: <span className="num">{f.tokens(tokens)}</span> {e.symbol}
            </div>
          </div>
          <div className={s.embedEnd}>
            <Multiple x={e.multiple} size="md" />
            <Sol value={sol} size="xs" className={s.meta} />
          </div>
        </div>
        <Gauge value={e.multiple} size="mini" label={`$${e.symbol} at ${f.multiple(e.multiple)}`} />
      </div>
    );
  }
  if (e.kind === "fumble") {
    return (
      <div className={s.embed}>
        <div className={s.embedRow}>
          <CoinTile symbol={e.symbol} variant={e.tile} size="sm" />
          <div className={s.grow}>
            <div className="ticker">${e.symbol}</div>
            <div className={s.meta}>ticket filed, claimable at 10×</div>
          </div>
          <div className={s.embedEnd}>
            <Sol value={e.sol} size="md" />
            <div className={s.meta}>sold</div>
          </div>
        </div>
        <Gauge value={1} size="mini" label={`New $${e.symbol} ticket at 1×`} />
      </div>
    );
  }
  if (e.kind === "graduation") {
    return (
      <div className={s.embed}>
        <div className={s.embedRow}>
          <CoinTile symbol={e.symbol} variant={e.tile} size="sm" />
          <div className={s.grow}>
            <div className="ticker">${e.symbol}</div>
            <div className={s.meta}>bonding curve complete</div>
          </div>
          <span className="num">
            {raisedSol(e.raisedSol)} / {raisedSol(e.raisedSol)} SOL
          </span>
        </div>
        <CurveMeter raised={e.raisedSol} target={e.raisedSol} size="sm" />
      </div>
    );
  }
  return null;
}

/** Graduation raise: "85" on the mainnet curve, "0.850" on devnet's scaled-down one. */
function raisedSol(n: number): string {
  return Number.isInteger(n) ? f.int(n) : f.sol(n);
}

export function FeedPost({ e, fresh }: { e: FeedEvent; fresh?: boolean }) {
  const now = useNow();
  const [label, tone] = KIND[e.kind];
  const system = e.kind === "graduation";
  return (
    <article className={cx(s.post, fresh && s.fresh)} aria-label={`${label}, $${e.symbol}`}>
      {system ? (
        <span className={s.sysAv}>
          <Mark size={40} />
        </span>
      ) : (
        <Link href={`/u/${e.actor}`} tabIndex={-1} aria-hidden="true">
          <Avatar address={e.actor} />
        </Link>
      )}
      <div className={s.postMain}>
        <div className={s.postHead}>
          {system ? (
            <b>FUMPAD</b>
          ) : (
            <Link href={`/u/${e.actor}`} className={s.who}>
              <b>{e.actorName ?? f.shortAddr(e.actor)}</b>
              {e.actorName && <span className={cx("num", s.addr)}>{f.shortAddr(e.actor)}</span>}
            </Link>
          )}
          <time dateTime={new Date(e.ts).toISOString()} className={s.time}>
            {f.ago(e.ts, Math.max(now, e.ts))}
          </time>
          <Badge tone={tone} className={s.kind}>
            {label}
          </Badge>
        </div>
        <p className={s.text}>{body(e)}</p>
        <Embed e={e} />
        <div className={s.postFoot}>
          <span className={s.stat}>
            <IconReply />
            <span className="num">{e.replies}</span>
            <span className="sr-only">replies</span>
          </span>
          <span className={s.stat}>
            <IconRepost />
            <span className="num">{e.reposts}</span>
            <span className="sr-only">reposts</span>
          </span>
          <Link href={coinHref(e)} className={s.open}>
            Open ${e.symbol}
          </Link>
        </div>
      </div>
    </article>
  );
}
