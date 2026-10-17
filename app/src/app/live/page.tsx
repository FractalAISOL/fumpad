import { LaunchWindow, OpensBanner, SoonBanner } from "@/components/checker/LaunchWindow";
import { HERO, SOON_CAVEAT, launchSections, launchState, soonLede } from "@/components/checker/launchState";
import { parseOpensAt } from "@/components/checker/model";
import { Rules } from "@/components/checker/Rules";
import s from "@/components/checker/Checker.module.css";
import { X_URL } from "@/components/prelaunch/links";
import { CLUSTER_LABEL, SOLSCAN_QUERY } from "@/chain/cluster";
import { defaultInterval, windowStart } from "@/data/candles";
import { cachedCandles, cachedCoin, shellSnapshot } from "@/data/server";
import { Button } from "@/design";
import { IconX } from "@/design/components/Icons";
import { cx } from "@/design/cx";
import { Fumi, SpeechBubble } from "@/design/anime";
import l from "./Live.module.css";

/**
 * The launch-window page (LAUNCH.md): fumpad.app's only page until the full app opens. Two states
 * (`components/checker/launchState.ts`):
 *   coming soon (no NEXT_PUBLIC_CHECKER_MINT): a pre-launch hero with Fumi's greeting and "Follow @fumpadapp", then
 *     the rules, fees and video. No coin panel, trade links or checker box.
 *   live (the first coin's mint is set): one read-only page about the FIRST coin, its live chart and trade links,
 *     and the Fumble Checker; NEXT_PUBLIC_APP_OPENS_AT (ISO) adds a countdown.
 * One Fumi per screen: the header's (bust on phones, figure from 600 px); the checker's own sits a screen lower.
 * Server data is cached (prerendered with the shell, revalidated in the background); the client keeps it live
 * over the API's WebSocket. The wallet lookup runs in the browser against the API.
 */
export default async function LivePage() {
  const ls = launchState(process.env.NEXT_PUBLIC_CHECKER_MINT);
  const show = launchSections(ls.state);
  const hero = HERO[ls.state];
  const opensAt = parseOpensAt(process.env.NEXT_PUBLIC_APP_OPENS_AT);
  const { solUsd, now, params } = await shellSnapshot();
  const coin = ls.mint ? await cachedCoin(ls.mint) : null;
  const first = coin && coin.mint === ls.mint ? coin : null;
  // A fresh launch opens on 1-minute candles (`defaultInterval`); not indexed yet: an empty 1m window.
  const candles = first ? await cachedCandles(first.mint, defaultInterval(first.createdAt, now)) : { interval: "1m" as const, from: windowStart("1m", now), candles: [] };

  return (
    <div className={s.page}>
      {show.opensBanner && <OpensBanner opensAt={opensAt} serverNow={now} cluster={CLUSTER_LABEL} />}
      {show.soonBanner && <SoonBanner cluster={CLUSTER_LABEL} />}
      <div className={cx(s.hero, l.hero)}>
        <div className={l.heroText}>
          <div className={l.greet}>
            <Fumi pose="waving" size={56} crop="bust" />
            <SpeechBubble tail="left" pop={false} className={l.greetBubble}>
              {hero.bubble}
            </SpeechBubble>
          </div>
          <p className={s.eyebrow}>{hero.eyebrow}</p>
          <h1 className={s.h1}>
            {hero.title}
            <br />
            <span className={s.h1Quiet}>{hero.quiet}</span>
          </h1>
          {show.intro && (
            <>
              <p className={cx(s.lede, l.intro)}>{soonLede(params)}</p>
              <p className={l.caveat}>{SOON_CAVEAT}</p>
            </>
          )}
          {show.follow && (
            <div className={l.cta}>
              <Button href={X_URL} size="lg" target="_blank" rel="noopener noreferrer" icon={<IconX width={16} height={16} />}>
                Follow @fumpadapp on X
              </Button>
            </div>
          )}
        </div>
        <div className={l.side}>
          <SpeechBubble tail="bottom-right" className={l.sideBubble}>
            {hero.bubble}
          </SpeechBubble>
          <Fumi pose="waving" size="md" fade pop />
        </div>
      </div>
      {show.coin && ls.mint && (
        <LaunchWindow mint={ls.mint} coin={first} candles={candles} params={params} solUsd={solUsd} clusterQuery={SOLSCAN_QUERY} serverNow={now} />
      )}
      <section className={s.section} aria-labelledby="rules-h">
        <div className={s.sectionHead}>
          <p className={s.eyebrow}>The rules</p>
          <h2 id="rules-h" className={s.h2}>
            How to play, in five levels
          </h2>
        </div>
        <Rules params={params} coin={first ? { symbol: first.symbol, fees: first.fees } : undefined} />
      </section>
    </div>
  );
}
