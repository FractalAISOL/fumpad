import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../cx";
import s from "./Button.module.css";

export type ButtonVariant = "ink" | "line" | "flare" | "ghost" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

interface Own {
  /**
   * ink: the primary action. line: secondary. ghost: tertiary/toolbar.
   * flare: money actions only (Claim). quiet: inline text action.
   */
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  iconEnd?: ReactNode;
}

type ButtonProps = Own & ComponentPropsWithoutRef<"button"> & { href?: undefined };
type LinkProps = Own & Omit<ComponentPropsWithoutRef<typeof Link>, "href"> & { href: string };

export function Button(props: ButtonProps | LinkProps) {
  const { variant = "ink", size = "md", block, loading, icon, iconEnd, className, children, ...rest } = props;
  const cls = cx(s.btn, s[variant], s[size], block && s.block, loading && s.loading, className);
  const inner = (
    <>
      {icon && (
        <span className={s.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={s.label}>{children}</span>
      {iconEnd && (
        <span className={s.icon} aria-hidden="true">
          {iconEnd}
        </span>
      )}
      {loading && <span className={s.spinner} aria-hidden="true" />}
    </>
  );
  if ("href" in rest && rest.href !== undefined) {
    const { href, ...linkRest } = rest as LinkProps;
    return (
      <Link href={href} className={cls} {...linkRest}>
        {inner}
      </Link>
    );
  }
  const b = rest as ComponentPropsWithoutRef<"button">;
  return (
    <button type="button" {...b} className={cls} disabled={b.disabled || loading} aria-busy={loading || undefined}>
      {inner}
    </button>
  );
}

export function IconButton({ label, className, children, size = "md", ...rest }: ComponentPropsWithoutRef<"button"> & { label: string; size?: "sm" | "md" }) {
  return (
    <button type="button" aria-label={label} title={label} className={cx(s.iconBtn, s[`i${size}`], className)} {...rest}>
      {children}
    </button>
  );
}
