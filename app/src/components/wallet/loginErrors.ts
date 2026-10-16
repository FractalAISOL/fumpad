/**
 * Login failures in plain words, and the stale-session recovery. Pure (no React, no Privy
 * import) so it can be unit-tested; `PrivyIsland` feeds it Privy's error codes and session
 * events, and the wallet button shows the resulting notice (`LoginNoticeHost`).
 *
 * Why this exists: Privy's Sign-In-With-Solana message always says "Chain ID: mainnet".
 * Phantom in Testnet Mode refuses to sign it, and Privy only shows "Could not log in with
 * wallet" (and logs "Error authenticating session"). Phantom doesn't tell a dapp it is in
 * Testnet Mode, so it is inferred: a Phantom signature failure on a non-mainnet build (where
 * people switch Testnet Mode on for test SOL), or an error text that names the network.
 */
import type { Cluster } from "@/chain/cluster";

export type LoginNoticeKind = "phantom-testnet" | "wallet-signature" | "session-expired";

export interface LoginNotice {
  kind: LoginNoticeKind;
  title: string;
  body: string;
  /** Label of the button that opens login again. */
  action: string;
}

export const PHANTOM_TESTNET_PATH = "Phantom → Settings → Developer Settings → Testnet Mode";

export const NOTICES: Record<LoginNoticeKind, LoginNotice> = {
  "phantom-testnet": {
    kind: "phantom-testnet",
    title: "Turn off Phantom Testnet Mode",
    body: `Phantom is in Testnet Mode. Turn it off (${PHANTOM_TESTNET_PATH}) and try again.`,
    action: "Try again",
  },
  "wallet-signature": {
    kind: "wallet-signature",
    title: "Wallet login didn't finish",
    body: "Your wallet didn't sign the login message. Try again, or use email login.",
    action: "Try again",
  },
  "session-expired": {
    kind: "session-expired",
    title: "Session expired",
    body: "Your session expired. Log in again.",
    action: "Log in",
  },
};

/** The user closed or declined the flow, or Privy shows its own dedicated screen: say nothing. */
const SILENT = new Set([
  "exited_auth_flow",
  "exited_link_flow",
  "exited_update_flow",
  "oauth_user_denied",
  "allowlist_rejected",
  "max_accounts_reached",
  "user_does_not_exist",
  "linked_to_another_user",
  "disallowed_login_method",
  "disallowed_plus_email",
  "account_transfer_required",
]);

/** Codes Privy raises when the wallet's SIWS signature (or the wallet itself) failed. */
const WALLET_CODES = new Set(["generic_connect_wallet_error", "unknown_connect_wallet_error", "unable_to_sign", "invalid_message", "no_solana_accounts"]);

/** Codes that only mean "wallet" when a wallet was part of the attempt (they're shared with email/OAuth). */
const AMBIGUOUS_CODES = new Set(["unknown_auth_error", "invalid_credentials", "invalid_data"]);

/** The session (access/refresh token) is gone or no longer accepted. */
const SESSION_CODES = new Set(["missing_or_invalid_token", "must_be_authenticated"]);

/** An error text that blames the network/cluster (Phantom's wording varies by version). */
const NETWORK_MISMATCH = /testnet|devnet|cluster|network mismatch|wrong network|chain id|unsupported chain/i;

export interface LoginErrorInput {
  /** Privy's error code (`PrivyErrorCode` value) from `useLogin({ onError })`. */
  code: string;
  /** Names of the Wallet Standard wallets connected during the attempt ("Phantom", …). */
  walletNames: readonly string[];
  /** `window.phantom.solana.isPhantom`: Phantom is installed in this browser. */
  phantomInstalled?: boolean;
  /** The cluster this build runs on. */
  cluster: Cluster;
  /** The underlying error text, when one is available. */
  message?: string;
}

const isPhantom = (names: readonly string[]) => names.some((n) => /phantom/i.test(n));

/** What to tell the user about a failed login, or null to stay quiet. */
export function classifyLoginError({ code, walletNames, phantomInstalled = false, cluster, message }: LoginErrorInput): LoginNotice | null {
  if (SILENT.has(code)) return null;
  if (SESSION_CODES.has(code)) return NOTICES["session-expired"];

  const viaWallet = WALLET_CODES.has(code) || (AMBIGUOUS_CODES.has(code) && walletNames.length > 0);
  if (!viaWallet) return null;

  const phantom = isPhantom(walletNames) || (walletNames.length === 0 && phantomInstalled);
  if (phantom && ((message && NETWORK_MISMATCH.test(message)) || cluster !== "mainnet")) return NOTICES["phantom-testnet"];
  if (phantom) {
    // Mainnet build: Testnet Mode is still the usual cause, but cancelling looks the same.
    const w = NOTICES["wallet-signature"];
    return { ...w, body: `${w.body} If Phantom is in Testnet Mode, turn it off first (${PHANTOM_TESTNET_PATH}).` };
  }
  return NOTICES["wallet-signature"];
}

/* ── Stale session ─────────────────────────────────────────────────────────── */

/** Privy's session keys (localStorage / sessionStorage). Analytics ids and app settings are kept. */
export const STALE_PRIVY_KEYS = ["privy:token", "privy:refresh_token", "privy:id_token", "privy:pat", "privy:connections"];

export interface KeyStorage {
  readonly length: number;
  key(i: number): string | null;
  removeItem(k: string): void;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** Removes Privy's session keys (also when Privy namespaces them, e.g. `privy:token:<app>`). Returns the removed keys. */
export function clearStalePrivyStorage(stores: readonly (KeyStorage | null | undefined)[]): string[] {
  const removed: string[] = [];
  for (const st of stores) {
    if (!st) continue;
    try {
      const keys: string[] = [];
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k && STALE_PRIVY_KEYS.some((p) => k === p || k.startsWith(`${p}:`))) keys.push(k);
      }
      for (const k of keys) {
        st.removeItem(k);
        removed.push(k);
      }
    } catch {
      /* storage blocked: nothing to clear */
    }
  }
  return removed;
}

/** `getAccessToken()` result that means the session is dead while Privy still says "authenticated". */
export function isStaleSession(result: { token: string | null } | { error: unknown }): boolean {
  if ("error" in result) return true;
  return !result.token;
}

export const RECOVERY_COOLDOWN_MS = 60_000;
const RECOVERED_AT_KEY = "fumpad.session.recovered.v1";

export interface SessionRecoveryDeps {
  /** Privy's logout (may throw when the session is already broken). */
  logout(): Promise<void>;
  /** Clears the stale local session state. */
  clearStale(): void;
  /** Shows the "session expired" notice. */
  notify(n: LoginNotice): void;
  /** Last resort when logout failed: a reload starts Privy from the cleared storage. */
  reload(): void;
  now(): number;
  /** Remembers the last recovery across reloads (sessionStorage), so a broken session can't loop. */
  memory?: Pick<KeyStorage, "getItem" | "setItem"> | null;
  cooldownMs?: number;
}

/**
 * One recovery at a time, at most one per cooldown (also across a reload), so a session that
 * keeps failing can't log out → log in → log out in a loop. Resolves true when it recovered.
 */
export function createSessionRecovery(deps: SessionRecoveryDeps) {
  const cooldown = deps.cooldownMs ?? RECOVERY_COOLDOWN_MS;
  let busy = false;
  let last = -Infinity;
  const readLast = () => {
    try {
      const v = Number(deps.memory?.getItem(RECOVERED_AT_KEY));
      return Number.isFinite(v) && v > 0 ? Math.max(v, last) : last;
    } catch {
      return last;
    }
  };
  const writeLast = (t: number) => {
    last = t;
    try {
      deps.memory?.setItem(RECOVERED_AT_KEY, String(t));
    } catch {
      /* in memory only */
    }
  };

  return {
    async recover(): Promise<boolean> {
      const t = deps.now();
      if (busy || t - readLast() < cooldown) return false;
      busy = true;
      writeLast(t);
      try {
        let loggedOut = true;
        try {
          await deps.logout();
        } catch {
          loggedOut = false;
        }
        deps.clearStale();
        deps.notify(NOTICES["session-expired"]);
        if (!loggedOut) deps.reload();
        return true;
      } finally {
        busy = false;
      }
    },
  };
}
