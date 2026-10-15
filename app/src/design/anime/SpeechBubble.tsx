/**
 * Fumi's speech bubble. Anime kit — LOCKED for phase-2 agents. Ink bubble (flips with the theme), a
 * short quip, never a caption or an instruction: ≤ 8 words, no financial promises.
 *
 *   <SpeechBubble tail="bottom-right">Sold too early? Same.</SpeechBubble>
 */
import type { ReactNode } from "react";
import { cx } from "../cx";
import s from "./Anime.module.css";

export type BubbleTail = "bottom-left" | "bottom-right" | "left" | "right";

export function SpeechBubble({ children, tail = "bottom-right", pop = true, className }: { children: ReactNode; tail?: BubbleTail; pop?: boolean; className?: string }) {
  return (
    <span className={cx(s.bubble, s[`tail-${tail}`], pop && s.popIn, className)}>
      <span className={s.bubbleText}>{children}</span>
    </span>
  );
}
