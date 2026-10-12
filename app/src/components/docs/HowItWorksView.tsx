"use client";

import Link from "next/link";
import { Gauge, SplitBar } from "@/design";
import * as f from "@/design/format";
import { useProtocolParams } from "../shell/Providers";
import { DocPage, DocSection, Facts, type TocItem } from "./Doc";
import s from "./Doc.module.css";

/** Protocol constants that are not `Global.params` (fixed in the program, docs/SPEC.md). */
const LP_SKIM_PLATFORM = 60;
const LP_SKIM_CREATOR = 40;
const PUMPSWAP_LP_FEE_PCT = 0.2;
const REFERENCE_WINDOW_SECS = 600;
const MAX_QUEUED_PER_WALLET = 2;
const ESCAPE_HATCH_DAYS = 7;
const TIMELOCK_HOURS = 48;
const SLOT_SECS = 0.4;

const TOC: TocItem[] = [
  { id: "concept", label: "The idea" },
  { id: "tickets", label: "Tickets" },
  { id: "claims", label: "Claims and the 10× median" },
  { id: "fees", label: "Fees & rewards" },
  { id: "snipe", label: "Snipe protection" },
  { id: "graduation", label: "Graduation" },
  { id: "lp", label: "Liquidity locked forever" },
  { id: "protections", label: "Protections" },
  { id: "faq", label: "FAQ" },
];

const pctOfBps = (bps: number) => f.fixed(bps / 100, bps % 100 === 0 ? 0 : 1);

/** D19 schedule: min(start, ⌈100%·(W − d)/W⌉) at slot offset d < W. */
function snipeSchedule(windowSlots: number, startBps: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < windowSlots; d++) out.push(Math.min(startBps, Math.ceil((10_000 * (windowSlots - d)) / windowSlots)));
  return out;
}

export function HowItWorksView({ cluster }: { cluster: string | null }) {
  const p = useProtocolParams();
  const trigger = `${f.int(p.triggerMultiple)}×`;
  const claimPct = pctOfBps(p.claimBps);
  const maxClaimPct = pctOfBps(p.maxClaimPoolBps);
  const poolPct = f.fixed((p.rewardPoolSupply / p.totalSupply) * 100, 0);
  const fee = pctOfBps(p.feeBps);
  const split = [p.feePoolShareBps, p.feePlatformShareBps, p.feeCreatorShareBps].map((b) => b / 100);
  const minSell = f.usdRule(p.minSellUsd);
  const hold = f.duration(p.minHoldSecs);
  const median = f.durationAdj(p.oracleWindowSecs);
  const schedule = snipeSchedule(p.snipeWindowSlots, p.snipeStartBps);
  const grad = p.graduationSol < 10 ? f.fixed(p.graduationSol, 2) : f.int(p.graduationSol);

  return (
    <DocPage
      title="How FUMPAD works"
      lede={
        <>
          FUMPAD is a Solana launchpad for people who sell too early. Sell through FUMPAD and you get a ticket. If the coin later holds {trigger} your sell
          price, you can claim {claimPct}% of what you sold back from the coin&apos;s reward pool.
        </>
      }
      aside={
        <figure className={s.figure}>
          <Gauge value={10.4} size="lg" label={`Example ticket at 10.4×, past the ${trigger} line`} />
          <figcaption>
            A ticket at 10.4×. The coin&apos;s {median} median holds above {trigger} your sell price, so {claimPct}% of the tokens you sold are claimable.
          </figcaption>
        </figure>
      }
      toc={TOC}
    >
      <DocSection id="concept" title="The idea">
        <p>
          Everyone has sold a coin that went on to do {trigger}. On FUMPAD that sell is on the record: every sell of {minSell} or more through FUMPAD files a
          ticket at your sell price. Each coin carries its own reward pool, seeded with {poolPct}% of the supply at launch and topped up by trading fees.
          When a ticket crosses {trigger}, its owner claims from that pool.
        </p>
        <p>
          It is a rebate on a specific regret, paid in the coin itself. It is not insurance, and it isn&apos;t guaranteed: a claim pays only while the
          coin&apos;s pool can cover it. See the <Link href="/risk">risk disclosure</Link>.
        </p>
      </DocSection>

      <DocSection id="tickets" title="Tickets">
        <p>A sell through FUMPAD files a ticket when all of these hold. If one doesn&apos;t, the sell still goes through, just without a ticket.</p>
        <Facts
          label="Ticket rules"
          rows={[
            { k: "Smallest sell that files a ticket", v: <span className="num">{minSell}</span> },
            { k: "Time the tokens must sit in your wallet first", v: <span className="num">{hold}</span> },
            { k: "Open tickets per wallet, per coin", v: <span className="num">{f.int(p.maxOpenTickets)}</span> },
            { k: "Coin creator's own sells", v: "never file" },
          ]}
        />
        <p>
          <b>Ticket price.</b> Your ticket is priced at your fill. If the price dropped in the last {f.duration(REFERENCE_WINDOW_SECS)}, FUMPAD uses its
          recent-average floor instead, so a crash staged right before a sell can&apos;t make a ticket cheap. The floor errs higher, never lower.
        </p>
        <p>
          <b>Rebuys.</b> Buying the same coin back through FUMPAD within {f.duration(p.rebuyWindowSecs)} of a sell shrinks that ticket by the amount you
          bought, newest ticket first. Buy it all back and the ticket is void. Sells on other venues never file tickets.
        </p>
      </DocSection>

      <DocSection id="claims" title="Claims and the 10× median">
        <p>
          A ticket is claimable once the coin has graduated and its <b>{median} median price</b> holds at {trigger} your ticket price or more. A median
          over many keeper samples, not a single trade, so a one-block spike doesn&apos;t count.
        </p>
        <Facts
          label="Claim rules"
          rows={[
            { k: "Trigger", v: <span className="num">{trigger} the ticket price</span> },
            { k: "Claim size", v: <span className="num">{claimPct}% of the ticket&apos;s tokens</span> },
            { k: "Largest single payout", v: <span className="num">{maxClaimPct}% of the pool</span> },
            { k: "Time to claim after the sell", v: <span className="num">{f.duration(p.claimWindowSecs)}</span> },
            { k: "Queue entries per wallet, per coin", v: <span className="num">{MAX_QUEUED_PER_WALLET}</span> },
          ]}
        />
        <p>
          If the claim fits the pool, it pays in the same transaction. If it doesn&apos;t, it joins the coin&apos;s claim queue, ordered by sell time; smaller
          claims that fit can skip ahead. Queued claims don&apos;t expire and are never paid in part. Claims are made for you by default (auto-claim, to
          your own wallet only); you can turn that off per coin in <Link href="/fumbles">My fumbles</Link>.
        </p>
      </DocSection>

      <DocSection id="fees" title="Fees & rewards">
        <p>
          Every FUMPAD trade pays a {fee}% fee on its SOL side, before and after graduation. It splits {split[0]} / {split[1]} / {split[2]}:
        </p>
        <div className={s.figure}>
          <SplitBar
            label="Fee split"
            parts={[
              { label: "pool", share: split[0] },
              { label: "FUMPAD", share: split[1] },
              { label: "creator", share: split[2] },
            ]}
          />
        </div>
        <p>
          The pool&apos;s share buys the coin back into its reward pool. After graduation the locked liquidity also earns PumpSwap&apos;s{" "}
          {f.fixed(PUMPSWAP_LP_FEE_PCT, 2)}% LP fee on all volume, from any app. FUMPAD skims that growth: the token side goes to the reward pool, the SOL
          side splits {LP_SKIM_PLATFORM} / {LP_SKIM_CREATOR} between FUMPAD and the creator, which works out to about the same 50 / 30 / 20 by value.
        </p>
        <Facts
          label="Fee numbers"
          rows={[
            { k: "Trading fee, every FUMPAD trade", v: <span className="num">{fee}%</span> },
            { k: "Reward pool seeded at launch", v: <span className="num">{poolPct}% of supply</span> },
            { k: "LP fee skim, SOL side", v: <span className="num">{LP_SKIM_PLATFORM} / {LP_SKIM_CREATOR}</span> },
          ]}
        />
      </DocSection>

      <DocSection id="snipe" title="Snipe protection">
        {schedule.length ? (
          <>
            <p>
              Buys in the first {f.int(p.snipeWindowSlots)} slots after launch (about {f.fixed(p.snipeWindowSlots * SLOT_SECS, 1)} seconds) pay a snipe tax
              on top of the normal fee, stepping down slot by slot. The whole tax goes to the coin&apos;s reward pool, so a sniper funds the people who sell
              later.
            </p>
            <figure className={s.figure}>
              <ul className={s.steps} aria-label="Snipe tax by slot after launch">
                {schedule.map((bps, d) => (
                  <li key={d}>
                    <span>{d === 0 ? "Launch slot" : `Slot +${d}`}</span>
                    <span className={s.bar} aria-hidden="true">
                      <i style={{ width: `${bps / 100}%` }} />
                    </span>
                    <span className="num">{pctOfBps(bps)}%</span>
                  </li>
                ))}
                <li>
                  <span>Slot +{schedule.length}</span>
                  <span className={s.bar} aria-hidden="true" />
                  <span className="num">0%</span>
                </li>
              </ul>
              <figcaption>Tax as a share of what the buyer spends. From slot +{schedule.length}, buys pay only the {fee}% fee.</figcaption>
            </figure>
            <p>
              A taxed buy never costs more than the same buy outside the window; it just gets fewer tokens. Sells are never taxed. The creator&apos;s own
              first buy inside the launch transaction is exempt; every other wallet pays, including any the creator runs.
            </p>
          </>
        ) : (
          <p>Snipe protection is switched off for new launches right now: buys pay only the {fee}% fee from the first slot.</p>
        )}
      </DocSection>

      <DocSection id="graduation" title="Graduation">
        <p>
          Every coin starts on FUMPAD&apos;s own bonding curve. When the curve has raised {grad} SOL it completes, and anyone can graduate it: the raised SOL
          and the reserved tokens open a PumpSwap pool at the curve&apos;s final price.
          {p.graduationFeeSol > 0 && (
            <> A graduation fee of {f.fixed(p.graduationFeeSol, 2)} SOL comes out of the raise to pay the setup rent for the coin&apos;s claim queue and price samples.</>
          )}
        </p>
        <p>
          Sells on the curve file tickets too. They count toward {trigger} straight away and become claimable once the coin graduates. If a completed coin
          can&apos;t graduate within {ESCAPE_HATCH_DAYS} days, curve sells reopen so holders can exit.
        </p>
      </DocSection>

      <DocSection id="lp" title="Liquidity locked forever">
        <p>
          At graduation every LP token goes into a separate locker program with no admin and no upgrade authority. Nothing can withdraw the principal,
          including FUMPAD. The locker can only skim fee growth, and it checks after every skim that what remains is worth at least what was locked.
        </p>
      </DocSection>

      <DocSection id="protections" title="Protections">
        <ul>
          <li>
            <b>Hold time.</b> Tokens must sit in your wallet for {hold} before a sell of them counts, so buy-and-dump in one block files nothing.
          </li>
          <li>
            <b>Recent-average floor.</b> Tickets are priced at your fill or the recent average, whichever is higher.
          </li>
          <li>
            <b>Rebuy rule.</b> Buying back within {f.duration(p.rebuyWindowSecs)} shrinks or voids your ticket.
          </li>
          <li>
            <b>Creator exclusion.</b> The creator&apos;s wallet never files tickets. Wallets that look linked to a creator are flagged publicly and left off
            leaderboards.
          </li>
          <li>
            <b>Keeper median.</b> Only samples from FUMPAD&apos;s keepers count toward the {median} median, and they must cover the whole window.
          </li>
          <li>
            <b>Pool cap.</b> One payout can take at most {maxClaimPct}% of a pool, so one big claim can&apos;t drain it.
          </li>
          <li>
            <b>Slow rule changes.</b> Protocol parameter changes wait {TIMELOCK_HOURS} hours before they apply, and fees are fixed per coin at launch.
          </li>
        </ul>
      </DocSection>

      <DocSection id="faq" title="FAQ">
        <div className={s.faq}>
          <Faq q="Is this insurance?">
            <p>
              No. A ticket is a conditional claim on one coin&apos;s reward pool. If the coin never holds {trigger}, or the pool can&apos;t cover the claim,
              nothing is paid.
            </p>
          </Faq>
          <Faq q="What happens if the pool is too small?">
            <p>
              Your claim waits in that coin&apos;s queue, in sell-time order, and pays in full once the pool can cover it. It doesn&apos;t expire while it
              waits. There are no partial payouts.
            </p>
          </Faq>
          <Faq q="Why didn't my sell file a ticket?">
            <p>
              The usual reasons: it was under {minSell}, the tokens had been in your wallet for less than {hold}, you already have{" "}
              {f.int(p.maxOpenTickets)} open tickets on that coin, you created the coin, or the sell went through another app.
            </p>
          </Faq>
          <Faq q="Do I have to claim myself?">
            <p>
              No. Auto-claim is on by default: FUMPAD&apos;s keeper claims as soon as a ticket qualifies, and the tokens can only go to your wallet. You can
              claim by hand too, or switch auto-claim off per coin.
            </p>
          </Faq>
          <Faq q="What does a ticket cost?">
            <p>
              The {fee}% trading fee you pay on any FUMPAD trade, plus about 0.002 SOL of account rent that comes back when the ticket is closed.
            </p>
          </Faq>
          <Faq q="Can FUMPAD change the rules on my coin?">
            <p>
              Fees are fixed per coin at launch. Other parameter changes wait {TIMELOCK_HOURS} hours before they apply. Locked liquidity can&apos;t be touched
              by anyone. FUMPAD can pause launches, trading or claims in an emergency.
            </p>
          </Faq>
          {cluster && (
            <Faq q={`Why ${cluster}?`}>
              <p>
                FUMPAD is running on Solana {cluster.toLowerCase()} while it&apos;s tested. Tokens and SOL there have no market value, and the numbers on this
                page come from the {cluster.toLowerCase()} settings, which are scaled down from mainnet.
              </p>
            </Faq>
          )}
        </div>
      </DocSection>
    </DocPage>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details>
      <summary>{q}</summary>
      <div>{children}</div>
    </details>
  );
}
