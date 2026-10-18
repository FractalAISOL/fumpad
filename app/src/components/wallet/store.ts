"use client";

/**
 * Wallet state outside React's tree. The Privy SDK lives in a lazily loaded island
 * (`PrivyIsland`) that publishes into this store; the rest of the app reads it with
 * `useWallet()`. Without the live API the store runs a simulated Trading wallet instead,
 * so the mock build and /design never load Privy at all.
 */
import type { VersionedTransaction } from "@solana/web3.js";
import type { SignPolicy } from "@/chain/silentGuard";
import { useSyncExternalStore } from "react";
import { DEMO_WALLET } from "@/data";
import { addSpent, INSTANT_WINDOW_MS, parseSpent } from "@/chain/instantWindow";
import { type LoginNotice, type LoginNoticeKind, NOTICES } from "./loginErrors";
import { resolvePrivyAppId } from "./privyConfig";

/**
 * APP-10: NEXT_PUBLIC_PRIVY_APP_ID, no fallback. Null (unset or malformed) = the wallet stays off and login says the
 * build isn't configured; a production build of the live app fails without it (`next.config.ts`).
 */
export const PRIVY_APP_ID: string | null = (() => {
  try {
    return resolvePrivyAppId(process.env.NEXT_PUBLIC_PRIVY_APP_ID);
  } catch {
    return null;
  }
})();
/** Privy only when the live API is configured; the mock world signs nothing. */
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
   * Sign with the account at `address`. `silent` hides the embedded wallet's prompt (no effect on external wallets,
   * which always ask), and only when `policy` allows exactly this transaction: the bridge re-runs the allow-list on
   * the bytes it signs (APP-1, `@/chain/silentGuard`); refused → nothing signed, no policy → the wallet's window.
   */
  signTransaction(address: string, tx: VersionedTransaction, opts: { silent: boolean; policy?: SignPolicy }): Promise<VersionedTransaction>;
  /**
   * `signMessage` with the account at `address` (64-byte ed25519 signature). `silent` is only
   * honoured for a FUMPAD launch message that passes `vetLaunchAuthMessage`; anything else
   * shows the wallet's window (or is refused, see PrivyIsland).
   */
  signMessage(address: string, message: Uint8Array, opts: { silent: boolean }): Promise<Uint8Array>;
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
  async signMessage() {
    throw new Error("The demo wallet doesn't sign messages.");
  },
};

/** Current actions, or a stub that explains the wallet is still loading. */
export function walletActions(): WalletActions {
  if (WALLET_MODE === "mock") return mockActions;
  if (!PRIVY_APP_ID) {
    const off = () => {
      throw new Error("Login isn't configured on this build (NEXT_PUBLIC_PRIVY_APP_ID is missing).");
    };
    return { login: () => console.error("FUMPAD: NEXT_PUBLIC_PRIVY_APP_ID is unset: wallet login is off"), logout: async () => {}, connectExternal: () => {}, createEmbedded: async () => off(), exportKey: async () => off(), signTransaction: async () => off(), signMessage: async () => off() };
  }
  if (actions) return actions;
  const loading = () => {
    throw new Error("The wallet is still loading. Try again in a second.");
  };
  return { login: () => {}, logout: async () => {}, connectExternal: () => {}, createEmbedded: async () => loading(), exportKey: async () => loading(), signTransaction: async () => loading(), signMessage: async () => loading() };
}

export function useWallet() {
  const s = useSyncExternalStore(subscribe, getWalletSnapshot, () => INITIAL);
  return { ...s, active: activeAccount(s) };
}

/* ── Instant trading settings (per browser) ──────────────────────────────── */

export interface InstantSettings {
  /** Sign FUMPAD transactions from the Trading wallet without a prompt. APP-6: off until the user turns it on. */
  enabled: boolean;
  /** Above this many SOL (fee and account rent included) a trade asks first, instant or not. */
  maxSol: number;
  /** L-8 / APP-6: once instant trades have spent this much SOL in this browser (all tabs, `INSTANT_WINDOW_MS`), every trade asks. */
  sessionCapSol: number;
}
export const DEFAULT_INSTANT: InstantSettings = { enabled: false, maxSol: 1, sessionCapSol: 5 };
const INSTANT_KEY = "fumpad.instant.v1";
/** Settings inputs accept (0, 1000] SOL. */
export const validLimit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000;

function readInstant(): InstantSettings {
  try {
    const v = JSON.parse(localStorage.getItem(INSTANT_KEY) ?? "null") as Partial<InstantSettings> | null;
    if (!v) return DEFAULT_INSTANT;
    return {
      // APP-6: on only when the user switched it on (older stored settings without the flag stay off).
      enabled: v.enabled === true,
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
 * L-8 / APP-6: SOL spent by instant (no-popup) transactions, in lamports, per browser origin: localStorage, so every
 * tab adds to (and checks) the same budget, over a rolling window from the first instant spend (`INSTANT_WINDOW_MS`,
 * `@/chain/instantWindow`). Read fresh on every check, so a spend in another tab counts at once.
 */
const SPENT_KEY = "fumpad.instant.spent.v2";
/** Fallback when localStorage is unavailable (private mode): this page only. */
let memSpent: string | null = null;
const spentListeners = new Set<() => void>();
const rawSpent = (): string | null => {
  try {
    return localStorage.getItem(SPENT_KEY);
  } catch {
    return memSpent;
  }
};
export function getInstantSpent(): bigint {
  return parseSpent(rawSpent(), Date.now())?.lamports ?? BigInt(0);
}
/** When the current instant-spend window ends (ms), or null when nothing was spent in it. */
export function getInstantWindowEnd(): number | null {
  const r = parseSpent(rawSpent(), Date.now());
  return r ? r.since + INSTANT_WINDOW_MS : null;
}
function writeSpent(v: string | null) {
  memSpent = v;
  try {
    if (v === null) localStorage.removeItem(SPENT_KEY);
    else localStorage.setItem(SPENT_KEY, v);
  } catch {
    /* kept in memory for this page */
  }
  spentListeners.forEach((l) => l());
}
export function addInstantSpent(lamports: bigint) {
  if (lamports > BigInt(0)) writeSpent(addSpent(rawSpent(), lamports, Date.now()));
}
export function resetInstantSpent() {
  writeSpent(null);
}
/** Other tabs' spends arrive as `storage` events. */
function subscribeSpent(l: () => void) {
  spentListeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === SPENT_KEY || e.key === null) l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    spentListeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
/** Instant spend in the current window (all tabs of this browser), SOL. */
export function useInstantSpentSol(): number {
  return useSyncExternalStore(subscribeSpent, () => Number(getInstantSpent()) / 1e9, () => 0);
}
/** When the current instant-spend window ends (ms), or null. */
export function useInstantWindowEnd(): number | null {
  return useSyncExternalStore(subscribeSpent, getInstantWindowEnd, () => null);
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

/* ── Login notice (failed wallet login, expired session) ─────────────────── */

const NOTICE_KEY = "fumpad.login.notice.v1";
let notice: LoginNotice | null | undefined;
const noticeListeners = new Set<() => void>();
/** "Session expired" survives the reload a failed stale-session logout falls back to (sessionStorage, this tab). */
const readNotice = (): LoginNotice | null => {
  try {
    const k = sessionStorage.getItem(NOTICE_KEY) as LoginNoticeKind | null;
    return k === "session-expired" ? NOTICES[k] : null;
  } catch {
    return null;
  }
};
const getNotice = (): LoginNotice | null => (notice === undefined ? (notice = readNotice()) : notice);

/** Show (or with null, dismiss) the login notice the wallet button renders. */
export function showLoginNotice(n: LoginNotice | null) {
  notice = n;
  try {
    if (n?.kind === "session-expired") sessionStorage.setItem(NOTICE_KEY, n.kind);
    else sessionStorage.removeItem(NOTICE_KEY);
  } catch {
    /* shown for this visit */
  }
  noticeListeners.forEach((l) => l());
}
export function useLoginNotice(): LoginNotice | null {
  return useSyncExternalStore(
    (l) => {
      noticeListeners.add(l);
      return () => noticeListeners.delete(l);
    },
    getNotice,
    () => null,
  );
}
