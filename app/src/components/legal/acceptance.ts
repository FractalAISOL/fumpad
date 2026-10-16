"use client";

/**
 * The disclaimer acceptance as a tiny external store, so the gate and the wallet (Privy only loads once accepted,
 * `shell/Providers.tsx`) read the same value. The server render and hydration see `null` ("unknown"); the client
 * value follows right after, without a hydration mismatch. Storage rules live in `@/legal/disclaimer`.
 */
import { useSyncExternalStore } from "react";
import { type KeyValueStore, disclaimerKey, readAcceptance, writeAcceptance } from "@/legal/disclaimer";

let accepted: boolean | null = null;
const listeners = new Set<() => void>();

function storage(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function snapshot(): boolean {
  return (accepted ??= readAcceptance(storage()) !== null);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // Accepted in another tab: follow it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== disclaimerKey()) return;
    accepted = null;
    cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** true / false on the client; null during the server render and hydration. */
export function useDisclaimerAccepted(): boolean | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** Records acceptance (in memory for this page view even when storage is blocked). */
export function acceptDisclaimer() {
  writeAcceptance(storage(), Date.now());
  accepted = true;
  listeners.forEach((l) => l());
}
