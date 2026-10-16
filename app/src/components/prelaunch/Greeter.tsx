import { Fumi, SpeechBubble, type FumiPose } from "@/design/anime";
import { cx } from "@/design/cx";
import g from "./Greeter.module.css";

/**
 * Fumi as the waiting room's greeter: one short bubble above her head, her figure below. One per
 * screen (the hero, the rules, the waitlist sit a full section apart), never over a form, a button,
 * a chart or a number; the page around her carries the meaning, so she is decorative.
 *
 * Height comes from the caller's class (`--greet-h`, any CSS length) so she can scale with the
 * viewport; the box and the bubble slot are reserved up front, so a pose or line swap never shifts
 * the layout. All motion is the kit's CSS and stops under prefers-reduced-motion.
 */
export function Greeter({
  pose,
  quip,
  className,
  fx = true,
  idle,
  pop = true,
  hint = 240,
}: {
  pose: FumiPose;
  quip: string;
  className?: string;
  fx?: boolean;
  idle?: boolean;
  pop?: boolean;
  /** Typical rendered height in px; only picks the WebP width (360 / 720). */
  hint?: number;
}) {
  return (
    <div className={cx(g.greeter, className)} data-pose={pose}>
      <div className={g.slot}>
        {/* key: a new line pops in again */}
        <SpeechBubble key={quip} tail="bottom-right" pop={pop} className={g.quip}>
          {quip}
        </SpeechBubble>
      </div>
      <Fumi key={pose} pose={pose} size={hint} fx={fx} pop={pop} idle={idle} className={g.fumi} />
    </div>
  );
}
