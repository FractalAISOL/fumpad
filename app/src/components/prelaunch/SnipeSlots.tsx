"use client";

import { useState } from "react";
import s from "./Sections.module.css";

/**
 * The launch-window fee by slot (SPEC v0.7 D33: Meteora's fee scheduler, 99% falling linearly to
 * the normal 1.25% over 8 slots, buys and sells alike). A radio group: hover, tap or arrow
 * through the slots; the sentence says what a 1 SOL trade pays there.
 */
const NORMAL = 1.25;
const SLOTS = [
  ...Array.from({ length: 8 }, (_, d) => ({ slot: String(d), time: `${(d * 0.4).toFixed(1).replace(".0", "")} s`, tax: 99 - (d * (99 - NORMAL)) / 8 })),
  { slot: "8+", time: "3.2 s+", tax: 0 },
];

export function SnipeSlots() {
  const [i, setI] = useState(1);
  const cur = SLOTS[i];
  const toPool = cur.tax / 100;
  return (
    <div className={s.snipe}>
      <div className={s.slots} role="radiogroup" aria-label="Launch slot">
        {SLOTS.map((x, k) => (
          <button
            key={x.slot}
            type="button"
            role="radio"
            aria-checked={k === i}
            tabIndex={k === i ? 0 : -1}
            className={s.slot}
            data-on={k === i ? "1" : undefined}
            onMouseEnter={() => setI(k)}
            onFocus={() => setI(k)}
            onClick={() => setI(k)}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const n = (k + d + SLOTS.length) % SLOTS.length;
              setI(n);
              (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
            }}
          >
            <span className={s.slotBarWrap}>
              <span className={s.slotBar} style={{ transform: `scaleY(${Math.max(x.tax, 1) / 100})` }} />
            </span>
            <span className={s.slotTax}>{x.tax ? `${Math.round(x.tax)}%` : `${NORMAL}%`}</span>
            <span className={s.slotName}>
              <span className="sr-only">Slot </span>
              {x.slot}
            </span>
            <span className={s.slotTime}>{x.time}</span>
          </button>
        ))}
      </div>
      <p className={s.snipeSay} aria-live="polite">
        {cur.tax ? (
          <>
            A 1 SOL buy in slot {cur.slot} pays <b>{toPool.toFixed(2)} SOL</b> in fees, and FUMPAD&rsquo;s share of it goes to the coin&rsquo;s reward pool;{" "}
            {(1 - toPool).toFixed(2)} SOL buys the coin.
          </>
        ) : (
          <>From the ninth slot on, trades pay the normal {NORMAL}% fee. The window is over in about 3 seconds.</>
        )}
      </p>
    </div>
  );
}
