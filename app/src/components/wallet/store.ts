"use client";

/**
 * Wallet state outside React's tree. The Privy SDK lives in a lazily loaded island
 * (`PrivyIsland`) that publishes into this store; the rest of the app reads it with
 * `useWallet()`. Without the live API the store runs a simulated Trading wallet instead,
 * so the mock build and /design never load Privy at all.
 */
import type { VersionedTransaction } from "@solana/web3.js";
import { useSyncExternalStore } from "react";
import { DEMO_WALLET } from "@/data";

/** Privy only when the live API is configured; the mock world signs nothing. */
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "cmv4vuj3k01c60ejxmuyns783";
export const WALLET_MODE: "privy" | "mock" = process.env.NEXT_PUBLIC_FUMPAD_API ? "privy" : "mock";

export type WalletKind = "embedded" | "external";

export interface WalletAccount {
  address: string;
  kind: WalletKind;
  /** "Trading wallet", or the external wallet's own name ("Phantom"). */
  name: string;
  icon?: string;
}

export interface WalletSnapshot {
  mode: "privy" | "mock";
  /** The wallet SDK has loaded and knows whether someone is logged in. */
  ready: boolean;
  authenticated: boolean;
  /** Email, @handle or short address of the login, for the menu. */
  userLabel: string | null;
  embedded: WalletAccount | null;
  external: WalletAccount | null;
  /** The signer the user picked; falls back to whichever exists. */
  preferred: WalletKind;
  /** The Trading wallet is being created right after login. */
  creating: boolean;
}

export interface WalletActions {
  login(): void;
  logout(): Promise<void>;
  /** Connect Phantom / Solflare / Backpack (Wallet Standard) alongside the Trading wallet. */
  connectExternal(): void;
  createEmbedded(): Promise<void>;
  /** Privy's export window (key shown in an iframe on Privy's origin; FUMPAD never sees it). */
  exportKey(address: string): Promise<void>;
  /**
   * Sign with the account at `address`. `silent` hides the embedded wallet's prompt; it
   * has no effect on external wallets, which always ask.
   */
  signTransaction(address: string, tx: VersionedTransaction, opts: { silent: boolean }): Promise<VersionedTransaction>;
}

const PREF_KEY = "fumpad.wallet.signer.v1";
const readPref = (): WalletKind => {
  try {
    return localStorage.getItem(PREF_KEY) === "external" ? "external" : "embedded";
  } catch {
    return "embedded";
  }
};

const INITIAL: WalletSnapshot = {
  mode: WALLET_MODE,
  ready: WALLET_MODE === "mock",
  authenticated: false,
  userLabel: null,
  embedded: null,
  external: null,
  preferred: "embedded",
  creating: false,
};

let snap: WalletSnapshot = typeof window === "undefined" ? INITIAL : { ...INITIAL, preferred: readPref() };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setWalletSnapshot(patch: Partial<WalletSnapshot>) {
  const next = { ...snap, ...patch };
  if ((Object.keys(next) as (keyof WalletSnapshot)[]).every((k) => Object.is(next[k], snap[k]))) return;
  snap = next;
  emit();
}
export function getWalletSnapshot(): WalletSnapshot {
  return snap;
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setPreferredSigner(kind: WalletKind) {
  try {
    localStorage.setItem(PREF_KEY, kind);
  } catch {
    /* private mode: the choice lasts this visit */
  }
  setWalletSnapshot({ preferred: kind });
}

/** The account FUMPAD signs with: the preferred one if connected, else the other. */
export function activeAccount(s: WalletSnapshot): WalletAccount | null {
  if (!s.authenticated) return null;
  return (s.preferred === "external" ? (s.external ?? s.embedded) : (s.embedded ?? s.external)) ?? null;
}

/* ── Actions ─────────────────────────────────────────────────────────────── */

let actions: WalletActions | null = null;
export function registerWalletActions(a: WalletActions | null) {
  actions = a;
}

const SIM_ADDRESS = DEMO_WALLET;
/** Simulated Trading wallet for the mock build: logs in instantly, signs nothing. */
const mockActions: WalletActions = {
  login() {
    setWalletSnapshot({ authenticated: true, userLabel: "Demo", embedded: { address: SIM_ADDRESS, kind: "embedded", name: "Trading wallet" } });
  },
  async logout() {
    setWalletSnapshot({ authenticated: false, userLabel: null, embedded: null, external: null });
  },
  connectExternal() {},
  async createEmbedded() {},
  async exportKey() {},
  async signTransaction() {
    throw new Error("The demo wallet doesn't sign real transactions.");
  },
};

/** Current actions, or a stub that explains the wallet is still loading. */
export function walletActions(): WalletActions {
  if (WALLET_MODE === "mock") return mockActions;
  if (actions) return actions;
  const loading = () => {
    throw new Error("The wallet is still loading. Try again in a second.");
  };
  return { login: () => {}, logout: async () => {}, connectExternal: () => {}, createEmbedded: async () => loading(), exportKey: async () => loading(), signTransaction: async () => loading() };
}

export function useWallet() {
  const s = useSyncExternalStore(subscribe, getWalletSnapshot, () => INITIAL);
  return { ...s, active: activeAccount(s) };
}

/* ── Instant trading settings (per browser) ──────────────────────────────── */

export interface InstantSettings {
  /** Sign FUMPAD transactions from the Trading wallet without a prompt. */
  enabled: boolean;
  /** Above this many SOL (fee and account rent included) a trade asks first, instant or not. */
  maxSol: number;
  /** L-8: once instant trades have spent this much SOL in this browser session, every trade asks. */
  sessionCapSol: number;
}
export const DEFAULT_INSTANT: InstantSettings = { enabled: true, maxSol: 1, sessionCapSol: 5 };
const INSTANT_KEY = "fumpad.instant.v1";
/** Settings inputs accept (0, 1000] SOL. */
export const validLimit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000;

function readInstant(): InstantSettings {
  try {
    const v = JSON.parse(localStorage.getItem(INSTANT_KEY) ?? "null") as Partial<InstantSettings> | null;
    if (!v) return DEFAULT_INSTANT;
    return {
      enabled: v.enabled !== false,
      maxSol: validLimit(v.maxSol) ? v.maxSol : DEFAULT_INSTANT.maxSol,
      sessionCapSol: validLimit(v.sessionCapSol) ? v.sessionCapSol : DEFAULT_INSTANT.sessionCapSol,
    };
  } catch {
    return DEFAULT_INSTANT;
  }
}
let instant: InstantSettings | null = null;
const instantListeners = new Set<() => void>();
const getInstant = () => (instant ??= readInstant());
export function setInstantSettings(patch: Partial<InstantSettings>) {
  instant = { ...getInstant(), ...patch };
  try {
    localStorage.setItem(INSTANT_KEY, JSON.stringify(instant));
  } catch {
    /* kept for this visit */
  }
  instantListeners.forEach((l) => l());
}
export function useInstantSettings(): InstantSettings {
  return useSyncExternalStore(
    (l) => {
      instantListeners.add(l);
      return () => instantListeners.delete(l);
    },
    getInstant,
    () => DEFAULT_INSTANT,
  );
}
export { getInstant as getInstantSettings };

/*
 * L-8: SOL spent by instant (no-popup) transactions in this browser session, in lamports.
 * sessionStorage: per tab, gone when the tab closes.
 */
const SPENT_KEY = "fumpad.instant.spent.v1";
let spent: bigint | null = null;
const spentListeners = new Set<() => void>();
const readSpent = (): bigint => {
  try {
    const v = sessionStorage.getItem(SPENT_KEY);
    return v && /^\d{1,20}$/.test(v) ? BigInt(v) : BigInt(0);
  } catch {
    return BigInt(0);
  }
};
export function getInstantSpent(): bigint {
  return (spent ??= readSpent());
}
function writeSpent(v: bigint) {
  spent = v;
  try {
    sessionStorage.setItem(SPENT_KEY, v.toString());
  } catch {
    /* kept in memory for this visit */
  }
  spentListeners.forEach((l) => l());
}
export function addInstantSpent(lamports: bigint) {
  if (lamports > BigInt(0)) writeSpent(getInstantSpent() + lamports);
}
export function resetInstantSpent() {
  writeSpent(BigInt(0));
}
/** Instant spend this session, SOL. */
export function useInstantSpentSol(): number {
  return useSyncExternalStore(
    (l) => {
      spentListeners.add(l);
      return () => spentListeners.delete(l);
    },
    () => Number(getInstantSpent()) / 1e9,
    () => 0,
  );
}

/* ── Confirm dialog (rendered by the wallet button) ──────────────────────── */

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
}
type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };
let pending: Pending | null = null;
const confirmListeners = new Set<() => void>();

/** Ask the user on screen; resolves false if they cancel or another request replaces it. */
export function requestConfirm(req: ConfirmRequest): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = {
      ...req,
      resolve: (ok) => {
        pending = null;
        confirmListeners.forEach((l) => l());
        resolve(ok);
      },
    };
    confirmListeners.forEach((l) => l());
  });
}
export function usePendingConfirm(): Pending | null {
  return useSyncExternalStore(
    (l) => {
      confirmListeners.add(l);
      return () => confirmListeners.delete(l);
    },
    () => pending,
    () => null,
  );
}
