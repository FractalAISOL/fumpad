"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CLUSTER } from "@/chain/cluster";
import { Button } from "@/design/components/Button";
import { Wordmark } from "@/design/components/Brand";
import { PENDING_ATTR } from "@/legal/disclaimer";
import { disclaimerCopy } from "@/legal/disclaimerCopy";
import { acceptDisclaimer, useDisclaimerAccepted } from "./acceptance";
import s from "./DisclaimerGate.module.css";

const COPY = disclaimerCopy(CLUSTER);

/**
 * The legal disclaimer every visitor confirms before using FUMPAD (the app, the waiting room and the launch-window
 * checker; not the legal pages, `legal` = true there). Client-only: the root layout's pre-paint script
 * (`DISCLAIMER_SCRIPT`) already hid the page from the first frame; after hydration this opens a native modal
 * <dialog> (top layer, everything else inert, focus kept inside) and keeps the page hidden until accepted.
 * Escape does nothing. No Fumi here (marketing/STYLE-ANIME.md).
 */
export function DisclaimerGate({ legal }: { legal: boolean }) {
  const accepted = useDisclaimerAccepted();
  const show = accepted === false && !legal;

  // The page stays hidden (globals.css) exactly while the gate is up; React owns the attribute after hydration.
  useEffect(() => {
    if (accepted === null) return;
    const html = document.documentElement;
    if (show) html.setAttribute(PENDING_ATTR, "pending");
    else html.removeAttribute(PENDING_ATTR);
  }, [accepted, show]);

  if (!show) return null;
  return createPortal(<GateDialog />, document.body);
}

function GateDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [checked, setChecked] = useState(false);
  const titleId = useId();
  const introId = useId();
  const checkId = useId();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // Start on the title (read out with the dialog), not on the scrollable list showModal() would pick.
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <dialog
      ref={ref}
      className={s.gate}
      data-disclaimer-gate=""
      aria-labelledby={titleId}
      aria-describedby={introId}
      closedby="none"
      // Escape must not dismiss it: block the cancel, and reopen if a browser closes it anyway.
      onCancel={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.preventDefault();
      }}
      onClose={() => {
        const d = ref.current;
        if (d && !d.open && d.isConnected) d.showModal();
      }}
    >
      <div className={s.panel}>
        <header className={s.head}>
          <Wordmark />
          <span className={s.kicker}>Disclaimer</span>
        </header>
        <h2 id={titleId} ref={heading} tabIndex={-1} className={s.title}>
          {COPY.title}
        </h2>
        <p id={introId} className={s.intro}>
          {COPY.intro}
        </p>
        {/* Focusable so keyboard users can scroll it. */}
        <div className={s.scroll} role="region" aria-label={COPY.listLabel} tabIndex={0}>
          <ol className={s.list}>
            {COPY.items.map((segs, i) => (
              <li key={i} className={s.item}>
                <span className={s.n} aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>
                  {segs.map((seg, j) =>
                    typeof seg === "string" ? (
                      seg
                    ) : (
                      <a key={j} href={seg.href} target="_blank" rel="noopener" className={s.link}>
                        {seg.label}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ),
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className={s.foot}>
          <label htmlFor={checkId} className={s.check}>
            <input id={checkId} type="checkbox" className={s.box} checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{COPY.checkbox}</span>
          </label>
          <Button variant="ink" size="lg" block disabled={!checked} className={s.confirm} onClick={acceptDisclaimer}>
            {COPY.confirm}
          </Button>
          {/* A neutral, empty page: no referrer, nothing tracked. */}
          <a href="about:blank" rel="noreferrer" referrerPolicy="no-referrer" className={s.leave}>
            {COPY.leave}
          </a>
        </div>
      </div>
    </dialog>
  );
}
