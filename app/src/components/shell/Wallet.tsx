"use client";

import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar, Button, CopyButton, Dialog, IconExternal, cx } from "@/design";
import { shortAddr } from "@/design/format";
import s from "./Wallet.module.css";

/** The three wallets we name in the UI. Anything else Wallet Standard finds is listed too. */
const KNOWN = [
  { name: "Phantom", url: "https://phantom.com/download" },
  { name: "Solflare", url: "https://solflare.com/download" },
  { name: "Backpack", url: "https://backpack.app/download" },
] as const;

const CONNECT_EVENT = "fumpad:connect-wallet";

/** Open the header's connect dialog from anywhere (e.g. a quick-buy without a wallet). */
export function requestWalletConnect() {
  window.dispatchEvent(new Event(CONNECT_EVENT));
}

/**
 * Connect UI only: pick a wallet, connect, show the address, disconnect. No signing yet;
 * transaction builders live in `@/chain/tx`.
 */
export function WalletButton({ compact }: { compact?: boolean }) {
  const { publicKey, connected, connecting, wallets, wallet, select, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const open = () => setOpen(true);
    window.addEventListener(CONNECT_EVENT, open);
    return () => window.removeEventListener(CONNECT_EVENT, open);
  }, []);

  // After `select`, connect once the adapter is in place.
  useEffect(() => {
    if (!pending || !wallet || wallet.adapter.name !== pending || connected || connecting) return;
    connect()
      .then(() => {
        setPending(null);
        setOpen(false);
      })
      .catch((e: unknown) => {
        setPending(null);
        setErr(e instanceof Error && e.message ? e.message : "The wallet didn't connect. Try again.");
      });
  }, [pending, wallet, connected, connecting, connect]);

  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const missing = KNOWN.filter((k) => !installed.some((w) => w.adapter.name === k.name));
  const addr = publicKey?.toBase58();

  if (connected && addr) {
    return (
      <>
        <button type="button" className={s.chip} onClick={() => setOpen(true)} aria-label={`Wallet ${shortAddr(addr)}`}>
          <Avatar address={addr} size="sm" />
          <span className={cx("num", compact && "sr-only")}>{shortAddr(addr)}</span>
        </button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Your wallet" size="sm">
          <div className={s.acct}>
            <Avatar address={addr} size="lg" />
            <div className={s.acctText}>
              <div className={cx("num", s.acctAddr)}>{shortAddr(addr, 6, 6)}</div>
              <div className={s.acctVia}>Connected with {wallet?.adapter.name}</div>
            </div>
            <CopyButton value={addr} label="Copy address" />
          </div>
          <div className={s.acctActions}>
            <Button variant="line" href={`/u/${addr}`} onClick={() => setOpen(false)} block>
              View profile
            </Button>
            <Button
              variant="ghost"
              block
              onClick={() => {
                void disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </Button>
          </div>
        </Dialog>
      </>
    );
  }

  return (
    <>
      <Button variant="line" size={compact ? "sm" : "md"} onClick={() => setOpen(true)} loading={connecting} aria-label="Connect wallet">
        <span className={s.short}>Connect</span>
        <span className={s.long}>Connect wallet</span>
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setErr(null);
        }}
        title="Connect a wallet"
        description="FUMPAD never moves funds without your signature. Until you connect, screens show a demo wallet."
        size="sm"
      >
        <ul className={s.list}>
          {installed.map((w) => (
            <li key={w.adapter.name}>
              <button
                type="button"
                className={s.row}
                onClick={() => {
                  setErr(null);
                  setPending(w.adapter.name);
                  select(w.adapter.name);
                }}
                aria-busy={pending === w.adapter.name || undefined}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- wallet-provided data URI icon */}
                <img src={w.adapter.icon} alt="" width={28} height={28} className={s.icon} />
                <span className={s.name}>{w.adapter.name}</span>
                <span className={s.state}>{pending === w.adapter.name ? "Connecting…" : "Detected"}</span>
              </button>
            </li>
          ))}
          {missing.map((k) => (
            <li key={k.name}>
              <a className={s.row} href={k.url} target="_blank" rel="noreferrer">
                <span className={s.iconPh} aria-hidden="true">
                  {k.name[0]}
                </span>
                <span className={s.name}>{k.name}</span>
                <span className={s.state}>
                  Install <IconExternal width={14} height={14} />
                </span>
              </a>
            </li>
          ))}
        </ul>
        {err && (
          <p className={s.err} role="alert">
            {err}
          </p>
        )}
        <p className={s.fine}>
          New to Solana wallets?{" "}
          <Link href="https://phantom.com/learn" target="_blank" rel="noreferrer">
            Start with Phantom
          </Link>
          .
        </p>
      </Dialog>
    </>
  );
}
