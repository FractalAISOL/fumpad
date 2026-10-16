import { LaunchWindow, OpensBanner } from "@/components/checker/LaunchWindow";
import { isPublicKey, parseOpensAt } from "@/components/checker/model";
import { Rules } from "@/components/checker/Rules";
import s from "@/components/checker/Checker.module.css";
import { CLUSTER_LABEL, SOLSCAN_QUERY } from "@/chain/cluster";
import { cachedCoin, cachedPriceSeries, shellSnapshot } from "@/data/server";
import { cx } from "@/design/cx";
import { Fumi, SpeechBubble } from "@/design/anime";
import l from "./Live.module.css";

/**
 * The launch window (LAUNCH.md, "Launch-window checker"): one read-only page about the FIRST coin only, between its
 * launch and the full app. The coin is NEXT_PUBLIC_CHECKER_MINT; NEXT_PUBLIC_APP_OPENS_AT (ISO) adds a countdown.
 * Server data is cached (prerendered with the shell, revalidated in the background); the client keeps it live
 * over the API's WebSocket. The wallet lookup runs in the browser against the API.
 */
export default async function LivePage() {
  const mint = (process.env.NEXT_PUBLIC_CHECKER_MINT ?? "").trim();
  const opensAt = parseOpensAt(process.env.NEXT_PUBLIC_APP_OPENS_AT);
  const { solUsd, now, params } = await shellSnapshot();
  const valid = isPublicKey(mint);
  const [coin, series] = valid ? await Promise.all([cachedCoin(mint), cachedPriceSeries(mint, "all")]) : [null, []];
  const first = coin && coin.mint === mint ? coin : null;

  return (
    <div className={s.page}>
      <OpensBanner opensAt={opensAt} serverNow={now} cluster={CLUSTER_LABEL} />
      <div className={cx(s.hero, l.hero)}>
        <div className={l.heroText}>
          <div className={l.greet}>
            <Fumi pose="waving" size={56} crop="bust" />
            <SpeechBubble tail="left" pop={false} className={l.greetBubble}>
              Hi, fumbler!
            </SpeechBubble>
          </div>
          <p className={s.eyebrow}>Launch window</p>
          <h1 className={s.h1}>
            The first coin is live.
            <br />
            <span className={s.h1Quiet}>Sold too early? Check.</span>
          </h1>
        </div>
        <div className={l.side}>
          <SpeechBubble tail="bottom-right" className={l.sideBubble}>
            Hi, fumbler!
          </SpeechBubble>
          <Fumi pose="waving" size="md" fade pop />
        </div>
      </div>
      {valid ? (
        <LaunchWindow mint={mint} coin={first} series={first ? series : []} params={params} solUsd={solUsd} clusterQuery={SOLSCAN_QUERY} serverNow={now} />
      ) : (
        <section className={s.section}>
          <p className={s.lede}>No coin is configured for the launch window yet (NEXT_PUBLIC_CHECKER_MINT).</p>
        </section>
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
