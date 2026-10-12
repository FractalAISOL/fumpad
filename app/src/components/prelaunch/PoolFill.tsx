"use client";

import { useEffect, useRef } from "react";
import { clamp, ease, int, prog } from "./math";
import s from "./Sections.module.css";

/**
 * The reward pool filling from its three sources as the section scrolls past. The bar and the
 * total are written straight to the DOM (no re-render on scroll). Example numbers.
 */
const SEED = 80_000_000;
const FEES = 6_400_000;
const LP = 2_900_000;
const TOTAL = SEED + FEES + LP;

export function PoolFill() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const segs = [...el.querySelectorAll<HTMLElement>("[data-seg]")];
    const total = el.querySelector<HTMLElement>("[data-total]");
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    const draw = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // 0 when the bar enters the lower third, 1 when it reaches the upper third.
      const p = mq.matches ? 1 : clamp((vh * 0.85 - r.top) / (vh * 0.6));
      const k = [prog(p, 0, 0.3, ease.out), prog(p, 0.3, 0.65, ease.out), prog(p, 0.65, 1, ease.out)];
      segs.forEach((seg, i) => (seg.style.transform = `scaleX(${k[i].toFixed(4)})`));
      if (total) total.textContent = int(SEED * k[0] + FEES * k[1] + LP * k[2]);
      el.dataset.step = String(k.filter((v) => v > 0.5).length);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        window.addEventListener("scroll", kick, { passive: true });
        kick();
      } else window.removeEventListener("scroll", kick);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", kick);
      cancelAnimationFrame(raf);
    };
  }, []);

  const pct = (n: number) => `${((n / TOTAL) * 100).toFixed(3)}%`;
  return (
    <div ref={ref} className={s.pool} data-step="0">
      <div className={s.poolHead}>
        <span className={s.poolName}>PIGN reward pool</span>
        <span className={s.poolTotal}>
          <span data-total>{int(TOTAL)}</span> PIGN
        </span>
      </div>
      <div className={s.poolBar} role="img" aria-label={`Example reward pool: ${int(SEED)} from launch, ${int(FEES)} from fee buybacks, ${int(LP)} from LP fee skims.`}>
        <span className={s.poolSlot} style={{ width: pct(SEED) }}>
          <span data-seg className={s.segSeed} />
        </span>
        <span className={s.poolSlot} style={{ width: pct(FEES) }}>
          <span data-seg className={s.segFees} />
        </span>
        <span className={s.poolSlot} style={{ width: pct(LP) }}>
          <span data-seg className={s.segLp} />
        </span>
      </div>
      <div className={s.poolLegend} aria-hidden="true">
        <span>
          <i className={s.segSeed} /> At launch <b>{int(SEED)}</b>
        </span>
        <span>
          <i className={s.segFees} /> Fee buybacks <b>+{int(FEES)}</b>
        </span>
        <span>
          <i className={s.segLp} /> LP fee skims <b>+{int(LP)}</b>
        </span>
      </div>
    </div>
  );
}
