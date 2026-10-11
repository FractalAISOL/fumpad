"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { cx } from "../cx";
import s from "./Choice.module.css";

export interface ChoiceItem<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
  disabled?: boolean;
}

/** Arrow-key roving focus shared by Tabs and Segmented. */
function useRoving<T extends string>(items: ChoiceItem<T>[], value: T, onChange: (v: T) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    const cur = enabled.indexOf(items.findIndex((it) => it.value === value));
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = enabled[(cur + 1) % enabled.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = enabled[(cur - 1 + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  return { refs, onKeyDown };
}

/**
 * ARIA tabs (tablist). Pair each tab with a panel: `<div role="tabpanel" id={tabPanelId(idBase, value)} aria-labelledby={tabId(idBase, value)}>`.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idBase,
  className,
}: {
  items: ChoiceItem<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  idBase: string;
  className?: string;
}) {
  const { refs, onKeyDown } = useRoving(items, value, onChange);
  return (
    <div role="tablist" aria-label={label} className={cx(s.tabs, className)} onKeyDown={onKeyDown}>
      {items.map((it, i) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabId(idBase, it.value)}
            aria-selected={on}
            aria-controls={tabPanelId(idBase, it.value)}
            tabIndex={on ? 0 : -1}
            disabled={it.disabled}
            className={s.tab}
            onClick={() => onChange(it.value)}
          >
            {it.label}
            {it.count !== undefined && <span className={cx("num", s.count)}>{it.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
export const tabId = (base: string, v: string) => `${base}-tab-${v}`;
export const tabPanelId = (base: string, v: string) => `${base}-panel-${v}`;

/**
 * Segmented control: a radio group drawn as one instrument. For filters, ranges and
 * modes where the choice changes content in place.
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  size = "md",
  block,
  className,
}: {
  items: ChoiceItem<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
  block?: boolean;
  className?: string;
}) {
  const { refs, onKeyDown } = useRoving(items, value, onChange);
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} id={id} className={cx(s.seg, s[size], block && s.block, className)} onKeyDown={onKeyDown}>
      {items.map((it, i) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={it.disabled}
            className={s.segBtn}
            onClick={() => onChange(it.value)}
          >
            {it.label}
            {it.count !== undefined && <span className={cx("num", s.n)}>{it.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Pill filters for feeds: independent toggles that act like a single choice. */
export function Chips<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: ChoiceItem<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  const { refs, onKeyDown } = useRoving(items, value, onChange);
  return (
    <div role="radiogroup" aria-label={label} className={cx(s.chips, className)} onKeyDown={onKeyDown}>
      {items.map((it, i) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={s.chip}
            onClick={() => onChange(it.value)}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
