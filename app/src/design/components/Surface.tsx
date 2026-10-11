import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../cx";
import s from "./Surface.module.css";

/* ── Panel ────────────────────────────────────────────────────────────────── */

export function Panel({ className, as: As = "section", ...rest }: ComponentPropsWithoutRef<"section"> & { as?: "section" | "div" | "article" | "aside" }) {
  return <As className={cx(s.panel, className)} {...rest} />;
}

/** Panel title row: h2 on the left, a quiet aside or control on the right. */
export function PanelHead({
  title,
  aside,
  id,
  level = 2,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  id?: string;
  level?: 2 | 3;
  children?: ReactNode;
}) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <div className={s.head}>
      <H id={id} className={s.title}>
        {title}
      </H>
      {aside && <span className={s.aside}>{aside}</span>}
      {children}
    </div>
  );
}

export function PanelBody({ className, ...rest }: ComponentPropsWithoutRef<"div">) {
  return <div className={cx(s.body, className)} {...rest} />;
}

export function PanelNote({ className, ...rest }: ComponentPropsWithoutRef<"p">) {
  return <p className={cx(s.note, className)} {...rest} />;
}

/* ── Stat & key–value ─────────────────────────────────────────────────────── */

export function Stat({
  label,
  children,
  hint,
  align,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  align?: "end";
  className?: string;
}) {
  return (
    <div className={cx(s.stat, align === "end" && s.end, className)}>
      <div className={s.statK}>{label}</div>
      <div className={s.statV}>{children}</div>
      {hint && <div className={s.statHint}>{hint}</div>}
    </div>
  );
}

export function KV({ rows, className }: { rows: { k: ReactNode; v: ReactNode; key?: string }[]; className?: string }) {
  return (
    <dl className={cx(s.kv, className)}>
      {rows.map((r, i) => (
        <div key={r.key ?? i} className={s.kvRow}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Badge ────────────────────────────────────────────────────────────────── */

export type BadgeTone = "neutral" | "ink" | "flare" | "flare-line" | "muted";

/**
 * Status pills. `flare` and `flare-line` are for money states only (claimable, paid,
 * fits the pool). Everything else is ink or outline.
 */
export function Badge({ tone = "neutral", dot, children, className }: { tone?: BadgeTone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cx(s.badge, s[`b-${tone}`], className)}>
      {dot && <span className={s.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}

/* ── Skeleton ─────────────────────────────────────────────────────────────── */

export function Skeleton({ w = "100%", h = 12, round, className }: { w?: number | string; h?: number | string; round?: boolean; className?: string }) {
  return <span className={cx(s.skel, round && s.round, className)} style={{ width: w, height: h }} aria-hidden="true" />;
}

/** Announces loading once for a region of skeletons. */
export function Loading({ label = "Loading", children }: { label?: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/* ── Empty state ──────────────────────────────────────────────────────────── */

/** Empty screens are invitations: say what's missing and what to do next. */
export function EmptyState({
  title,
  children,
  action,
  glyph = "mark",
  compact,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  glyph?: "mark" | "none";
  compact?: boolean;
}) {
  return (
    <div className={cx(s.empty, compact && s.emptyCompact)}>
      {glyph === "mark" && (
        <svg className={s.glyph} viewBox="0 0 56 56" fill="none" strokeWidth="2" aria-hidden="true">
          <circle cx="16" cy="40" r="7" stroke="var(--ink)" />
          <path d="M22 34l18-18" stroke="var(--ink)" strokeDasharray="3 4" />
          <circle cx="42" cy="14" r="7" stroke="var(--rule-2)" />
        </svg>
      )}
      <h3 className={s.emptyTitle}>{title}</h3>
      {children && <p className={s.emptyBody}>{children}</p>}
      {action && <div className={s.emptyAction}>{action}</div>}
    </div>
  );
}

/* ── Split bar (fee split) ────────────────────────────────────────────────── */

export function SplitBar({ parts, label }: { parts: { label: string; share: number }[]; label: string }) {
  return (
    <div className={s.split} role="img" aria-label={`${label}: ${parts.map((p) => `${p.share}% ${p.label}`).join(", ")}`}>
      {parts.map((p, i) => (
        <div key={p.label} className={s[`sp${i}`]} style={{ flex: p.share }}>
          {p.share}% {p.label}
        </div>
      ))}
    </div>
  );
}
