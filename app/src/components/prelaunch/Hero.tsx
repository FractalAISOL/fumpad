"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { r1, HERO_CROSS, HERO_EXAMPLE, HERO_SELL, clamp, ease, fix, heroPrice, int, lerp, prog, sample, smooth } from "./math";
import s from "./Hero.module.css";

/**
 * The hero: scene 1 of the explainer, driven by scroll. A sticky stage holds a log chart in
 * multiples of your sell price. Scrolling draws: your sell (ring) → the run you missed
 * (dotted) → the 10× line → on FUMPAD, a ticket prints, the 10× crossing turns orange, and
 * 10% of what you sold comes back. Every frame is a pure function of scroll progress
 * (`draw(p)`), applied straight to the DOM in one rAF, so React never re-renders on scroll.
 * Reduced motion: no pin, the final frame, and the story as a list.
 */

const BEATS = [
  { at: 0.07, head: "You sold.", sub: `${int(HERO_EXAMPLE.tokens)} ${HERO_EXAMPLE.symbol} at ${HERO_EXAMPLE.price.toFixed(8)} SOL. Felt smart at the time.` },
  { at: 0.2, head: "Then it did 14×.", sub: "Of course it did." },
  { at: 0.42, head: "Anywhere else, that’s it.", sub: "All you keep is the screenshot." },
  { at: 0.54, head: "On FUMPAD, your sell filed a ticket.", sub: "Every sell of $50 or more gets one, on-chain." },
  { at: 0.7, head: "It held 10×. You claim 10% of what you sold.", sub: `${int(HERO_EXAMPLE.tokens / 10)} ${HERO_EXAMPLE.symbol}, paid from the coin’s own reward pool.`, money: true },
  { at: 0.86, head: "Sold too early. Officially.", sub: "Example coin and numbers.", big: true },
] as const;

const LO = Math.log(0.42);
const HI = Math.log(34);

interface Geo {
  w: number;
  h: number;
  x0: number;
  x1: number;
  top: number;
  bot: number;
  compact: boolean;
  /** Scale for strokes, marks and labels: 1 at ~1400 px wide, up to 1.9 on a 4K screen. */
  u: number;
}

function geometry(w: number, h: number): Geo {
  const compact = w < 700;
  return { w, h, compact, u: compact ? 1 : clamp(w / 1360, 0.9, 1.9), x0: 0, x1: w - (compact ? 40 : 72), top: compact ? 16 : 28, bot: h - (compact ? 10 : 18) };
}

export function Hero() {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geo>(() => geometry(1200, 560));
  const [reduced, setReduced] = useState(false);

  // Measure the chart box.
  useLayoutEffect(() => {
    const el = plot.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) setGeo((g) => (Math.abs(g.w - width) < 1 && Math.abs(g.h - height) < 1 ? g : geometry(width, height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // The history gets 40% of the width (it's all there is before the sell); the run the rest.
  const SPLIT = geo.compact ? 0.36 : 0.4;
  const X = (x: number) => r1(lerp(geo.x0, geo.x1, x <= HERO_SELL ? (x / HERO_SELL) * SPLIT : SPLIT + ((x - HERO_SELL) / (1 - HERO_SELL)) * (1 - SPLIT)));
  const Y = (m: number) => r1(geo.top + (1 - (Math.log(m) - LO) / (HI - LO)) * (geo.bot - geo.top));
  const pt = (x: number): [number, number] => [X(x), Y(heroPrice(x))];
  const history = smooth(sample(pt, 0, HERO_SELL, 70));
  const run = smooth(sample(pt, HERO_SELL, 1, 150));
  const [sx, sy] = pt(HERO_SELL);
  const crossX = X(HERO_CROSS);
  const ten = Y(10);

  // The frame function and the scroll loop.
  useEffect(() => {
    const el = root.current;
    const st = stage.current;
    if (!el || !st) return;
    const q = <T extends Element>(sel: string) => st.querySelector(sel) as T;
    const parts = {
      intro: q<HTMLElement>("[data-intro]"),
      histClip: q<SVGRectElement>("[data-hist-clip]"),
      runClip: q<SVGRectElement>("[data-run-clip]"),
      ring: q<SVGCircleElement>("[data-ring]"),
      ringLbl: q<SVGTextElement>("[data-ring-lbl]"),
      head: q<SVGGElement>("[data-head]"),
      tag: q<SVGTextElement>("[data-tag]"),
      axis: q<SVGGElement>("[data-axis]"),
      tenLine: q<SVGLineElement>("[data-ten]"),
      tenLbl: q<SVGGElement>("[data-ten-lbl]"),
      zone: q<SVGRectElement>("[data-zone]"),
      dot: q<SVGCircleElement>("[data-dot]"),
      chart: q<SVGGElement>("[data-chart]"),
      readout: q<HTMLElement>("[data-readout]"),
      roNum: q<HTMLElement>("[data-ro-num]"),
      roLbl: q<HTMLElement>("[data-ro-lbl]"),
      ticket: q<HTMLElement>("[data-ticket]"),
      claim: q<HTMLElement>("[data-claim]"),
      amount: q<HTMLElement>("[data-amount]"),
      needle: q<HTMLElement>("[data-needle]"),
      fill: q<HTMLElement>("[data-fill]"),
      rail: q<HTMLElement>("[data-rail]"),
      cue: q<HTMLElement>("[data-cue]"),
    };
    const op = (e: Element | null, v: number) => e && ((e as HTMLElement).style.opacity = v.toFixed(3));
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let loadT0 = performance.now();
    let raf = 0;
    let visible = true;
    let lastBeat = -2;

    const progress = () => {
      if (mq.matches) return 1;
      const r = el.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      return span > 0 ? clamp(-r.top / span) : 0;
    };

    const draw = (p: number, now: number) => {
      const load = mq.matches ? 1 : ease.out(clamp((now - loadT0) / 1400));
      // Intro headline leaves as the story starts.
      const out = mq.matches ? 0 : prog(p, 0.03, 0.09, ease.out);
      if (parts.intro) {
        parts.intro.style.opacity = (1 - out).toFixed(3);
        parts.intro.style.transform = `translate3d(0, ${(-36 * out).toFixed(1)}px, 0)`;
        parts.intro.style.visibility = out >= 1 ? "hidden" : "visible";
      }
      op(parts.cue, 1 - prog(p, 0.0, 0.03));
      // History draws in on load; the run is revealed by scroll.
      const hk = load;
      parts.histClip.setAttribute("width", Math.max(0, lerp(0, sx - geo.x0 + 2, hk)).toFixed(1));
      const rk = prog(p, 0.2, 0.4, ease.inOut);
      const runX = lerp(HERO_SELL, 1, rk);
      parts.runClip.setAttribute("x", (sx - 1).toFixed(1));
      parts.runClip.setAttribute("width", Math.max(0, X(runX) - sx + 2).toFixed(1));
      // The live head: sits at the sell point and breathes until you sell.
      const sold = prog(p, 0.07, 0.11, ease.out);
      const headX = rk > 0 ? runX : HERO_SELL;
      const wig = rk > 0 ? 1 : 1 + 0.035 * Math.sin(now / 420) * (1 - sold) + 0.02 * Math.sin(now / 157) * (1 - sold);
      const hx = X(headX);
      const hy = Y(heroPrice(headX) * wig);
      parts.head.setAttribute("transform", `translate(${hx.toFixed(1)} ${hy.toFixed(1)})`);
      op(parts.head, hk >= 1 ? 1 : 0);
      op(parts.tag, (1 - sold) * (hk >= 1 ? 1 : 0));
      if (parts.tag) parts.tag.textContent = `${(HERO_EXAMPLE.price * wig).toFixed(8)} SOL`;
      // Ring: your sell.
      parts.ring.setAttribute("r", ((geo.compact ? 8 : 11 * geo.u) * ease.stamp(sold)).toFixed(2));
      op(parts.ringLbl, prog(p, 0.09, 0.12));
      op(parts.axis, sold);
      // 10× line, then the dim of "anywhere else".
      const tk = prog(p, 0.42, 0.47, ease.out);
      parts.tenLine.setAttribute("x2", lerp(geo.x0, geo.x1, tk).toFixed(1));
      op(parts.tenLbl, tk);
      const dim = prog(p, 0.43, 0.47, ease.out) * (1 - prog(p, 0.53, 0.57, ease.out));
      op(parts.chart, 1 - 0.62 * dim);
      // FUMPAD: money switches on.
      const money = prog(p, 0.57, 0.61, ease.out);
      const flare = money > 0.5;
      op(parts.zone, money);
      st.dataset.money = flare ? "1" : "0";
      parts.dot.setAttribute("r", ((geo.compact ? 6 : 9 * geo.u) * ease.stamp(prog(p, 0.58, 0.62))).toFixed(2));
      // Readout: the head relative to the sell.
      const head = rk > 0 ? heroPrice(runX) / heroPrice(HERO_SELL) : 1;
      op(parts.readout, prog(p, 0.18, 0.22));
      parts.roNum.textContent = `${fix(Math.max(1, head), 1)}×`;
      parts.roLbl.textContent = p < 0.42 ? "since your sell" : p < 0.54 ? "and you got nothing" : "your ticket, right now";
      // Ticket prints, then the claim row.
      const pk = prog(p, 0.56, 0.64, ease.out);
      const ck = prog(p, 0.71, 0.77, ease.out);
      const split = parts.claim.offsetTop / Math.max(1, parts.ticket.offsetHeight);
      const shown = lerp(0, split, pk) + (1 - split) * ck;
      parts.ticket.style.clipPath = `inset(0 0 ${((1 - shown) * 100).toFixed(2)}% 0)`;
      parts.ticket.style.visibility = pk > 0 ? "visible" : "hidden";
      parts.ticket.style.transform = `translate3d(0, ${(10 * (1 - pk)).toFixed(1)}px, 0)`;
      op(parts.claim, ck);
      parts.amount.textContent = `+${int((HERO_EXAMPLE.tokens / 10) * prog(p, 0.73, 0.82, ease.out))} ${HERO_EXAMPLE.symbol}`;
      // The ticket's mini gauge follows the readout (log 1–30×, 10× post).
      const gp = clamp(Math.log(Math.max(1, head)) / Math.log(30));
      parts.needle.style.transform = `translateX(${(gp * 100).toFixed(2)}cqw)`;
      parts.fill.style.transform = `scaleX(${gp.toFixed(4)})`;
      // Beats.
      let beat = -1;
      BEATS.forEach((b, i) => p >= b.at && (beat = i));
      if (beat !== lastBeat) {
        st.dataset.beat = String(beat);
        lastBeat = beat;
      }
      parts.rail.style.transform = `scaleY(${p.toFixed(4)})`;
    };

    const tick = (now: number) => {
      raf = 0;
      if (!visible) return;
      draw(progress(), now);
      // Keep animating while the intro loads or the live head breathes (before the sell).
      if (now - loadT0 < 1500 || progress() < 0.11) raf = requestAnimationFrame(tick);
    };
    const kick = () => {
      if (!raf && visible) raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      kick();
    });
    io.observe(el);
    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", kick);
    const onMq = () => {
      loadT0 = performance.now();
      kick();
    };
    mq.addEventListener("change", onMq);
    kick();
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", kick);
      window.removeEventListener("resize", kick);
      mq.removeEventListener("change", onMq);
      cancelAnimationFrame(raf);
    };
    // Geometry changes rebuild the frame function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, reduced]);

  const r = geo.compact ? 8 : 11 * geo.u;
  const axisFont = geo.compact ? 11 : 13 * geo.u;

  return (
    <section ref={root} className={s.hero} aria-labelledby="hero-title">
      <div ref={stage} className={s.stage} data-beat="-1" data-money="0">
        <div className={s.intro} data-intro>
          <h1 id="hero-title" className={s.title}>
            The launchpad for people who sell too early.
          </h1>
          <p className={s.lede}>
            Sell a FUMPAD coin, here or on any app. If it later holds 10× your sell price, you claim 10% of the tokens you sold.
          </p>
        </div>

        <div className={s.readout} data-readout aria-hidden="true">
          <span className={s.roNum} data-ro-num>
            1.0×
          </span>
          <span className={s.roLbl} data-ro-lbl>
            since your sell
          </span>
        </div>

        <div className={s.ticket} data-ticket style={{ visibility: "hidden" }} aria-hidden="true">
          <div className={s.tHead}>
            <span className={s.tTitle}>Fumble ticket</span>
            <span className={s.tNo}>#0412</span>
          </div>
          <div className={s.tTokens}>
            {int(HERO_EXAMPLE.tokens)} {HERO_EXAMPLE.symbol}
          </div>
          <div className={s.tPrice}>sold at {HERO_EXAMPLE.price.toFixed(8)} SOL</div>
          <div className={s.tGauge}>
            <div className={s.tTrack}>
              <div className={s.tFill} data-fill />
              <div className={s.tPost} />
              <div className={s.tNeedle} data-needle />
            </div>
            <div className={s.tScale}>
              <span>1×</span>
              <span className={s.tTen}>10×</span>
              <span>30×</span>
            </div>
          </div>
          <div className={s.tClaim} data-claim style={{ opacity: 0 }}>
            <div className={s.tClaimHead}>
              <span>Claim unlocked</span>
              <span className={s.tBack}>10% back</span>
            </div>
            <div className={s.tAmount} data-amount>
              +0 {HERO_EXAMPLE.symbol}
            </div>
            <div className={s.tStub}>Admit one fumble.</div>
          </div>
        </div>

        <div className={s.plot} ref={plot}>
          <svg className={s.svg} width={geo.w} height={geo.h} viewBox={`0 0 ${geo.w} ${geo.h}`} role="img" aria-labelledby="hero-chart-title">
            <title id="hero-chart-title">
              Example chart: a coin you sold at 1× runs to 14× your price and holds above 10×. On FUMPAD your sell filed a ticket, so you claim 10% of the tokens you sold.
            </title>
            <defs>
              <pattern id="hero-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="2" height="7" fill="var(--flare)" opacity="0.4" />
              </pattern>
              <clipPath id="hero-hist">
                <rect data-hist-clip x={geo.x0 - 2} y={0} width={0} height={geo.h} />
              </clipPath>
              <clipPath id="hero-run">
                <rect data-run-clip x={sx} y={0} width={0} height={geo.h} />
              </clipPath>
            </defs>
            <g data-chart>
              <g data-axis className={s.axis} style={{ opacity: 0 }}>
                {[1, 3].map((m) => (
                  <g key={m}>
                    <line x1={geo.x0} x2={geo.w} y1={Y(m)} y2={Y(m)} className={s.grid} />
                    <text x={geo.w} y={Y(m) - 6} textAnchor="end" className={s.axisText} fontSize={axisFont}>
                      {m}×
                    </text>
                  </g>
                ))}
              </g>
              <rect data-zone x={geo.x0} y={geo.top - 8} width={geo.x1 - geo.x0} height={Math.max(0, ten - geo.top + 8)} fill="url(#hero-hatch)" style={{ opacity: 0 }} />
              <path d={history} className={s.line} clipPath="url(#hero-hist)" style={geo.compact ? undefined : { strokeWidth: 3.5 * geo.u }} />
              <path d={run} className={s.run} clipPath="url(#hero-run)" style={geo.compact ? undefined : { strokeWidth: 3.5 * geo.u, strokeDasharray: `0.1 ${11 * geo.u}` }} />
            </g>
            <line data-ten x1={geo.x0} x2={geo.x0} y1={ten} y2={ten} className={s.ten} style={geo.compact ? undefined : { strokeWidth: 2 * geo.u, strokeDasharray: `${6 * geo.u} ${5 * geo.u}` }} />
            <g data-ten-lbl style={{ opacity: 0 }}>
              <text x={geo.w} y={ten + 5} textAnchor="end" className={s.tenText} fontSize={axisFont + 1}>
                10×
              </text>
              <text x={crossX - (geo.compact ? 12 : 18 * geo.u)} y={ten - (geo.compact ? 10 : 14 * geo.u)} textAnchor="end" className={s.tenNote} fontSize={geo.compact ? 12 : 15 * geo.u}>
                10× your sell price
              </text>
            </g>
            <circle data-ring cx={sx} cy={sy} r={0} className={s.ring} strokeWidth={geo.compact ? 3 : 3.5 * geo.u} />
            <text data-ring-lbl x={sx} y={sy + r + (geo.compact ? 20 : 28 * geo.u)} textAnchor="middle" className={s.ringText} fontSize={geo.compact ? 12 : 15 * geo.u} style={{ opacity: 0 }}>
              your sell
            </text>
            <circle data-dot cx={crossX} cy={ten} r={0} className={s.dot} />
            <g data-head style={{ opacity: 0 }}>
              <circle r={geo.compact ? 4 : 5 * geo.u} className={s.headDot} />
              <circle r={geo.compact ? 4 : 5 * geo.u} className={s.headPulse} />
              <text data-tag x={geo.compact ? -10 : -14} y={geo.compact ? -14 : -18} textAnchor="end" className={s.tag} fontSize={geo.compact ? 11 : 13 * geo.u}>
                0.00000080 SOL
              </text>
            </g>
          </svg>

        </div>

        <div className={s.captions} aria-live="off">
          {BEATS.map((b, i) => (
            <div key={i} className={s.caption} data-i={i} data-money={"money" in b && b.money ? "1" : undefined} data-big={"big" in b && b.big ? "1" : undefined}>
              <p className={s.capHead}>{b.head}</p>
              <p className={s.capSub}>{b.sub}</p>
            </div>
          ))}
        </div>

        <ol className={s.story}>
          {BEATS.map((b, i) => (
            <li key={i}>
              <strong>{b.head}</strong> {b.sub}
            </li>
          ))}
        </ol>

        <div className={s.railWrap} aria-hidden="true">
          <div className={s.railTrack}>
            <div className={s.railFill} data-rail />
          </div>
          {BEATS.map((b, i) => (
            <span key={i} className={s.railTick} style={{ top: `${b.at * 100}%` }} />
          ))}
        </div>

        <div className={s.cue} data-cue aria-hidden="true">
          <span>Scroll to watch a fumble</span>
          <span className={s.cueLine} />
        </div>
      </div>
    </section>
  );
}
