"use client";

/**
 * Privy, client-only and lazily loaded (see `shell/Providers`). Login by email, X, Google
 * or a Solana wallet (Phantom, Solflare, Backpack via Wallet Standard). Every user gets an
 * embedded Solana "Trading wallet" on login; it is non-custodial (Privy's TEE/key shares)
 * and exportable from the wallet menu.
 *
 * This component renders only Privy's own modals. It publishes the login and wallets into
 * `./store` and registers the actions (sign, export, connect…) the app calls.
 */
import { PrivyProvider, type User, useLogin, useModalStatus, usePrivy, useToken } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useCreateWallet, useExportWallet, useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { useEffect, useMemo, useRef } from "react";
import { CLUSTER, RPC, RPC_WS, SOLANA_CHAIN } from "@/chain/connection";
import { vetLaunchAuthMessage } from "@/chain/launchAuth";
import { bridgeSignTransaction } from "@/chain/silentGuard";
import { colorDark, colorLight } from "@/design/tokens";
import { classifyLoginError, clearStalePrivyStorage, createSessionRecovery, isStaleSession, type LoginNotice } from "./loginErrors";
import { PRIVY_APP_ID, registerWalletActions, setWalletSnapshot, showLoginNotice } from "./store";

const storage = (kind: "localStorage" | "sessionStorage"): Storage | null => {
  try {
    return window[kind];
  } catch {
    return null;
  }
};
const phantomInstalled = () => (window as { phantom?: { solana?: { isPhantom?: boolean } } }).phantom?.solana?.isPhantom === true;

/** Re-check the session when the tab comes back, at most this often. */
const RECHECK_MS = 60_000;
/** "Setting up wallet" this long after login usually means the session died underneath. */
const STUCK_CREATING_MS = 20_000;

/** Privy's logout as the mounted Bridge provides it (marks the token removal as ours). */
let recoveryLogout: () => Promise<void> = async () => {};
/** Stale-session recovery, one per page (its cooldown also lives in sessionStorage). */
const recovery = createSessionRecovery({
  logout: () => recoveryLogout(),
  clearStale: () => void clearStalePrivyStorage([storage("localStorage"), storage("sessionStorage")]),
  notify: showLoginNotice,
  reload: () => window.location.reload(),
  now: () => Date.now(),
  memory: typeof window === "undefined" ? null : storage("sessionStorage"),
});

/** Phantom, Solflare, Backpack and any other Wallet Standard wallet the browser has. */
const connectors = toSolanaWalletConnectors({ shouldAutoConnect: true });

function embeddedSolanaAddress(user: User | null): string | null {
  for (const a of user?.linkedAccounts ?? []) {
    if (a.type === "wallet" && a.chainType === "solana" && (a.walletClientType === "privy" || a.walletClientType === "privy-v2")) return a.address;
  }
  return null;
}

function labelOf(user: User | null): string | null {
  if (!user) return null;
  if (user.email?.address) return user.email.address;
  if (user.twitter?.username) return `@${user.twitter.username}`;
  if (user.google?.email) return user.google.email;
  return null;
}

function Bridge() {
  const { ready, authenticated, user, logout, connectWallet, getAccessToken } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { isOpen: modalOpen } = useModalStatus();

  /* ── Login failures and stale sessions (see ./loginErrors) ── */
  const modalOpenRef = useRef(modalOpen);
  const authedRef = useRef(authenticated);
  /** A logout we asked for (menu or recovery): its token removal isn't an "expired session". */
  const ownLogout = useRef(false);
  /** A login failure waiting for Privy's window to close before it's explained. */
  const pendingNotice = useRef<LoginNotice | null>(null);
  /** Wallets connected during the attempt (Privy connects before it asks for the SIWS signature). */
  const walletNames = useRef<string[]>([]);
  useEffect(() => {
    walletNames.current = wallets.map((w) => w.standardWallet.name);
  }, [wallets]);

  const { login } = useLogin({
    onError: (code) => {
      const notice = classifyLoginError({
        code,
        walletNames: walletNames.current,
        phantomInstalled: phantomInstalled(),
        cluster: CLUSTER,
      });
      if (!notice) return;
      if (notice.kind === "session-expired") return void recovery.recover();
      if (modalOpenRef.current) pendingNotice.current = notice;
      else showLoginNotice(notice);
    },
  });

  useToken({
    onAccessTokenGranted: () => {},
    onAccessTokenRemoved: () => {
      if (ownLogout.current || !authedRef.current) return;
      void recovery.recover();
    },
  });

  useEffect(() => {
    modalOpenRef.current = modalOpen;
    authedRef.current = authenticated;
    if (authenticated) {
      ownLogout.current = false;
      pendingNotice.current = null;
    } else if (!modalOpen && pendingNotice.current) {
      showLoginNotice(pendingNotice.current);
      pendingNotice.current = null;
    }
  }, [modalOpen, authenticated]);

  // Privy can keep `authenticated` while the session behind it is dead (refresh token expired
  // or revoked): check it after load, when the tab comes back, and when wallet setup hangs.
  const checkRef = useRef(async () => {});
  useEffect(() => {
    checkRef.current = async () => {
      if (!ready || !authenticated) return;
      let r: { token: string | null } | { error: unknown };
      try {
        r = { token: await getAccessToken() };
      } catch (error) {
        r = { error };
      }
      if (isStaleSession(r) && authedRef.current && !ownLogout.current) await recovery.recover();
    };
  });
  useEffect(() => {
    if (ready && authenticated) void checkRef.current();
  }, [ready, authenticated]);
  useEffect(() => {
    let last = 0;
    const on = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < RECHECK_MS) return;
      last = Date.now();
      void checkRef.current();
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const { exportWallet } = useExportWallet();
  const { createWallet } = useCreateWallet();

  const embedded = authenticated ? embeddedSolanaAddress(user) : null;
  // The first connected Wallet Standard wallet that isn't the Trading wallet.
  const ext = authenticated ? wallets.find((w) => w.address !== embedded) : undefined;
  const extAddress = ext?.address ?? null;
  const extName = ext?.standardWallet.name ?? null;
  const extIcon = ext?.standardWallet.icon ?? undefined;
  const label = labelOf(user);

  const creating = authenticated && !embedded;
  useEffect(() => {
    if (!creating || !ready) return;
    const t = setTimeout(() => void checkRef.current(), STUCK_CREATING_MS);
    return () => clearTimeout(t);
  }, [creating, ready]);

  useEffect(() => {
    setWalletSnapshot({
      ready: ready && walletsReady,
      authenticated,
      userLabel: label,
      embedded: embedded ? { address: embedded, kind: "embedded", name: "Trading wallet" } : null,
      external: extAddress ? { address: extAddress, kind: "external", name: extName ?? "Wallet", icon: extIcon } : null,
      creating,
    });
  }, [ready, walletsReady, authenticated, label, embedded, extAddress, extName, extIcon, creating]);

  // Actions read the latest hooks through a ref so they can be registered once.
  const latest = useRef({ wallets, signTransaction, signMessage, exportWallet, createWallet, login, logout, connectWallet });
  useEffect(() => {
    latest.current = { wallets, signTransaction, signMessage, exportWallet, createWallet, login, logout, connectWallet };
  });

  useEffect(() => {
    recoveryLogout = async () => {
      ownLogout.current = true;
      await latest.current.logout();
    };
    return () => {
      recoveryLogout = async () => {};
    };
  }, []);

  useEffect(() => {
    registerWalletActions({
      login: () => latest.current.login(),
      logout: async () => {
        ownLogout.current = true;
        try {
          await latest.current.logout();
        } catch {
          // A session too broken to log out of: clear it locally instead of staying stuck.
          await recovery.recover();
        }
      },
      connectExternal: () => latest.current.connectWallet({ walletChainType: "solana-only", walletList: ["phantom", "solflare", "backpack", "detected_solana_wallets"] }),
      createEmbedded: async () => {
        await latest.current.createWallet();
      },
      exportKey: (address) => latest.current.exportWallet({ address }),
      async signTransaction(address, tx, { silent, policy }) {
        const w = latest.current.wallets.find((x) => x.address === address);
        if (!w) throw new Error("That wallet isn't connected. Reconnect it from the wallet menu.");
        // APP-1: the last line of the transaction allow-list, here and not only in the callers. Every silent signature
        // is re-checked on the exact bytes handed to Privy (`vetFumpadTx` / `vetWithdrawTx` under the caller's policy);
        // a refused one is never signed, and a silent request without a policy shows Privy's approval window instead.
        // External wallets always show their own window.
        return bridgeSignTransaction({ address, tx, silent, policy }, async (bytes, showWalletUIs) => {
          const { signedTransaction } = await latest.current.signTransaction({
            transaction: bytes,
            wallet: w,
            chain: SOLANA_CHAIN,
            options: { uiOptions: { showWalletUIs } },
          });
          return signedTransaction;
        });
      },
      async signMessage(address, message, { silent }) {
        const w = latest.current.wallets.find((x) => x.address === address);
        if (!w) throw new Error("That wallet isn't connected. Reconnect it from the wallet menu.");
        // Last line of the message allow-list: the only message signed without a window is a
        // fresh FUMPAD launch message for this very wallet (throws otherwise).
        if (silent) vetLaunchAuthMessage(message, address);
        const { signature } = await latest.current.signMessage({
          message,
          wallet: w,
          options: { uiOptions: { showWalletUIs: !silent, title: "Confirm you own this wallet", description: "Signing this message proves the launch is yours. It costs nothing and sends nothing." } },
        });
        return signature;
      },
    });
    return () => registerWalletActions(null);
  }, []);

  return null;
}

export default function PrivyIsland() {
  // APP-10: no app id, no Privy (there is no fallback id; production builds fail without one).
  if (!PRIVY_APP_ID) return null;
  return <PrivyRoot appId={PRIVY_APP_ID} />;
}

function PrivyRoot({ appId }: { appId: string }) {
  const config = useMemo(() => {
    const dark =
      document.documentElement.getAttribute("data-theme") === "dark" ||
      (document.documentElement.getAttribute("data-theme") !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    return {
      appearance: {
        theme: dark ? ("dark" as const) : ("light" as const),
        accentColor: (dark ? colorDark.ink : colorLight.ink) as `#${string}`,
        landingHeader: "Log in to FUMPAD",
        loginMessage: "You get a Trading wallet for one-click buys. Yours to withdraw or export.",
        walletChainType: "solana-only" as const,
        showWalletLoginFirst: false,
        // Solana only: the big three by name, then anything else the browser has.
        walletList: ["phantom", "solflare", "backpack", "detected_solana_wallets"] as ("phantom" | "solflare" | "backpack" | "detected_solana_wallets")[],
      },
      loginMethods: ["email", "twitter", "google", "wallet"] as ("email" | "twitter" | "google" | "wallet")[],
      embeddedWallets: {
        solana: { createOnLogin: "all-users" as const },
        ethereum: { createOnLogin: "off" as const },
      },
      externalWallets: { solana: { connectors }, walletConnect: { enabled: false } },
      solana: {
        rpcs: {
          [SOLANA_CHAIN]: { rpc: createSolanaRpc(RPC), rpcSubscriptions: createSolanaRpcSubscriptions(RPC_WS) },
        },
      },
    };
  }, []);
  return (
    <PrivyProvider appId={appId} config={config}>
      <Bridge />
    </PrivyProvider>
  );
}
