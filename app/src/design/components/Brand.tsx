import { cx } from "../cx";
import s from "./Brand.module.css";

/**
 * The mark: the product's own chart. Ring = your sell, dotted line = the run you
 * missed, orange dot = 10×. `bg` is the colour the ring and run are cut out of.
 */
export function Mark({ size = 28, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={cx(s.mark, className)} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <rect width="32" height="32" rx="5" fill="var(--mark-fg, var(--ink))" />
      <circle cx="9" cy="22.5" r="3.6" fill="none" stroke="var(--mark-bg, var(--canvas))" strokeWidth="2.4" />
      <path d="M12.2 20.6 L21.5 11" stroke="var(--mark-bg, var(--canvas))" strokeWidth="1.6" strokeDasharray="1.6 2" />
      <circle cx="23.5" cy="9" r="4.4" fill="var(--flare)" />
    </svg>
  );
}

export function Wordmark({ className, size = "md" }: { className?: string; size?: "md" | "xl" }) {
  return <span className={cx(s.wordmark, s[size], className)}>FUMPAD</span>;
}
