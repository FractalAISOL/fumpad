"use client";

/**
 * Fumi as the How it works guide (anime kit, marketing/STYLE-ANIME.md). One Fumi per screen:
 *  - from 1200 px, a sticky companion right of the text that switches pose as the reader reaches each beat;
 *  - below 1200 px, a small bust + bubble at the start of a few sections, spaced a long section apart.
 * Purely decorative punctuation: the rules and numbers live in the text, never in her bubbles' place.
 */
import { useEffect, useState } from "react";
import { Fumi, SpeechBubble, type FumiPose } from "@/design/anime";
import { cx } from "@/design";
import s from "./FumiGuide.module.css";

export type Beat = {
  pose: FumiPose;
  /** ≤ 8 words, no promises. */
  say: string;
  /** Also shown inline below 1200 px (at the start of its section). */
  inline?: boolean;
};

const ATTR = "data-fumi-beat";

/** Index of the last beat marker above 45% of the viewport (0 before the first). */
export function useActiveBeat(): number {
  const [active, setActive] = useState(0);
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      const line = window.innerHeight * 0.45;
      let a = 0;
      document.querySelectorAll<HTMLElement>(`[${ATTR}]`).forEach((el) => {
        if (el.getBoundingClientRect().top < line) a = Math.max(a, Number(el.getAttribute(ATTR)) || 0);
      });
      setActive(a);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  return active;
}

/** A beat's position in the text. Block form (start of a section) carries the inline Fumi below 1200 px. */
export function BeatMark({ beats, i }: { beats: Beat[]; i: number }) {
  const b = beats[i];
  return (
    <div {...{ [ATTR]: i }} className={s.mark}>
      {b.inline && (
        <div className={s.inline}>
          <Fumi pose={b.pose} size={56} crop="bust" />
          <SpeechBubble tail="left" pop={false} className={s.inlineBubble}>
            {b.say}
          </SpeechBubble>
        </div>
      )}
    </div>
  );
}

/** Marker inside a paragraph (no inline Fumi; the companion only). */
export function BeatSpot({ i }: { i: number }) {
  return <span {...{ [ATTR]: i }} aria-hidden="true" />;
}

/** The sticky companion (≥ 1200 px). Every pose she uses is stacked, so a switch never waits on an image. */
export function FumiCompanion({ beats, active }: { beats: Beat[]; active: number }) {
  const b = beats[Math.min(active, beats.length - 1)];
  const poses = [...new Set(beats.map((x) => x.pose))];
  return (
    <div className={s.rail} aria-hidden="true">
      <div className={s.bubbleBox}>
        <SpeechBubble key={active} tail="bottom-right">
          {b.say}
        </SpeechBubble>
      </div>
      <div className={s.stage}>
        {poses.map((p) => (
          <Fumi key={p} pose={p} size="md" fade fx={p === b.pose} className={cx(s.layer, p === b.pose && s.on)} />
        ))}
      </div>
    </div>
  );
}
