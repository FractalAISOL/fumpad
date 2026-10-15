/**
 * Fumi pose registry (web). Mirrors F.kit.POSES in marketing/animations/src/kit/anime.js — same keys,
 * same fallbacks, same head metadata. LOCKED for phase-2 agents (marketing/STYLE-ANIME.md).
 *
 * A pose without art (not in the generated FUMI_ART) falls back along `fallback` until one has art, so
 * pages can name any pose today; `npm run fumi` after dropping in a PNG upgrades them automatically.
 */
import { FUMI_ART } from "./manifest";

export type FumiPose =
  | "pointing"
  | "cheering"
  | "shocked"
  | "ticket"
  | "thumbsdown"
  | "waving"
  | "thinking"
  | "crying"
  | "moneyeyes"
  | "facepalm"
  | "running";

export type FumiFx = "sparkles" | "bang" | "shock" | "sweat" | "glow" | "think" | "dash";

export interface FumiPoseInfo {
  /** Pose drawn when this one has no art yet. */
  fallback?: FumiPose;
  /** Effects that play with the pose when `fx` is on. */
  fx: FumiFx[];
  /** [centre x, top, width] of her hair in image fractions (3:4 image). Omitted = the reference framing. */
  head?: readonly [number, number, number];
  /** What the pose means; use it for that, nothing else. */
  means: string;
  /** Accessible description, used only when the image isn't decorative. */
  alt: string;
}

/** Reference head (pointing). Poses framed closer or wider are normalised to it in `crop="bust"`. */
export const REF_HEAD = [0.576, 0.038, 0.362] as const;

export const FUMI_POSES: Record<FumiPose, FumiPoseInfo> = {
  pointing: { fx: [], means: "Explaining; points to the viewer's left, at the content.", alt: "Fumi, the FUMPAD mascot, pointing" },
  cheering: { fx: ["sparkles"], means: "Good news: graduation, a claim paid, a success toast.", alt: "Fumi cheering" },
  shocked: { fx: ["bang", "shock"], means: "Surprise: the 10× crossing, something unexpected.", alt: "Fumi, shocked" },
  ticket: { fx: ["glow"], means: "Fumble Tickets: she holds a blank orange ticket.", alt: "Fumi holding a Fumble Ticket" },
  thumbsdown: { fx: ["sweat"], means: "Doesn't count: under $50, not eligible, rejected.", alt: "Fumi giving a thumbs down" },
  waving: { fallback: "pointing", fx: [], means: "Hello / goodbye: welcome, sign-off, logged out.", alt: "Fumi waving" },
  thinking: { fallback: "pointing", fx: ["think"], means: "A question, a rule to think about; loading.", alt: "Fumi thinking" },
  crying: { fallback: "shocked", fx: [], head: [0.527, 0.0725, 0.543], means: "“I fumbled”: sold too early (comic, about the fumble, never about losing money).", alt: "Fumi crying comically" },
  moneyeyes: { fallback: "cheering", fx: ["sparkles"], head: [0.502, 0.047, 0.496], means: "A payout is possible: the claim, the reward pool.", alt: "Fumi with star-struck eyes" },
  facepalm: { fallback: "thumbsdown", fx: [], means: "Oops: an error, a classic mistake (art has its own sweat drop).", alt: "Fumi facepalming" },
  running: { fallback: "cheering", fx: ["dash"], head: [0.561, 0.092, 0.217], means: "On the way: launching, sending, a transition.", alt: "Fumi running" },
};

export const FUMI_POSE_KEYS = Object.keys(FUMI_POSES) as FumiPose[];

const ART = new Set<string>(FUMI_ART);

/** Pose drawn for `pose` given the poses that have art: follows fallbacks, ends at pointing. */
export function resolvePose(pose: FumiPose, art: ReadonlySet<string>): FumiPose {
  let p = pose;
  const seen = new Set<FumiPose>();
  while (!art.has(p) && FUMI_POSES[p].fallback && !seen.has(p)) {
    seen.add(p);
    p = FUMI_POSES[p].fallback!;
  }
  return art.has(p) ? p : "pointing";
}

/** Pose actually drawn for `pose` with the art we ship (follows fallbacks past poses without art). */
export const drawnPose = (pose: FumiPose): FumiPose => resolvePose(pose, ART);

export const hasArt = (pose: FumiPose) => ART.has(pose);
