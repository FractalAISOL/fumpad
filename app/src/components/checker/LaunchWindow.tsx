"use client";

import { Suspense, useState } from "react";
import type { CandleSeries, CoinDetail, ProtocolParams } from "@/data";
import { Skeleton, cx } from "@/design";
import { CoinWindow } from "./CoinWindow";
import { FumbleCheck } from "./FumbleCheck";
import { useClock } from "./hooks";
import { SOON_BANNER } from "./launchState";
import { countdown, opensInText } from "./model";
import s from "./Checker.module.css";

/** "Full app opens in ~N min" with a live countdown when NEXT_PUBLIC_APP_OPENS_AT is set. */
export function OpensBanner({ opensAt, serverNow, cluster }: { opensAt: number | null; serverNow: number; cluster: string | null }) {
  const now = useClock(1_000, serverNow);
  const text = opensInText(opensAt, now);
  const left = opensAt !== null ? opensAt - now : null;
  return (
    <div className={s.banner} role="status">
      <span className={s.liveDot} aria-hidden="true" />
      <span className={s.bannerText}>
        <b>The first coin is live.</b> {text}
      </span>
      {left !== null && left > 0 && (
        <span className={s.bannerClock} aria-label={`Opens in ${countdown(left)}`}>
          <span className="num">{countdown(left)}</span>
        </span>
      )}
      {cluster && <span className={s.clusterTag}>{cluster}</span>}
    </div>
  );
}

/** The coming-soon state's banner: no live dot, no countdown (nothing is live yet). */
export function SoonBanner({ cluster }: { cluster: string | null }) {
  return (
    <div className={cx(s.banner, s.bannerSoon)}>
      <span className={s.soonDot} aria-hidden="true" />
      <span className={s.bannerText}>
        <b>{SOON_BANNER.strong}</b> {SOON_BANNER.rest}
      </span>
      {cluster && <span className={s.clusterTag}>{cluster}</span>}
    </div>
  );
}

/**
 * The launch-window page's live half: the coin window, and the Fumble Checker scoped to that coin. The coin's
 * pushed state (market cap) feeds the checker's claim-target bars.
 */
export function LaunchWindow({
  mint,
  coin,
  candles,
  params,
  solUsd,
  clusterQuery,
  serverNow,
}: {
  mint: string;
  coin: CoinDetail | null;
  candles: CandleSeries;
  params: ProtocolParams;
  solUsd: number;
  clusterQuery: string;
  serverNow: number;
}) {
  const [live, setLive] = useState<CoinDetail | null>(coin);
  return (
    <>
      <section className={s.section} aria-label="The first coin, live">
        <CoinWindow mint={mint} initialCoin={coin} initialCandles={candles} params={params} solUsd={solUsd} clusterQuery={clusterQuery} onCoin={setLive} serverNow={serverNow} />
      </section>
      <section className={s.section} id="check" aria-labelledby="check-h">
        <div className={s.sectionHead}>
          <p className={s.eyebrow}>Fumble Checker</p>
          <h2 id="check-h" className={s.h2}>
            Did you fumble{live ? ` $${live.symbol}` : ""}?
          </h2>
          <p className={s.lede}>
            Paste your wallet to see every sell of {live ? `$${live.symbol}` : "the first coin"}: whether it counts, where its ticket stands, and the market cap it claims at.
          </p>
        </div>
        <Suspense fallback={<Skeleton h={120} />}>
          <FumbleCheck mint={mint} params={params} solUsd={solUsd} clusterQuery={clusterQuery} liveCoin={live} serverNow={serverNow} headingId="check-h" />
        </Suspense>
      </section>
    </>
  );
}
