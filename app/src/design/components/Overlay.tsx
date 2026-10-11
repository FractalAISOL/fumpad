"use client";

import {
  type ReactElement,
  type ReactNode,
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../cx";
import { IconClose, IconInfo } from "./Icons";
import s from "./Overlay.module.css";

/* ── Tooltip ──────────────────────────────────────────────────────────────── */

type TriggerProps = { "aria-describedby"?: string };

/**
 * Tooltip for supplementary text. Shows on hover and focus, hides on Escape, toggles on
 * tap. Rendered in a portal with fixed positioning so panels never clip it. Never put
 * required information only in a tooltip.
 */
export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement<TriggerProps>; side?: "top" | "bottom" }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const anchor = useRef<HTMLSpanElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);

  const place = useCallback(() => {
    const a = anchor.current;
    const b = bubble.current;
    if (!a || !b) return;
    const r = a.getBoundingClientRect();
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const below = side === "bottom" || r.top < bh + 12;
    const x = Math.min(window.innerWidth - bw / 2 - 8, Math.max(bw / 2 + 8, r.left + r.width / 2));
    setPos({ x, y: below ? r.bottom + 8 : r.top - 8, below });
  }, [side]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onScroll = () => place();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  const trigger = cloneElement(children, {
    "aria-describedby": open ? id : children.props["aria-describedby"],
  });

  return (
    <span
      ref={anchor}
      className={s.anchor}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen(true)}
    >
      {trigger}
      {open &&
        createPortal(
          <div
            ref={bubble}
            id={id}
            role="tooltip"
            className={cx(s.tip, pos?.below && s.below)}
            style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

/** A small (i) that explains a term. Focusable, so keyboard and screen readers get it too. */
export function InfoTip({ children, label = "What's this?" }: { children: ReactNode; label?: string }) {
  return (
    <Tooltip content={children}>
      <button type="button" className={s.info} aria-label={label}>
        <IconInfo />
      </button>
    </Tooltip>
  );
}

/* ── Dialog / Sheet ───────────────────────────────────────────────────────── */

/**
 * Modal dialog on the native <dialog> element (focus trap, Escape, top layer for free).
 * Below 600px it becomes a bottom sheet.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx(s.dialog, s[size])}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className={s.sheet}>
          <span className={s.grip} aria-hidden="true" />
          <div className={s.dHead}>
            <h2 id={titleId} className={s.dTitle}>
              {title}
            </h2>
            <button type="button" className={s.dClose} onClick={onClose} aria-label="Close">
              <IconClose />
            </button>
          </div>
          {description && (
            <p id={descId} className={s.dDesc}>
              {description}
            </p>
          )}
          {children && <div className={s.dBody}>{children}</div>}
          {footer && <div className={s.dFoot}>{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/* ── Toast ────────────────────────────────────────────────────────────────── */

interface ToastItem {
  id: number;
  message: ReactNode;
  tone: "ink" | "money";
}
const ToastCtx = createContext<(message: ReactNode, tone?: "ink" | "money") => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

/** One toast at a time, bottom-centre, announced politely. Same verb as the action. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<ToastItem | null>(null);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seq = useRef(0);
  const push = useCallback((message: ReactNode, tone: "ink" | "money" = "ink") => {
    clearTimeout(timer.current);
    setItem({ id: ++seq.current, message, tone });
    setVisible(true);
    timer.current = setTimeout(() => setVisible(false), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className={cx(s.toast, visible && s.toastOn, item?.tone === "money" && s.toastMoney)} role="status" aria-live="polite" aria-atomic="true">
        {item?.message}
      </div>
    </ToastCtx.Provider>
  );
}
