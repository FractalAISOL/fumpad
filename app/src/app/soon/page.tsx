import { Hero } from "@/components/prelaunch/Hero";
import { Launch } from "@/components/prelaunch/Launch";
import { PoolFill } from "@/components/prelaunch/PoolFill";
import { Reveal } from "@/components/prelaunch/Reveal";
import { SellLab } from "@/components/prelaunch/SellLab";
import { SnipeSlots } from "@/components/prelaunch/SnipeSlots";
import { TicketGauge } from "@/components/prelaunch/TicketGauge";
import s from "@/components/prelaunch/Sections.module.css";
import t from "@/components/prelaunch/Ticket.module.css";

/**
 * FUMPAD's pre-launch waiting room. On fumpad.app this is `/` (and every other path redirects
 * here) until NEXT_PUBLIC_PRELAUNCH=off; see app/LAUNCH.md. Every number on it is an example.
 */
export default function WaitingRoom() {
  return (
    <>
      <Hero />

      <section className={s.sec} aria-labelledby="lab-title">
        <div className={s.wrap}>
          <header className={s.head}>
            <h2 id="lab-title" className={s.h2}>
              Pick your worst sell.
            </h2>
            <p className={s.lede}>
              Drag the ring along this coin&rsquo;s first 48 hours. The 10× line moves with your price, and the result says what your ticket would pay.
            </p>
          </header>
          <div className={s.body}>
            <SellLab />
          </div>
        </div>
      </section>

      <section className={s.sec} aria-labelledby="ticket-title">
        <div className={s.wrap}>
          <header className={s.head}>
            <h2 id="ticket-title" className={s.h2}>
              Your sell files a ticket.
            </h2>
            <p className={s.lede}>
              A record on Solana of how many tokens you sold, at what price, and when. It watches the coin for 90 days, and the keeper claims for you when it pays.
            </p>
          </header>
          <div className={s.body}>
            <Reveal className={t.ticket}>
              <div className={t.main}>
                <div className={t.row}>
                  <span className={t.title}>Fumble ticket</span>
                  <span className={t.no}>#0412 open</span>
                </div>
                <dl className={t.fields}>
                  <div>
                    <dt>Tokens</dt>
                    <dd>2,400,000 PIGN</dd>
                  </div>
                  <div>
                    <dt>Ticket price</dt>
                    <dd>0.00000080 SOL</dd>
                  </div>
                  <div>
                    <dt>Pays at</dt>
                    <dd>0.0000080 SOL</dd>
                  </div>
                  <div>
                    <dt>Claim</dt>
                    <dd>240,000 PIGN</dd>
                  </div>
                  <div>
                    <dt>Filed</dt>
                    <dd>Oct 12, 14:02</dd>
                  </div>
                  <div>
                    <dt>Window</dt>
                    <dd>90 days</dd>
                  </div>
                </dl>
              </div>
              <div className={t.stub} aria-hidden="true">
                <span className={t.stubBig}>10×</span>
                <span className={t.stubSmall}>Admit one fumble.</span>
              </div>
            </Reveal>
            <TicketGauge />
            <dl className={s.rules}>
              <div>
                <dt>Who gets one</dt>
                <dd>Any sell of $50 or more through FUMPAD, of tokens that have been in your wallet for 10 minutes.</dd>
              </div>
              <div>
                <dt>Ticket price</dt>
                <dd>Your fill, or the coin&rsquo;s 10-minute average price if that&rsquo;s higher.</dd>
              </div>
              <div>
                <dt>Pays at</dt>
                <dd>10× the ticket price, in SOL, on a 30-minute median of keeper samples.</dd>
              </div>
              <div>
                <dt>Claim</dt>
                <dd>10% of the tokens you sold. The count is fixed, so a higher price makes it worth more.</dd>
              </div>
              <div>
                <dt>When</dt>
                <dd>After the coin graduates, within 90 days of your sell. Claims waiting in the queue don&rsquo;t expire.</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <section className={s.sec} aria-labelledby="pool-title">
        <div className={s.wrap}>
          <header className={s.head}>
            <h2 id="pool-title" className={s.h2}>
              Every coin pays its own way.
            </h2>
            <p className={s.lede}>Claims come out of the coin&rsquo;s own reward pool, in the coin. Three things fill it.</p>
          </header>
          <div className={s.body}>
            <PoolFill />
            <div className={s.sources}>
              <div className={s.source}>
                <p className={s.sourceFig}>8%</p>
                <h3 className={s.h3}>of the supply, at launch</h3>
                <p>80,000,000 tokens are set aside before the first trade.</p>
              </div>
              <div className={s.source}>
                <p className={s.sourceFig}>50%</p>
                <h3 className={s.h3}>of every trading fee</h3>
                <p>Every FUMPAD trade pays 1%. Half of it buys the coin into its pool; 30% goes to FUMPAD and 20% to the creator.</p>
                <div className={s.split} role="img" aria-label="Fee split: 50% reward pool, 30% FUMPAD, 20% creator">
                  <span style={{ flexGrow: 50 }}>Pool 50</span>
                  <span style={{ flexGrow: 30 }}>FUMPAD 30</span>
                  <span style={{ flexGrow: 20 }}>Creator 20</span>
                </div>
              </div>
              <div className={s.source}>
                <p className={s.sourceFig}>0.20%</p>
                <h3 className={s.h3}>LP fee, after graduation</h3>
                <p>The locked liquidity earns on all volume, from any app. Its token half is skimmed into the pool.</p>
              </div>
            </div>
            <p className={s.notice}>
              <strong>Not insurance.</strong> Claims pay only while the coin&rsquo;s pool can cover them. When it can&rsquo;t yet, claims wait in line, oldest sell first.
            </p>
          </div>
        </div>
      </section>

      <section className={s.sec} aria-labelledby="snipe-title">
        <div className={s.wrap}>
          <header className={s.head}>
            <h2 id="snipe-title" className={s.h2}>
              Snipers fund the fumblers.
            </h2>
            <p className={s.lede}>
              Buys in the first four slots after a launch pay a snipe tax: 99%, then 75, 50 and 25. All of it goes to the coin&rsquo;s reward pool, not to FUMPAD or the creator.
            </p>
          </header>
          <div className={s.body}>
            <SnipeSlots />
            <p className={s.fine}>Sells are never taxed. The creator&rsquo;s own buy inside the launch transaction is exempt; every other wallet pays the schedule.</p>
          </div>
        </div>
      </section>

      <section className={s.sec} aria-labelledby="fair-title">
        <div className={s.wrap}>
          <header className={s.head}>
            <h2 id="fair-title" className={s.h2}>
              Fair by design.
            </h2>
            <p className={s.lede}>The obvious tricks don&rsquo;t pay. Tokens also need 10 minutes in your wallet before a sell counts.</p>
          </header>
          <Reveal className={`${s.body} ${s.fair}`}>
            <figure className={s.rule}>
              <svg viewBox="0 0 320 120" className={s.ruleArt} aria-hidden="true">
                <line x1="0" x2="320" y1="58" y2="58" className={s.artTen} />
                <text x="320" y="50" textAnchor="end" className={s.artLbl}>
                  10×
                </text>
                {Array.from({ length: 24 }, (_, i) => {
                  const spike = i === 7;
                  const y = spike ? 10 : 86 + 8 * Math.sin(i * 1.7);
                  return <circle key={i} cx={8 + i * 12.5} cy={y} r={spike ? 5 : 3.5} className={spike ? s.artSpike : s.artDot} style={{ transitionDelay: `${i * 25}ms` }} />;
                })}
                <text x="108" y="14" className={s.artLbl}>
                  one spike, one sample
                </text>
                <line x1="0" x2="300" y1="87" y2="87" className={s.artMedian} />
                <text x="0" y="114" className={s.artLbl}>
                  median 4.1×
                </text>
              </svg>
              <figcaption>
                <h3 className={s.h3}>A 3-second pump unlocks nothing.</h3>
                <p>Claims need the 30-minute median at 10×. One spike is one sample.</p>
              </figcaption>
            </figure>
            <figure className={s.rule}>
              <svg viewBox="0 0 320 120" className={s.ruleArt} aria-hidden="true">
                <text x="0" y="24" className={s.artLbl}>
                  your fill, after a staged dip
                </text>
                <rect x="0" y="34" width="110" height="16" className={s.artBarLo} />
                <text x="0" y="80" className={s.artLbl}>
                  10-minute average
                </text>
                <rect x="0" y="90" width="236" height="16" className={s.artBarHi} />
                <text x="244" y="103" className={s.artLblInk}>
                  ticket
                </text>
              </svg>
              <figcaption>
                <h3 className={s.h3}>A staged dip can&rsquo;t buy a cheap ticket.</h3>
                <p>Your ticket price is your fill or the 10-minute average, whichever is higher.</p>
              </figcaption>
            </figure>
            <figure className={s.rule}>
              <svg viewBox="0 0 320 120" className={s.ruleArt} aria-hidden="true">
                <text x="0" y="24" className={s.artLbl}>
                  ticket 2,400,000
                </text>
                <rect x="0" y="34" width="300" height="16" className={s.artBarHi} />
                <rect x="175" y="34" width="125" height="16" className={s.artCut} />
                <text x="0" y="78" className={s.artLbl}>
                  bought back 1,000,000 in 7 days
                </text>
                <rect x="0" y="90" width="175" height="16" className={s.artBarHi} />
                <text x="183" y="103" className={s.artLblInk}>
                  1,400,000
                </text>
              </svg>
              <figcaption>
                <h3 className={s.h3}>Buy back within 7 days and your ticket shrinks.</h3>
                <p>By exactly the amount you bought back. Sell, rebuy, repeat doesn&rsquo;t farm tickets.</p>
              </figcaption>
            </figure>
            <figure className={s.rule}>
              <svg viewBox="0 0 320 120" className={s.ruleArt} aria-hidden="true">
                <rect x="1" y="22" width="200" height="76" rx="8" className={s.artTicket} />
                <text x="18" y="52" className={s.artLblInk}>
                  Fumble ticket
                </text>
                <text x="18" y="78" className={s.artLbl}>
                  seller: the creator
                </text>
                <line x1="-4" y1="108" x2="206" y2="12" className={s.artStrike} />
                <text x="220" y="64" className={s.artLbl}>
                  never filed
                </text>
              </svg>
              <figcaption>
                <h3 className={s.h3}>Creators can&rsquo;t earn tickets.</h3>
                <p>A creator&rsquo;s sells never file one, on their own coin.</p>
              </figcaption>
            </figure>
          </Reveal>
        </div>
      </section>

      <section className={s.sec} aria-labelledby="lp-title">
        <div className={s.wrap}>
          <header className={s.head}>
            <h2 id="lp-title" className={s.h2}>
              Liquidity locked forever.
            </h2>
            <p className={s.lede}>
              At 85 SOL raised the coin graduates to PumpSwap, and every LP token goes into a locker. Nobody can pull it out, including us.
            </p>
          </header>
          <Reveal className={`${s.body} ${s.locker}`}>
            <div className={s.lockBox}>
              <svg viewBox="0 0 64 72" className={s.lockIcon} aria-hidden="true">
                <path d="M16 34 V22 a16 16 0 0 1 32 0 V34" className={s.shackle} />
                <rect x="6" y="32" width="52" height="38" rx="5" className={s.lockBody} />
              </svg>
              <p className={s.lockName}>The LP locker</p>
              <ul className={s.lockNo}>
                <li>No withdraw</li>
                <li>No admin</li>
                <li>No upgrades</li>
              </ul>
            </div>
            <div className={s.lockFlow}>
              <p className={s.lockOut}>Only trading fees come out</p>
              <div className={s.lockRows}>
                <div>
                  <span className={s.lockFig}>Tokens</span>
                  <span>to the coin&rsquo;s reward pool</span>
                </div>
                <div>
                  <span className={s.lockFig}>SOL</span>
                  <span>60% to FUMPAD, 40% to the creator</span>
                </div>
              </div>
              <p className={s.fine}>The liquidity can&rsquo;t be rugged. The coin can still go to zero: that&rsquo;s a memecoin.</p>
            </div>
          </Reveal>
        </div>
      </section>

      <section className={s.sec} aria-labelledby="creators-title">
        <div className={s.wrap}>
          <header className={s.head}>
            <h2 id="creators-title" className={s.h2}>
              For creators.
            </h2>
            <p className={s.lede}>Launch a coin in one transaction and earn on every trade, before and after graduation.</p>
          </header>
          <div className={s.body}>
            <dl className={s.creators}>
              <div>
                <dt>20%</dt>
                <dd>
                  <b>of every trading fee.</b> Claimable whenever you like.
                </dd>
              </div>
              <div>
                <dt>40%</dt>
                <dd>
                  <b>of the SOL from LP fees,</b> for as long as the graduated coin trades.
                </dd>
              </div>
              <div>
                <dt>0%</dt>
                <dd>
                  <b>snipe tax on your launch buy,</b> when it&rsquo;s in the launch transaction.
                </dd>
              </div>
              <div>
                <dt>fmbL</dt>
                <dd>
                  <b>at the end of every FUMPAD mint address,</b> so people can tell where a coin came from.
                </dd>
              </div>
            </dl>
            <p className={s.fine}>And one thing you don&rsquo;t get: tickets on your own coin.</p>
          </div>
        </div>
      </section>

      <section className={`${s.sec} ${s.secLaunch}`} aria-labelledby="launch-title">
        <div className={s.wrap}>
          <Launch />
        </div>
      </section>
    </>
  );
}
