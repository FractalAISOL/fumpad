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
import { PrivyProvider, type User, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useCreateWallet, useExportWallet, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { VersionedTransaction } from "@solana/web3.js";
import { useEffect, useMemo, useRef } from "react";
import { RPC, RPC_WS, SOLANA_CHAIN } from "@/chain/connection";
import { colorDark, colorLight } from "@/design/tokens";
import { PRIVY_APP_ID, registerWalletActions, setWalletSnapshot } from "./store";

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
  const { ready, authenticated, user, login, logout, connectWallet } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { exportWallet } = useExportWallet();
  const { createWallet } = useCreateWallet();

  const embedded = authenticated ? embeddedSolanaAddress(user) : null;
  // The first connected Wallet Standard wallet that isn't the Trading wallet.
  const ext = authenticated ? wallets.find((w) => w.address !== embedded) : undefined;
  const extAddress = ext?.address ?? null;
  const extName = ext?.standardWallet.name ?? null;
  const extIcon = ext?.standardWallet.icon ?? undefined;
  const label = labelOf(user);

  useEffect(() => {
    setWalletSnapshot({
      ready: ready && walletsReady,
      authenticated,
      userLabel: label,
      embedded: embedded ? { address: embedded, kind: "embedded", name: "Trading wallet" } : null,
      external: extAddress ? { address: extAddress, kind: "external", name: extName ?? "Wallet", icon: extIcon } : null,
      creating: authenticated && !embedded,
    });
  }, [ready, walletsReady, authenticated, label, embedded, extAddress, extName, extIcon]);

  // Actions read the latest hooks through a ref so they can be registered once.
  const latest = useRef({ wallets, signTransaction, exportWallet, createWallet, login, logout, connectWallet });
  useEffect(() => {
    latest.current = { wallets, signTransaction, exportWallet, createWallet, login, logout, connectWallet };
  });

  useEffect(() => {
    registerWalletActions({
      login: () => latest.current.login(),
      logout: () => latest.current.logout(),
      connectExternal: () => latest.current.connectWallet({ walletChainType: "solana-only", walletList: ["phantom", "solflare", "backpack", "detected_solana_wallets"] }),
      createEmbedded: async () => {
        await latest.current.createWallet();
      },
      exportKey: (address) => latest.current.exportWallet({ address }),
      async signTransaction(address, tx, { silent }) {
        const w = latest.current.wallets.find((x) => x.address === address);
        if (!w) throw new Error("That wallet isn't connected. Reconnect it from the wallet menu.");
        const { signedTransaction } = await latest.current.signTransaction({
          transaction: tx.serialize(),
          wallet: w,
          chain: SOLANA_CHAIN,
          // Embedded wallet: no Privy window when silent. External wallets always show their own.
          options: { uiOptions: { showWalletUIs: !silent } },
        });
        return VersionedTransaction.deserialize(signedTransaction);
      },
    });
    return () => registerWalletActions(null);
  }, []);

  return null;
}

export default function PrivyIsland() {
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
    <PrivyProvider appId={PRIVY_APP_ID} config={config}>
      <Bridge />
    </PrivyProvider>
  );
}
