/**
 * Fumi-based empty, loading and error states. Anime kit — LOCKED for phase-2 agents. Drop-in
 * alternatives to the plain EmptyState / Loading for non-trading surfaces (My fumbles with nothing in
 * it, a 404, a failed fetch). Never inside a trade panel, a chart, a form or a price table.
 */
import type { ReactNode } from "react";
import { cx } from "../cx";
import { Fumi } from "./Fumi";
import type { FumiPose } from "./poses";
import { SpeechBubble } from "./SpeechBubble";
import s from "./Anime.module.css";

interface StateProps {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  /** Her one-liner. Short, playful, no promises. */
  quip?: string;
  pose?: FumiPose;
  compact?: boolean;
  className?: string;
}

function FumiState({ title, children, action, quip, pose, compact, className, tone, role }: StateProps & { pose: FumiPose; tone: "empty" | "error"; role?: "alert" }) {
  return (
    <div className={cx(s.state, compact && s.stateCompact, className)} role={role} data-tone={tone}>
      <div className={s.stateArt}>
        {quip && (
          <SpeechBubble tail="bottom-right" className={s.stateQuip}>
            {quip}
          </SpeechBubble>
        )}
        <Fumi pose={pose} size={compact ? 120 : 176} crop="full" fade fx pop />
      </div>
      <h3 className={s.stateTitle}>{title}</h3>
      {children && <p className={s.stateBody}>{children}</p>}
      {action && <div className={s.stateAction}>{action}</div>}
    </div>
  );
}

/** Nothing here yet. Default pose: waving (welcome) — use "thinking" for "no results". */
export function FumiEmptyState({ pose = "waving", ...p }: StateProps) {
  return <FumiState {...p} pose={pose} tone="empty" />;
}

/** Something failed. Says what happened and what to do; Fumi only softens it. Default pose: facepalm. */
export function FumiErrorState({ pose = "facepalm", ...p }: StateProps) {
  return <FumiState {...p} pose={pose} tone="error" role="alert" />;
}

/** Loading a region: Fumi (bust) + three dots + one polite status announcement. */
export function FumiLoadingState({ label = "Loading", pose = "thinking", line, compact, className }: { label?: string; pose?: FumiPose; line?: string; compact?: boolean; className?: string }) {
  return (
    <div className={cx(s.loading, compact && s.loadingCompact, className)} role="status" aria-live="polite">
      <Fumi pose={pose} size={compact ? 48 : 72} crop="bust" idle />
      <span className={s.loadingText} aria-hidden="true">
        {line ?? label}
        <span className={s.dots}>
          <i />
          <i />
          <i />
        </span>
      </span>
      <span className="sr-only">{label}</span>
    </div>
  );
}
