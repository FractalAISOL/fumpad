import type { CoinFees, ProtocolParams } from "@/data";
import { SplitBar, cx } from "@/design";
import * as f from "@/design/format";
import { HowToPlayVideo } from "./HowToPlayVideo";
import { feeNote, minutes, pct } from "./model";
import s from "./Checker.module.css";

/**
 * The rules on one screen, as the "How to play" video tells them (five levels), the standard fee model, and the
 * video itself. The numbers come from Global.params; `coin` adds a one-line note when that coin's own fee differs
 * (the launch coin: 3%, split between its Reward Pool and the team wallet).
 */
export function Rules({ params: p, coin, headingId = "rules-h" }: { params: ProtocolParams; coin?: { symbol: string; fees?: CoinFees }; headingId?: string }) {
  const ours = (p.feeBps * (10_000 - p.venueFeeShareBps)) / 10_000;
  const levels: { n: number; title: string; body: string; money?: boolean }[] = [
    { n: 1, title: "Buy a FUMPAD coin", body: "On FUMPAD or any app: Axiom, Jupiter, Phantom, GMGN, a bot. Every app counts." },
    { n: 2, title: `Hold it ${minutes(p.minHoldSecs)}`, body: `Tokens must sit in your wallet at least ${f.duration(p.minHoldSecs)} before a sell of them counts.` },
    {
      n: 3,
      title: `Sell ${f.usdRule(p.minSellUsd)} or more`,
      body: `You get a Fumble Ticket at your sell price. Three keepers verify it; then a ${Math.round(p.ticketChallengeSecs / 3600)}-hour check before it can pay.`,
    },
    { n: 4, title: "The coin graduates", body: `It fills its bonding curve and moves to a Meteora pool, liquidity locked for good. Claims open here.` },
    {
      n: 5,
      title: `It holds ${p.triggerMultiple}×? Claim ${f.fixed(p.claimBps / 100, 0)}%`,
      body: `When the ${f.durationAdj(p.oracleWindowSecs)} median holds ${p.triggerMultiple}× your ticket price, claim ${f.fixed(p.claimBps / 100, 0)}% of the tokens you sold, from the coin’s Reward Pool.`,
      money: true,
    },
  ];
  const note = coin ? feeNote(coin.symbol, coin.fees, p.feeBps) : null;
  const walletSplit = coin?.fees?.policy === "wallet_split";
  return (
    <div className={s.rules}>
      <div className={s.rulesMain}>
        <ol className={s.levels} aria-labelledby={headingId}>
          {levels.map((l) => (
            <li key={l.n} className={cx(s.level, l.money && s.levelMoney)}>
              <span className={cx("num", s.levelN)} aria-hidden="true">
                {l.n}
              </span>
              <div>
                <h3 className={s.levelTitle}>
                  <span className="sr-only">Level {l.n}: </span>
                  {l.title}
                </h3>
                <p className={s.levelBody}>{l.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className={s.fees} aria-labelledby="fees-h">
          <h3 id="fees-h" className={s.feesTitle}>
            Where the fees go
          </h3>
          <p className={s.feesLead}>
            Every trade, on any app, pays a <b className="num">{pct(p.feeBps)}</b> fee. Meteora keeps <span className="num">{pct(p.feeBps - ours)}</span>; FUMPAD&rsquo;s{" "}
            <span className="num">{pct(ours)}</span> splits three ways:
          </p>
          <SplitBar
            label="FUMPAD's share of the fee"
            parts={[
              { label: "Reward Pool", share: p.feePoolShareBps / 100 },
              { label: "FUMPAD", share: p.feePlatformShareBps / 100 },
              { label: "creator", share: p.feeCreatorShareBps / 100 },
            ]}
          />
          <ul className={s.feeList}>
            <li>
              <b>{f.fixed(p.feePoolShareBps / 100, 0)}% buys the coin back</b> into its Reward Pool, the pool that pays the claims.
            </li>
            <li>
              <b>Plus {f.fixed((p.rewardPoolSupply / p.totalSupply) * 100, 0)}% of the supply</b> lands in the pool at graduation.
            </li>
            <li>
              <b>The launch fee</b> (high for the first ~{Math.max(1, Math.round(p.snipeWindowSlots * 0.4))} seconds, to stop snipers): FUMPAD&rsquo;s share goes to the pool too.
            </li>
          </ul>
          {note && (
            <p className={s.feeNote}>
              {note}
              {walletSplit ? " Its launch-fee share goes to the same wallet; the 8% at graduation still goes to its pool." : ""}
            </p>
          )}
        </div>
      </div>
      <figure className={s.video}>
        <HowToPlayVideo />
        <figcaption className={s.videoCap}>How to play, in 40 seconds. Illustrative numbers.</figcaption>
      </figure>
    </div>
  );
}
