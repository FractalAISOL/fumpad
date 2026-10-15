"use client";

import { useEffect, useRef } from "react";
import s from "./Checker.module.css";

/**
 * The "How to play" video, self-hosted (`public/video/`, CSP `media-src 'self'`): muted, looping, inline, with
 * controls. It autoplays only when the reader hasn't asked for reduced motion; otherwise it waits on its poster.
 * The 4:5 cut plays on narrow screens.
 */
export function HowToPlayVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (window.matchMedia("(max-width: 599px)").matches) v.poster = "/video/howtoplay-4x5.jpg";
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    v.muted = true;
    v.play().catch(() => {
      /* autoplay refused (data saver, low-power mode): the poster and controls stay */
    });
  }, []);
  return (
    <div className={s.videoBox}>
      <video ref={ref} className={s.videoEl} muted loop playsInline controls preload="metadata" poster="/video/howtoplay-16x9.jpg" aria-label="How to play FUMPAD, a 40-second video">
        <source src="/video/howtoplay-4x5.mp4" type="video/mp4" media="(max-width: 599px)" />
        <source src="/video/howtoplay-16x9.mp4" type="video/mp4" />
      </video>
    </div>
  );
}
