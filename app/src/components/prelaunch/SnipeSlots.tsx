"use client";

import { useState } from "react";
import s from "./Sections.module.css";

/**
 * Snipe tax by slot (SPEC §4.1: 99 / 75 / 50 / 25%, then the normal fee). A radio group:
 * hover, tap or arrow through the slots; the sentence says what a 1 SOL buy pays there.
 */
const SLOTS = [
  { slot: "0", time: "0 s", tax: 99 },
  { slot: "1", time: "0.4 s", tax: 75 },
  { slot: "2", time: "0.8 s", tax: 50 },
  { slot: "3", time: "1.2 s", tax: 25 },
  { slot: "4+", time: "1.6 s on", tax: 0 },
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
            <span className={s.slotTax}>{x.tax ? `${x.tax}%` : "1% fee"}</span>
            <span className={s.slotName}>Slot {x.slot}</span>
            <span className={s.slotTime}>{x.time}</span>
          </button>
        ))}
      </div>
      <p className={s.snipeSay} aria-live="polite">
        {cur.tax ? (
          <>
            A 1 SOL buy in slot {cur.slot}: <b>{toPool.toFixed(2)} SOL</b> goes to the coin&rsquo;s reward pool, {(1 - toPool).toFixed(2)} SOL buys the coin.
          </>
        ) : (
          <>From the fifth slot on, buys pay the normal 1% fee. The window is over in about 1.6 seconds.</>
        )}
      </p>
    </div>
  );
}
