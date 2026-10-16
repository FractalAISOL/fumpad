"use client";

import Link from "next/link";
import { feeBpsAtSlot } from "@/data/meteora";
import { Gauge, SplitBar } from "@/design";
import * as f from "@/design/format";
import { useProtocolParams } from "../shell/Providers";
import { DocPage, DocSection, Facts, type TocItem } from "./Doc";
import s from "./Doc.module.css";
import { BeatMark, BeatSpot, FumiCompanion, useActiveBeat, type Beat } from "./FumiGuide";

/** Protocol constants that are not `Global.params` (fixed in the program, docs/SPEC-v0.7-meteora.md). */
const REFERENCE_WINDOW_SECS = 600;
const MAX_QUEUED_PER_WALLET = 2;
/** SPEC v0.7 C-TL: params / DBC-config changes wait 1 h; admin / treasury / guardian changes wait 6 h. */
const TIMELOCK_HOURS = 1;
const ADMIN_TIMELOCK_HOURS = 6;
const SLOT_SECS = 0.4;
/** D31: attestations need 2 of the 3 keepers. */
const KEEPERS = 3;
const ATTEST_THRESHOLD = 2;
/** Apps that trade Meteora pools, named as examples (not partners). */
const APPS = "Axiom, Jupiter, GMGN or Photon";

const TOC: TocItem[] = [
  { id: "concept", label: "The idea" },
  { id: "tickets", label: "Tickets" },
  { id: "verify", label: "How a sell becomes a ticket" },
  { id: "claims", label: "Claims and the 10× median" },
  { id: "fees", label: "Fees & rewards" },
  { id: "snipe", label: "Snipe protection" },
  { id: "graduation", label: "Graduation" },
  { id: "lp", label: "Liquidity locked forever" },
  { id: "protections", label: "Protections" },
  { id: "faq", label: "FAQ" },
];

const pctOfBps = (bps: number) => f.fixed(bps / 100, bps % 100 === 0 ? 0 : bps % 10 === 0 ? 1 : 2);

export function HowItWorksView({ cluster }: { cluster: string | null }) {
  const p = useProtocolParams();
  const trigger = `${f.int(p.triggerMultiple)}×`;
  const claimPct = pctOfBps(p.claimBps);
  const maxClaimPct = pctOfBps(p.maxClaimPoolBps);
  const poolPct = f.fixed((p.rewardPoolSupply / p.totalSupply) * 100, 0);
  const fee = pctOfBps(p.feeBps);
  const venueFeeBps = (p.feeBps * p.venueFeeShareBps) / 10_000;
  const ourFee = pctOfBps(p.feeBps - venueFeeBps);
  const split = [p.feePoolShareBps, p.feePlatformShareBps, p.feeCreatorShareBps].map((b) => b / 100);
  const minSell = f.usdRule(p.minSellUsd);
  const hold = f.duration(p.minHoldSecs);
  const median = f.durationAdj(p.oracleWindowSecs);
  const challenge = f.duration(p.ticketChallengeSecs);
  const snipeOn = p.snipeWindowSlots > 0 && p.snipeStartBps > p.feeBps;
  const schedule = snipeOn ? Array.from({ length: p.snipeWindowSlots }, (_, d) => feeBpsAtSlot(p, d)) : [];
  const grad = p.graduationSol < 10 ? f.fixed(p.graduationSol, 2) : f.int(p.graduationSol);

  // Fumi's beats, in reading order (bubbles <= 8 words, no promises; numbers come from the same params as the text).
  const beats: Beat[] = [
    { pose: "pointing", say: "Sold too early? Same.", inline: true },
    { pose: "thumbsdown", say: `Under ${minSell}? Doesn't count.`, inline: true },
    { pose: "ticket", say: `${ATTEST_THRESHOLD} of ${KEEPERS} keepers sign it.`, inline: true },
    { pose: "shocked", say: `It held ${trigger}?!`, inline: true },
    { pose: "moneyeyes", say: "Claim time?" },
    { pose: "moneyeyes", say: "Fees refill the reward pool.", inline: true },
    { pose: "thinking", say: snipeOn ? "Snipers pay more. Hmm." : "No snipe window right now." },
    { pose: "cheering", say: "It graduated!", inline: true },
    { pose: "pointing", say: "Locked. Nobody can pull it." },
    { pose: "thinking", say: "Gaming it? Already thought of." },
    { pose: "thinking", say: "Still wondering?" },
  ];
  const beat = useActiveBeat();

  return (
    <DocPage
      title="How FUMPAD works"
      lede={
        <>
          FUMPAD is a Solana launchpad for people who sell too early. Trade FUMPAD coins anywhere: every sell over {minSell} counts. It files a ticket, and if
          the coin later holds {trigger} your sell price, you can claim {claimPct}% of what you sold back from the coin&apos;s reward pool.
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
      companion={<FumiCompanion beats={beats} active={beat} />}
    >
      <DocSection id="concept" title="The idea">
        <BeatMark beats={beats} i={0} />
        <p>
          Everyone has sold a coin that went on to do {trigger}. On FUMPAD that sell is on the record: every sell of {minSell} or more of a FUMPAD coin files a
          ticket at your sell price, whether you sold here or on {APPS}. Each coin carries its own reward pool: {poolPct}% of the supply set aside for it,
          plus buybacks from every trade&apos;s fee. When a ticket crosses {trigger}, its owner claims from that pool.
        </p>
        <p>
          It is a rebate on a specific regret, paid in the coin itself. It is not insurance, and it isn&apos;t guaranteed: a claim pays only while the
          coin&apos;s pool can cover it. See the <Link href="/risk">risk disclosure</Link>.
        </p>
      </DocSection>

      <DocSection id="tickets" title="Tickets">
        <BeatMark beats={beats} i={1} />
        <p>A sell files a ticket when all of these hold. If one doesn&apos;t, the sell still goes through, just without a ticket.</p>
        <Facts
          label="Ticket rules"
          rows={[
            { k: "Smallest sell that files a ticket", v: <span className="num">{minSell}</span> },
            { k: "Where", v: "FUMPAD or any other app, on the coin's own pools" },
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
          <b>Rebuys.</b> Buying the same coin back within {f.duration(p.rebuyWindowSecs)} of a sell, on any app, shrinks that ticket by the amount you
          bought, newest ticket first. Buy it all back and the ticket is void. A buy and a sell in the same transaction never files anything.
        </p>
      </DocSection>

      <DocSection id="verify" title="How a sell becomes a ticket">
        <BeatMark beats={beats} i={2} />
        <p>
          Most trades don&apos;t go through FUMPAD, so the tickets don&apos;t come from our app. FUMPAD runs {KEEPERS} independent keepers, each on its own
          machine and its own Solana RPC. Each one reads every finalized trade on a FUMPAD coin&apos;s pools, from every app, re-derives the ticket with the
          same public rules (hold time, rebuys, floor price, the SOL/USD price at the time of the sell) and signs it. When {ATTEST_THRESHOLD} of {KEEPERS}{" "}
          signatures agree, the ticket is created on chain, usually within {f.duration(p.attestDelaySecs)} of your sell. Sells through FUMPAD go the same way.
        </p>
        <p>
          A new ticket then sits in a <b>{challenge} challenge window</b>. A public watcher re-checks every attestation against the chain, and if one is
          wrong, the guardian can void it in that window. The ticket counts toward {trigger} the whole time; it just can&apos;t be claimed before the window
          ends. My fumbles shows it as <i>Verifying</i>, then <i>Challenge window</i> with the time claims open.
        </p>
        <Facts
          label="Verification"
          rows={[
            { k: "Signatures needed", v: <span className="num">{ATTEST_THRESHOLD} of {KEEPERS} keepers</span> },
            { k: "Typical time to a ticket", v: <span className="num">~{f.duration(p.attestDelaySecs)}</span> },
            { k: "Challenge window before claims", v: <span className="num">{challenge}</span> },
            { k: "Ticket rent", v: "paid by the keeper, not you" },
          ]}
        />
      </DocSection>

      <DocSection id="claims" title="Claims and the 10× median">
        <BeatMark beats={beats} i={3} />
        <p>
          A ticket is claimable once the coin has graduated, its challenge window has passed, and its <b>{median} median price</b> holds at {trigger} your
          ticket price or more. A median over many keeper samples, not a single trade, so a one-block spike doesn&apos;t count.
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
          <BeatSpot i={4} />
          If the claim fits the pool, it pays in the same transaction. If it doesn&apos;t, it joins the coin&apos;s claim queue, ordered by sell time; smaller
          claims that fit can skip ahead. Queued claims don&apos;t expire and are never paid in part. Claims are made for you by default (auto-claim, to
          your own wallet only); you can turn that off per coin in <Link href="/fumbles">My fumbles</Link>. If your wallet can&apos;t receive the payout, it
          waits in an escrow only you can withdraw.
        </p>
      </DocSection>

      <DocSection id="fees" title="Fees & rewards">
        <BeatMark beats={beats} i={5} />
        <p>
          Every trade on a FUMPAD coin&apos;s pools pays a {fee}% fee in SOL, on any app, before and after graduation. Meteora, which runs the pools, keeps{" "}
          {pctOfBps(venueFeeBps)}%. FUMPAD&apos;s {ourFee}% splits {split[0]} / {split[1]} / {split[2]}:
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
          The pool&apos;s share buys the coin back into its reward pool. After graduation the locked liquidity earns the same fee on all volume, and FUMPAD
          splits it the same way. There is no extra fee for trading through FUMPAD.
        </p>
        <Facts
          label="Fee numbers"
          rows={[
            { k: "Pool fee, every trade, any app", v: <span className="num">{fee}%</span> },
            { k: "Of which Meteora", v: <span className="num">{pctOfBps(venueFeeBps)}%</span> },
            { k: "Of which FUMPAD (pool / FUMPAD / creator)", v: <span className="num">{ourFee}%</span> },
            { k: "Reward pool at graduation", v: <span className="num">{poolPct}% of supply</span> },
          ]}
        />
      </DocSection>

      <DocSection id="snipe" title="Snipe protection">
        <BeatMark beats={beats} i={6} />
        {schedule.length ? (
          <>
            <p>
              Trades in the first {f.int(p.snipeWindowSlots)} slots after launch (about {f.fixed(p.snipeWindowSlots * SLOT_SECS, 1)} seconds) pay a higher
              fee, buys and sells alike, falling slot by slot from {pctOfBps(p.snipeStartBps)}% to the normal {fee}%. FUMPAD&apos;s whole share of those fees
              goes to the coin&apos;s reward pool, so a sniper funds the people who sell later.
            </p>
            <figure className={s.figure}>
              <ul className={s.steps} aria-label="Fee by slot after launch">
                {schedule.map((bps, d) => (
                  <li key={d}>
                    <span>{d === 0 ? "Launch slot" : `Slot +${d}`}</span>
                    <span className={s.bar} aria-hidden="true">
                      <i style={{ width: `${bps / 100}%` }} />
                    </span>
                    <span className="num">{pctOfBps(Math.round(bps))}%</span>
                  </li>
                ))}
                <li>
                  <span>Slot +{schedule.length}</span>
                  <span className={s.bar} aria-hidden="true">
                    <i style={{ width: `${p.feeBps / 100}%` }} />
                  </span>
                  <span className="num">{fee}%</span>
                </li>
              </ul>
              <figcaption>Fee as a share of the trade. From slot +{schedule.length}, trades pay the normal {fee}%.</figcaption>
            </figure>
            <p>
              <b>Creators:</b> your first buy gets the normal fee; snipers pay up to {pctOfBps(p.snipeStartBps)}%. The buy rides in the launch transaction as
              the pool&apos;s very first trade, so nobody gets in ahead of you. Every other wallet pays the window fee, including any the creator runs.
            </p>
          </>
        ) : (
          <p>Snipe protection is switched off for new launches right now: trades pay only the {fee}% fee from the first slot.</p>
        )}
        <p>
          <b>One exception:</b> FUMPAD&apos;s first coin launched on a one-off config that charges 3% per trade, before and after graduation (99% falling to
          3% over its first ~10 s). Meteora keeps a fifth; of FUMPAD&apos;s 2.4%, 1% buys the coin into its reward pool and 1.4% goes to a designated wallet,
          which also gets FUMPAD&apos;s share of that coin&apos;s launch-window fees. That config takes one coin only and leaves the allow-list after it. Each coin&apos;s page shows its own fee.
        </p>
      </DocSection>

      <DocSection id="graduation" title="Graduation">
        <BeatMark beats={beats} i={7} />
        <p>
          Every coin launches on a Meteora Dynamic Bonding Curve with FUMPAD&apos;s settings, and trades on any app from its first block. When the curve has
          raised {grad} SOL it completes: the last buy is filled only up to the end and the rest of its SOL stays in the buyer&apos;s wallet. The coin then
          moves to a Meteora DAMM v2 pool at the curve&apos;s final price. Anyone can trigger that, and Meteora&apos;s own keepers usually do within moments.
        </p>
        <p>
          At graduation the {poolPct}% set aside for the reward pool lands in it, and claims open.
          {p.graduationFeeSol > 0 && (
            <>
              {" "}
              Meteora&apos;s migration fee (about {f.fixed(p.graduationFeeSol, 2)} SOL) goes to FUMPAD and pays the setup rent for the coin&apos;s claim queue
              and price samples.
            </>
          )}{" "}
          Sells on the curve file tickets too. They count toward {trigger} straight away and become claimable once the coin graduates.
        </p>
      </DocSection>

      <DocSection id="lp" title="Liquidity locked forever">
        <BeatMark beats={beats} i={8} />
        <p>
          At graduation the pool&apos;s whole liquidity position is permanently locked by Meteora&apos;s program and owned by a FUMPAD account that can only
          claim its trading fees. Nobody can withdraw the liquidity, including FUMPAD and the creator. The lock lives in Meteora&apos;s programs, which their
          team can upgrade; see the <Link href="/risk#meteora">risk disclosure</Link>.
        </p>
      </DocSection>

      <DocSection id="protections" title="Protections">
        <BeatMark beats={beats} i={9} />
        <ul>
          <li>
            <b>Hold time.</b> Tokens must sit in your wallet for {hold} before a sell of them counts, measured on chain across every app and transfer, so
            buy-and-dump files nothing.
          </li>
          <li>
            <b>Recent-average floor.</b> Tickets are priced at your fill or the recent average, whichever is higher.
          </li>
          <li>
            <b>Rebuy rule.</b> Buying back within {f.duration(p.rebuyWindowSecs)}, anywhere, shrinks or voids your ticket.
          </li>
          <li>
            <b>Two-of-three attestation.</b> No single keeper can create a ticket, and every ticket waits out a {challenge} challenge window, watched by a
            public checker.
          </li>
          <li>
            <b>Only FUMPAD&apos;s pools.</b> Sells count on the coin&apos;s own curve and its graduated pool. Pools other people open for the coin don&apos;t.
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
            <b>Delayed rule changes.</b> Protocol parameter changes wait {TIMELOCK_HOURS} hour before they apply (admin key changes wait {ADMIN_TIMELOCK_HOURS}{" "}
            hours), and the fee split and reward terms are fixed per coin at launch.
          </li>
        </ul>
      </DocSection>

      <DocSection id="faq" title="FAQ">
        <BeatMark beats={beats} i={10} />
        <div className={s.faq}>
          <Faq q="Is this insurance?">
            <p>
              No. A ticket is a conditional claim on one coin&apos;s reward pool. If the coin never holds {trigger}, or the pool can&apos;t cover the claim,
              nothing is paid.
            </p>
          </Faq>
          <Faq q="Do sells on other apps count?">
            <p>
              Yes. A sell of {minSell} or more on {APPS} or any app that trades the coin&apos;s Meteora pools files a ticket like a sell here. Naming an app
              isn&apos;t an endorsement: FUMPAD isn&apos;t affiliated with them, and their own fees apply.
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
              {f.int(p.maxOpenTickets)} open tickets on that coin, you created the coin, you bought and sold in the same transaction, the sell went through a
              pool FUMPAD didn&apos;t create, or it came from a program-controlled wallet whose seller can&apos;t be told apart. A sell that qualifies shows up
              in My fumbles within a few minutes.
            </p>
          </Faq>
          <Faq q="Do I have to claim myself?">
            <p>
              No. Auto-claim is on by default: FUMPAD&apos;s keeper claims as soon as a ticket qualifies, and the tokens can only go to your wallet. You can
              claim by hand too, or switch auto-claim off per coin.
            </p>
          </Faq>
          <Faq q="What does a ticket cost?">
            <p>Nothing on top of the {fee}% pool fee every trade pays. The keepers pay the ticket&apos;s account rent.</p>
          </Faq>
          <Faq q="Can FUMPAD change the rules on my coin?">
            <p>
              The fee split and reward terms are fixed per coin at launch. Other parameter changes wait {TIMELOCK_HOURS} hour before they apply. Locked
              liquidity can&apos;t be withdrawn by anyone. FUMPAD can pause launches, buys through its app, attestations or claims in an emergency; selling
              on Meteora is never paused by FUMPAD. Meteora controls its own programs and pools, as the <Link href="/risk#meteora">risk page</Link>{" "}
              explains.
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
