"use client";

import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import { DEMO_WALLET, getFumpadData } from "@/data";
import { ToastProvider } from "@/design";

const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";

/* ── Clock ────────────────────────────────────────────────────────────────── */

/**
 * The data source's clock. Starts at the server-rendered value so hydration matches,
 * then ticks every 15 s for relative times ("4m").
 */
const NowCtx = createContext<number>(0);
export function useNow() {
  return useContext(NowCtx);
}
function NowProvider({ children }: { children: ReactNode }) {
  const data = getFumpadData();
  // Floor to the minute so the server render and hydration agree.
  const [now, setNow] = useState(() => Math.floor(data.now() / 60_000) * 60_000);
  useEffect(() => {
    const id = setInterval(() => setNow(data.now()), 15_000);
    return () => clearInterval(id);
  }, [data]);
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
      .then((ts) => live && setClaimable(ts.filter((t) => t.state === "claimable").length));
    return () => {
      live = false;
    };
  }, [address]);
  const value = useMemo(() => ({ address, connected, isDemo: !connected, claimable, setClaimable }), [address, connected, claimable]);
  return <ViewerCtx.Provider value={value}>{children}</ViewerCtx.Provider>;
}

/* ── Root ─────────────────────────────────────────────────────────────────── */

export function Providers({ children }: { children: ReactNode }) {
  // Wallet Standard auto-detects Phantom, Solflare and Backpack; no adapter bundles needed.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect localStorageKey="fumpad-wallet">
        <ViewerProvider>
          <NowProvider>
            <ToastProvider>{children}</ToastProvider>
          </NowProvider>
        </ViewerProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
