"use client";

import Link from "next/link";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import type { Ticket } from "@/data";
import { cx } from "@/design";
import * as f from "@/design/format";
import { colorDark, colorLight, gauge as G } from "@/design/tokens";
import { useNow } from "../shell/Providers";
import s from "./ClaimMoment.module.css";

export type ClaimResult = { status: "paid"; signature: string; at: number } | { status: "queued"; position: number; needsPool: number } | { status: "error"; message: string };

/**
 * The signature moment. Letterbox bars on a black stage; the needle sweeps the log ruler;
 * at 10× the screen cuts hard to orange; the title wipes in; the amount counts up; on
 * claim a PAID stamp lands. No confetti. Reduced motion jumps straight to the end state.
 */
export function ClaimMoment({ ticket, onClose, onClaim, walletLabel }: { ticket: Ticket; onClose: () => void; onClaim: () => Promise<ClaimResult>; walletLabel: string }) {
  const [phase, setPhase] = useState(0); // 0 idle, 1 rule, 2 title, 3 paid
  const [x, setX] = useState(1);
  const [flash, setFlash] = useState(false);
  const [amt, setAmt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClaimResult | null>(null);
  const now = useNow();
  const root = useRef<HTMLDivElement>(null);
  const claimBtn = useRef<HTMLButtonElement>(null);
  const finalX = ticket.multiple;
  const pos = f.gaugePos(x) * 100;

  // Choreography.
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let raf = 0;
    const T = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));
    if (reduce) {
      T(() => {
        setPhase(2);
        setX(finalX);
        setFlash(finalX >= G.trigger);
        setAmt(ticket.claimAmount);
      }, 0);
    } else {
      T(() => setPhase(1), 80);
      T(() => {
        const t0 = performance.now();
        const dur = 1500;
        let flashed = false;
        const step = (now: number) => {
          const k = Math.min(1, (now - t0) / dur);
          const e = 1 - Math.pow(1 - k, 3);
          const v = Math.exp(e * Math.log(finalX));
          setX(v);
          if (!flashed && v >= G.trigger) {
            flashed = true;
            setFlash(true);
          }
          if (k < 1) raf = requestAnimationFrame(step);
          else {
            setPhase(2);
            const c0 = performance.now();
            const count = (n: number) => {
              const kk = Math.min(1, (n - c0) / 900);
              setAmt(Math.round((ticket.claimAmount * (1 - Math.pow(1 - kk, 4))) / 1000) * 1000);
              if (kk < 1) raf = requestAnimationFrame(count);
              else setAmt(ticket.claimAmount);
            };
            raf = requestAnimationFrame(count);
          }
        };
        raf = requestAnimationFrame(step);
      }, 900);
    }
    T(() => claimBtn.current?.focus(), reduce ? 50 : 2700);
    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
    };
  }, [finalX, ticket.claimAmount]);

  // Modal behaviour: lock scroll, trap focus, Escape closes.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    root.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && root.current) {
        const els = Array.from(root.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"));
        if (!els.length) return;
        const i = els.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          els[els.length - 1].focus();
        } else if (!e.shiftKey && i === els.length - 1) {
          e.preventDefault();
          els[0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);

  const claim = useCallback(async () => {
    setBusy(true);
    const r = await onClaim();
    setBusy(false);
    setResult(r);
    if (r.status === "paid") setPhase(3);
  }, [onClaim]);

  const paid = result?.status === "paid";
  const queued = result?.status === "queued";
  const stage = { "--stage": colorDark.canvas, "--stage-ink": colorDark.ink, "--flash": colorLight.flare } as CSSProperties;

  return (
    <div
      ref={root}
      className={cx(s.moment, phase >= 1 && s.p1, phase >= 2 && s.p2, phase >= 3 && s.p3, flash && s.flash)}
      style={stage}
      role="dialog"
      aria-modal="true"
      aria-labelledby="moment-title"
      aria-describedby="moment-sub"
      tabIndex={-1}
    >
      <div className={cx(s.bar, s.barT)} />
      <div className={cx(s.bar, s.barB)} />
      <button type="button" className={s.close} onClick={onClose}>
        Close
      </button>
      <div className={s.stageIn}>
        <div className={s.meta} aria-hidden="true">
          <span>
            ${ticket.symbol} ticket, sold {f.dateTime(ticket.sellTs)} at {f.priceSpoken(ticket.sellPrice)} SOL
          </span>
          <span>30-min median, checked {f.clock(now)} UTC</span>
        </div>
        <div className={s.read} aria-hidden="true">
          {f.fixed(x, 1)}×
        </div>
        <div className={s.rule} aria-hidden="true">
          <div className={s.ln} />
          {G.ticks.map((v) => (
            <i key={v} className={cx(v === G.trigger ? s.ten : (G.major as readonly number[]).includes(v) && s.maj)} style={{ left: `${f.gaugePos(v) * 100}%` }} />
          ))}
          {G.major.map((v) => (
            <span key={v} className={s.l} style={{ left: `${Math.min(97, Math.max(2, f.gaugePos(v) * 100))}%` }}>
              {v}×
            </span>
          ))}
          <span className={s.run} style={{ width: `${pos}%` }} />
          <span className={s.ring} style={{ left: 0 }} />
          <span className={s.nd} style={{ left: `${pos}%` }} />
        </div>

        <div className={s.low}>
          <div>
            <h2 id="moment-title" className={s.title}>
              {paid ? (
                <>
                  Paid
                  <br />
                  back.
                </>
              ) : queued ? (
                <>
                  In the
                  <br />
                  queue.
                </>
              ) : (
                <>
                  Claim
                  <br />
                  unlocked.
                </>
              )}
            </h2>
            <p id="moment-sub" className={s.sub}>
              You sold {f.tokens(ticket.originalTokens)} {ticket.symbol} on {f.date(ticket.sellTs)}. It held above 10× your price for thirty minutes straight. Officially, you fumbled. Here&apos;s 10% back.
            </p>
          </div>
          <div className={s.box}>
            {paid && (
              <div className={s.stamp} aria-hidden="true">
                PAID {f.clock(result.at)}
              </div>
            )}
            <div className={s.amt}>
              <span className="num">{f.int(amt)}</span>
              <small>{ticket.symbol}</small>
            </div>
            <div className={s.amtSub} aria-live="polite">
              {paid ? (
                <>
                  Sent to {walletLabel}. tx <span className="num">{f.shortAddr(result.signature)}</span>. You hold {ticket.symbol} again. Congratulations, sort of.
                </>
              ) : queued ? (
                <>
                  The pool is short for now. You&apos;re #{result.position} in line and pay when it reaches {f.compact(result.needsPool)}. Queued claims don&apos;t expire.
                </>
              ) : result?.status === "error" ? (
                <>{result.message}</>
              ) : (
                <>≈ {f.sol(ticket.claimValueSol)} SOL now. Fits the pool, pays in one transaction.</>
              )}
            </div>
            <div className={s.actions}>
              {paid ? (
                <>
                  <Link href={`/share/${ticket.id}`} className={cx(s.btn, s.btnDone)}>
                    Make the share card
                  </Link>
                  <button type="button" className={cx(s.btn, s.ghost)} onClick={onClose}>
                    Done
                  </button>
                </>
              ) : queued ? (
                <button type="button" className={cx(s.btn, s.btnDone)} onClick={onClose}>
                  Done
                </button>
              ) : (
                <>
                  <button ref={claimBtn} type="button" className={s.btn} onClick={claim} disabled={busy}>
                    {busy ? "Confirming…" : `Claim ${f.int(ticket.claimAmount)} ${ticket.symbol}`}
                  </button>
                  <button type="button" className={cx(s.btn, s.ghost)} onClick={onClose}>
                    Later. It might go higher.
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
