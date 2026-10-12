"use client";

import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { keepSnapshot, DEMO_WALLET, type ProtocolParams, getFumpadData } from "@/data";
import { PARAMS } from "@/data/chain";
import { ToastProvider } from "@/design";
import { useLiveMessages, useRefresh } from "./live";

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";

/* ── Clock ────────────────────────────────────────────────────────────────── */

/**
 * The data source's clock, for relative times ("4m"). The server renders (and prerenders)
 * with `initial`, a minute-floored snapshot the root layout reads from the cache, and
 * hydration reuses it, so nothing reads the time during a render on the server. On the
 * client the store ticks every 15 s from `getFumpadData().now()`.
 */
const NowCtx = createContext<number>(0);
export function useNow() {
  return useContext(NowCtx);
}

let clock: number | null = null;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
function subscribeClock(onChange: () => void) {
  clockListeners.add(onChange);
  clockTimer ??= setInterval(() => {
    clock = getFumpadData().now();
    clockListeners.forEach((l) => l());
  }, 15_000);
  return () => {
    clockListeners.delete(onChange);
    if (!clockListeners.size && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
      clock = null;
    }
  };
}
const clientClock = () => (clock ??= getFumpadData().now());

function NowProvider({ initial, children }: { initial: number; children: ReactNode }) {
  const now = useSyncExternalStore(subscribeClock, clientClock, () => initial);
  return <NowCtx.Provider value={now}>{children}</NowCtx.Provider>;
}

/* ── Protocol params ──────────────────────────────────────────────────────── */

/**
 * Global.params for copy that quotes a rule ("Tokens need 30 seconds in your wallet…").
 * Seeded by the root layout from the cached server read, so the prerendered HTML already
 * says the right thing on devnet; re-read when the API announces a params change.
 */
const ParamsCtx = createContext<ProtocolParams>(PARAMS);
export function useProtocolParams() {
  return useContext(ParamsCtx);
}

function ParamsProvider({ initial, children }: { initial: ProtocolParams; children: ReactNode }) {
  const [params, setParams] = useState(initial);
  useLiveMessages((m) => {
    if (m.type === "params") getFumpadData().getParams().then(setParams).catch(keepSnapshot);
  });
  return <ParamsCtx.Provider value={params}>{children}</ParamsCtx.Provider>;
}

/* ── Viewer ───────────────────────────────────────────────────────────────── */

export interface Viewer {
  /** Connected wallet, or the demo wallet while disconnected. */
  address: string;
  connected: boolean;
  isDemo: boolean;
  /** Claimable tickets, for the nav badge. */
  claimable: number;
  setClaimable: (n: number) => void;
}
const ViewerCtx = createContext<Viewer>({ address: DEMO_WALLET, connected: false, isDemo: true, claimable: 0, setClaimable: () => {} });
export function useViewer() {
  return useContext(ViewerCtx);
}

function ViewerProvider({ children }: { children: ReactNode }) {
  const { publicKey, connected } = useWallet();
  const address = connected && publicKey ? publicKey.toBase58() : DEMO_WALLET;
  const [claimable, setClaimable] = useState(0);
  // The nav badge follows the wallet's tickets: its own transactions, anything that touches
  // the wallet, and price moves on the coins it holds tickets in.
  const [ticketMints, setTicketMints] = useState<string[]>([]);
  const current = useRef(address);
  useEffect(() => {
    current.current = address;
  }, [address]);
  const load = useCallback(() => {
    const want = address;
    getFumpadData()
      .getTickets(want)
      .then((ts) => {
        if (want !== current.current) return;
        setClaimable(ts.filter((t) => t.state === "claimable").length);
        const open = [...new Set(ts.filter((t) => ["claimable", "tracking", "queued", "awaiting-graduation"].includes(t.state)).map((t) => t.mint))].sort();
        setTicketMints((prev) => (prev.join() === open.join() ? prev : open));
      })
      .catch(keepSnapshot);
  }, [address]);
  useRefresh(load, { wallets: [address], mints: ticketMints, pollMs: 60_000, debounceMs: 1_500 });
  const value = useMemo(() => ({ address, connected, isDemo: !connected, claimable, setClaimable }), [address, connected, claimable]);
  return <ViewerCtx.Provider value={value}>{children}</ViewerCtx.Provider>;
}

/* ── Root ─────────────────────────────────────────────────────────────────── */

export function Providers({ now, params, children }: { now: number; params: ProtocolParams; children: ReactNode }) {
  // Wallet Standard auto-detects Phantom, Solflare and Backpack; no adapter bundles needed.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect localStorageKey="fumpad-wallet">
        <ParamsProvider initial={params}>
          <ViewerProvider>
            <NowProvider initial={now}>
              <ToastProvider>{children}</ToastProvider>
            </NowProvider>
          </ViewerProvider>
        </ParamsProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
