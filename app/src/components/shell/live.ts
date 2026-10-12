"use client";

/**
 * Live data for client views. Three sources make a view refetch:
 *
 *  1. The socket (`FumpadData.subscribeLive`, the API's WebSocket or the mock's ticker):
 *     a `coins` message names the mints and wallets an indexed transaction touched.
 *  2. The viewer's own transactions (`announceOwnTx`, called by `useFumpadTx` once a
 *     transaction is confirmed): refetch right away and again shortly after, because the
 *     indexer and the RPC behind the API land a beat after the wallet's confirmation.
 *  3. A light poll while the tab is visible, as a floor if a message is missed.
 *
 * Views that render pushed state directly (the coin page's price, chart and trades) use
 * `useLiveMessages` and read the `coin` messages themselves.
 */
import { useEffect, useRef } from "react";
import { type LiveMessage, getFumpadData } from "@/data";

/* ── Own transactions (a tab-local bus) ───────────────────────────────────── */

export type OwnTxKind = "buy" | "sell" | "claim" | "launch" | "auto-claim" | "withdraw";
export interface OwnTx {
  kind: OwnTxKind;
  wallet: string;
  mint?: string;
  signature: string;
}

const ownTxListeners = new Set<(e: OwnTx) => void>();

/** Tell every mounted view that the viewer's transaction confirmed. */
export function announceOwnTx(e: OwnTx) {
  for (const l of [...ownTxListeners]) l(e);
}

/** The latest `fn` without re-subscribing when it changes identity. */
function useLatest<T>(fn: T) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return ref;
}

export function useOwnTx(handler: (e: OwnTx) => void) {
  const ref = useLatest(handler);
  useEffect(() => {
    const l = (e: OwnTx) => ref.current(e);
    ownTxListeners.add(l);
    return () => {
      ownTxListeners.delete(l);
    };
  }, [ref]);
}

/** Every live message, for views that apply pushed state themselves. */
export function useLiveMessages(handler: (m: LiveMessage) => void) {
  const ref = useLatest(handler);
  useEffect(() => getFumpadData().subscribeLive((m) => ref.current(m)), [ref]);
}

/* ── Refetch on change ─────────────────────────────────────────────────────── */

export interface RefreshOn {
  /** Refetch when a transaction touches any of these mints. */
  mints?: readonly string[];
  /** …or any of these wallets. */
  wallets?: readonly string[];
  /** Refetch on every touched coin (lists that show many coins). */
  anyCoin?: boolean;
  /** Also refetch on every new feed event (stats, closest-to-10×). */
  onFeed?: boolean;
  /** Poll while the tab is visible. 0 = no polling. */
  pollMs?: number;
  /** Coalesce bursts into one request. */
  debounceMs?: number;
  /** Fetch once on mount (catch up on a cached server render). Default true. */
  onMount?: boolean;
}

/** Follow-up refetches after the viewer's own transaction: the API's indexer/RPC trail the wallet. */
const OWN_TX_FOLLOW_UPS = [1_500, 4_000, 9_000];

/**
 * Calls `load` whenever its data may have changed (see the file comment). `load` should
 * be cheap to call repeatedly and apply its own result; stale responses are its concern
 * (use a request counter if ordering matters).
 */
export function useRefresh(load: () => void, opts: RefreshOn = {}) {
  const { pollMs = 0, debounceMs = 400, anyCoin = false, onFeed = false, onMount = true } = opts;
  const loadRef = useLatest(load);
  const mintKey = (opts.mints ?? []).join(",");
  const walletKey = (opts.wallets ?? []).join(",");

  useEffect(() => {
    const mints = new Set(mintKey ? mintKey.split(",") : []);
    const wallets = new Set(walletKey ? walletKey.split(",") : []);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const followUps: ReturnType<typeof setTimeout>[] = [];
    const now = () => loadRef.current();
    const soon = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = undefined;
        now();
      }, debounceMs);
    };

    if (onMount) now();

    const unsubLive = getFumpadData().subscribeLive((m) => {
      if (m.type === "resync" || m.type === "params") return soon();
      if (m.type === "feed") return onFeed ? soon() : undefined;
      if (m.type !== "coins") return;
      if (anyCoin || m.mints.some((x) => mints.has(x)) || (m.wallets ?? []).some((w) => wallets.has(w))) soon();
    });

    const onOwn = (e: OwnTx) => {
      const hit = anyCoin || wallets.has(e.wallet) || (e.mint !== undefined && mints.has(e.mint));
      if (!hit) return;
      now();
      for (const ms of OWN_TX_FOLLOW_UPS) followUps.push(setTimeout(now, ms));
    };
    ownTxListeners.add(onOwn);

    let poll: ReturnType<typeof setInterval> | undefined;
    const onVisible = () => {
      if (document.visibilityState === "visible") soon();
    };
    if (pollMs > 0) {
      poll = setInterval(() => {
        if (document.visibilityState === "visible") now();
      }, pollMs);
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      unsubLive();
      ownTxListeners.delete(onOwn);
      if (debounce) clearTimeout(debounce);
      followUps.forEach(clearTimeout);
      if (poll) clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [mintKey, walletKey, anyCoin, onFeed, pollMs, debounceMs, onMount, loadRef]);
}
