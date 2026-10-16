/**
 * Fumi, FUMPAD's anime mascot ("Chief Fumble Correspondent"), for the web. Anime kit — LOCKED for
 * phase-2 agents; rules in marketing/STYLE-ANIME.md. Server-safe (no hooks), CSS-only motion that
 * honours prefers-reduced-motion.
 *
 *   <Fumi pose="waving" size="md" />                 full figure, 160 px tall, decorative
 *   <Fumi pose="crying" size={64} crop="bust" />     head-and-shoulders square (normalised framing)
 *   <Fumi pose="cheering" size="lg" fx pop />        with her pose effects (sparkles) and a pop-in
 */
import type { CSSProperties } from "react";
import { cx } from "../cx";
import { FUMI_WIDTHS } from "./manifest";
import { FUMI_POSES, REF_HEAD, drawnPose, type FumiPose } from "./poses";
import { FumiFxLayer } from "./effects";
import s from "./Anime.module.css";

export type FumiSize = "xs" | "sm" | "md" | "lg" | "xl";
/** Height in px (full crop) or side (bust crop). Phones scale lg/xl down (×0.75) automatically. */
export const FUMI_SIZE: Record<FumiSize, number> = { xs: 48, sm: 96, md: 160, lg: 240, xl: 360 };

export interface FumiProps {
  pose?: FumiPose;
  size?: FumiSize | number;
  /** full: the 3:4 cut-out as drawn (cut at the thighs). bust: a square head-and-shoulders crop. */
  crop?: "full" | "bust";
  /** Play the pose's effects (sparkles, "!!", sweat drop…). Full crop only. */
  fx?: boolean;
  /** Pop in on mount (stamp overshoot). */
  pop?: boolean;
  /** Gentle breathing bob. Use on hero spots only. */
  idle?: boolean;
  /** Fade the cut edge at the bottom of a full crop (use when she doesn't sit on a container edge). */
  fade?: boolean;
  /** Accessible name. Omit for decorative use (the default: the words around her carry the meaning). */
  alt?: string;
  className?: string;
  style?: CSSProperties;
}

const src = (pose: FumiPose, w: number) => `/fumi/${pose}-${w}.webp`;

export function Fumi({ pose = "pointing", size = "md", crop = "full", fx, pop, idle, fade, alt, className, style }: FumiProps) {
  const px = typeof size === "number" ? size : FUMI_SIZE[size];
  const drawn = drawnPose(pose);
  const head = FUMI_POSES[drawn].head ?? REF_HEAD;
  const srcSet = FUMI_WIDTHS.map((w) => `${src(drawn, w)} ${w}w`).join(", ");
  const decorative = !alt;

  let imgStyle: CSSProperties | undefined;
  let renderW = (px * 3) / 4;
  if (crop === "bust") {
    // Square around her head: side S (image-width units) = 2.2 × hair width, head 10% below the top.
    const [hx, htop, hw] = head;
    const S = 2.2 * hw;
    const top = (htop * 4) / 3 - 0.1 * S;
    renderW = px / S;
    imgStyle = { width: `${(100 / S).toFixed(3)}%`, left: `${((-(hx - S / 2) / S) * 100).toFixed(3)}%`, top: `${((-top / S) * 100).toFixed(3)}%` };
  }

  return (
    <span
      className={cx(s.fumi, crop === "bust" ? s.bust : s.full, pop && s.pop, idle && s.idle, fade && crop === "full" && s.fade, className)}
      style={{ ...style, ["--fumi-h" as string]: `${px}px` }}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : alt}
      aria-hidden={decorative ? true : undefined}
      data-pose={pose}
      data-drawn={drawn !== pose ? drawn : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static transparent WebP pair from public/fumi; next/image adds nothing here */}
      <img
        className={s.img}
        src={src(drawn, FUMI_WIDTHS[FUMI_WIDTHS.length - 1])}
        srcSet={srcSet}
        sizes={`${Math.ceil(renderW)}px`}
        alt=""
        width={FUMI_WIDTHS[0]}
        height={(FUMI_WIDTHS[0] * 4) / 3}
        style={imgStyle}
        decoding="async"
        loading="lazy"
        draggable={false}
      />
      {fx && crop === "full" && <FumiFxLayer pose={pose} drawn={drawn} />}
    </span>
  );
}
