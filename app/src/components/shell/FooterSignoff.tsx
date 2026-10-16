"use client";

import { useSelectedLayoutSegment } from "next/navigation";
import { Fumi, SpeechBubble } from "@/design/anime";
import s from "./Footer.module.css";

/** Fumi stays off the legal pages (STYLE-ANIME.md), footer included. */
const NO_FUMI = new Set(["terms", "privacy", "risk"]);

/**
 * The footer's one anime touch: Fumi's sign-off under the tagline, a small bust, nowhere near the
 * disclaimer. The segment comes from the route tree, so it's right at prerender (no flash).
 */
export function FooterSignoff() {
  const segment = useSelectedLayoutSegment();
  if (segment && NO_FUMI.has(segment)) return null;
  return (
    <div className={s.signoff} aria-hidden="true">
      <Fumi pose="waving" size={48} crop="bust" />
      <SpeechBubble tail="left" pop={false} className={s.signoffQuip}>
        Back to you, fumblers.
      </SpeechBubble>
    </div>
  );
}
