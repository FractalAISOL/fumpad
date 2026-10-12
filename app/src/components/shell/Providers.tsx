"use client";

import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { keepSnapshot, DEMO_WALLET, getFumpadData } from "@/data";
import { ToastProvider } from "@/design";

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
  useEffect(() => {
    let live = true;
    getFumpadData()
      .getTickets(address)
      .then((ts) => live && setClaimable(ts.filter((t) => t.state === "claimable").length)).catch(keepSnapshot);
    return () => {
      live = false;
    };
  }, [address]);
  const value = useMemo(() => ({ address, connected, isDemo: !connected, claimable, setClaimable }), [address, connected, claimable]);
  return <ViewerCtx.Provider value={value}>{children}</ViewerCtx.Provider>;
}

/* ── Root ─────────────────────────────────────────────────────────────────── */

export function Providers({ now, children }: { now: number; children: ReactNode }) {
  // Wallet Standard auto-detects Phantom, Solflare and Backpack; no adapter bundles needed.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect localStorageKey="fumpad-wallet">
        <ViewerProvider>
          <NowProvider initial={now}>
            <ToastProvider>{children}</ToastProvider>
          </NowProvider>
        </ViewerProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
