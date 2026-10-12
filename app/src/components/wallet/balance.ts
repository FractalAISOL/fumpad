"use client";

import { PublicKey } from "@solana/web3.js";
import { useCallback, useRef, useState } from "react";
import { getConnection, LAMPORTS } from "@/chain/connection";
import { DEMO_WALLET } from "@/data";
import { useRefresh } from "../shell/live";
import { WALLET_MODE } from "./store";

/** The demo wallet's simulated SOL (matches the mock data layer's figure). */
const DEMO_SOL = 24.8;

/**
 * A wallet's SOL balance from the RPC: on mount, after own transactions that touch it, and
 * every 15 s. Null while unknown. The mock returns the demo wallet's simulated figure.
 */
export function useSolBalance(address: string | null | undefined): number | null {
  const [bal, setBal] = useState<{ address: string; sol: number } | null>(null);
  const req = useRef(0);
  const load = useCallback(() => {
    if (!address) return;
    const id = ++req.current;
    if (WALLET_MODE === "mock") {
      setBal({ address, sol: address === DEMO_WALLET ? DEMO_SOL : 0 });
      return;
    }
    getConnection()
      .getBalance(new PublicKey(address), "confirmed")
      .then((l) => id === req.current && setBal({ address, sol: l / LAMPORTS }))
      .catch(() => {
        /* RPC hiccup: keep the last figure */
      });
  }, [address]);
  useRefresh(load, { wallets: address ? [address] : [], pollMs: 15_000, debounceMs: 800 });
  return bal && bal.address === address ? bal.sol : null;
}
