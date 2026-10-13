"use client";

import { useEffect, useState } from "react";
import { CLUSTER_LABEL } from "@/chain/connection";
import { useSolBalance } from "@/components/wallet/balance";
import { ConfirmHost, DepositDialog, ExportDialog, WithdrawDialog } from "@/components/wallet/Dialogs";
import {
  type WalletKind,
  setInstantSettings,
  setPreferredSigner,
  useInstantSettings,
  useInstantSpentSol,
  useWallet,
  walletActions,
} from "@/components/wallet/store";
import { Avatar, Button, CopyButton, Dialog, IconBolt, Segmented, cx, useToast } from "@/design";
import * as f from "@/design/format";
import s from "./Wallet.module.css";

const CONNECT_EVENT = "fumpad:connect-wallet";

/** Open login (or the wallet menu when logged in) from anywhere, e.g. a quick-buy without a wallet. */
export function requestWalletConnect() {
  window.dispatchEvent(new Event(CONNECT_EVENT));
}

/** "12.40 SOL", or a dash while the balance loads. */
const balText = (n: number | null) => (n === null ? "– SOL" : `${f.sol(n)} SOL`);

/**
 * The header wallet: Log in, then the active signer with its SOL balance. The menu
 * switches signer (Trading wallet ⇄ external), deposits, withdraws, exports the key, sets
 * instant trading, and logs out.
 */
export function WalletButton({ compact }: { compact?: boolean }) {
  const w = useWallet();
  const toast = useToast();
  const instant = useInstantSettings();
  const spentSol = useInstantSpentSol();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<"deposit" | "withdraw" | "export" | null>(null);
  const active = w.active;
  const bal = useSolBalance(active?.address);
  const tradingBal = useSolBalance(open && w.embedded && active?.kind !== "embedded" ? w.embedded.address : null);

  const login = () => {
    walletActions().login();
    if (w.mode === "mock") toast("Demo: a simulated Trading wallet. Trades are simulated.");
  };

  useEffect(() => {
    const on = () => {
      const st = w.authenticated;
      if (st) setOpen(true);
      else login();
    };
    window.addEventListener(CONNECT_EVENT, on);
    return () => window.removeEventListener(CONNECT_EVENT, on);
  });

  if (!w.authenticated || !active) {
    const creating = w.authenticated && w.creating;
    return (
      <>
        <Button variant="line" size={compact ? "sm" : "md"} onClick={login} loading={!w.ready || creating} aria-label={creating ? "Creating your Trading wallet" : "Log in"}>
          <span className={s.short}>Log in</span>
          <span className={s.long}>{creating ? "Setting up wallet" : "Log in"}</span>
        </Button>
        <ConfirmHost />
      </>
    );
  }

  const isTrading = active.kind === "embedded";
  const instantOn = isTrading && instant.enabled;
  const trading = w.embedded;
  const close = () => setOpen(false);
  const openSheet = (k: "deposit" | "withdraw" | "export") => {
    setOpen(false);
    setSheet(k);
  };

  return (
    <>
      <button
        type="button"
        className={s.chip}
        onClick={() => setOpen(true)}
        aria-label={`Wallet: ${active.name} ${f.shortAddr(active.address)}, ${balText(bal)}${instantOn ? ", instant trading on" : ""}`}
      >
        <span className={s.chipAvatar}>
          <Avatar address={active.address} size="sm" />
        </span>
        <span className={cx(s.chipText, compact && "sr-only")}>
          <span className={cx("num", s.chipAddr)}>{f.shortAddr(active.address)}</span>
          <span className={cx("num", s.chipBal)}>
            {instantOn && <IconBolt width={11} height={11} aria-hidden="true" />}
            {balText(bal)}
          </span>
        </span>
        {CLUSTER_LABEL && <span className={s.chipNet}>{CLUSTER_LABEL}</span>}
      </button>

      <Dialog open={open} onClose={close} title="Wallet" size="sm">
        {CLUSTER_LABEL && (
          <p className={s.netNote}>
            <span className={s.netTag}>{CLUSTER_LABEL}</span> FUMPAD is on Solana {CLUSTER_LABEL}. Test SOL only; nothing here is worth money.
          </p>
        )}

        {trading && w.external && (
          <div className={s.signerPick}>
            <span className={s.kicker} id="signer-label">
              Sign with
            </span>
            <Segmented<WalletKind>
              block
              size="sm"
              label="Sign with"
              value={active.kind}
              onChange={setPreferredSigner}
              items={[
                { value: "embedded", label: "Trading wallet" },
                { value: "external", label: w.external.name },
              ]}
            />
          </div>
        )}

        <div className={s.acct}>
          <Avatar address={active.address} size="lg" />
          <div className={s.acctText}>
            <div className={s.acctName}>{active.name}</div>
            <div className={cx("num", s.acctAddr)}>{f.shortAddr(active.address, 6, 6)}</div>
          </div>
          <CopyButton value={active.address} label={`Copy ${active.name} address`} />
        </div>
        <div className={s.balance}>
          <span className={cx("num", s.balNum)}>{bal === null ? "–" : f.sol(bal)}</span>
          <span className={s.balUnit}>SOL</span>
        </div>
        <p className={s.acctVia}>
          {isTrading
            ? instant.enabled
              ? `Signs FUMPAD trades instantly, no popup. Above ${f.sol(instant.maxSol)} SOL a transaction, or ${f.sol(instant.sessionCapSol)} SOL this session, it asks first.`
              : "Instant trading is off: Privy asks you to approve each transaction."
            : `${active.name} asks you to approve every transaction.`}
          {!isTrading && trading && tradingBal !== null && <> Trading wallet: {balText(tradingBal)}.</>}
        </p>

        {trading && (
          <div className={s.moneyRow}>
            <Button variant="line" onClick={() => openSheet("deposit")} block>
              Deposit
            </Button>
            <Button variant="line" onClick={() => openSheet("withdraw")} block>
              Withdraw
            </Button>
          </div>
        )}

        {trading && (
          <section className={s.instant} aria-labelledby="instant-h">
            <div className={s.instantHead}>
              <h3 id="instant-h" className={s.instantH}>
                <IconBolt width={14} height={14} aria-hidden="true" /> Instant trading
              </h3>
              <Segmented<"on" | "off">
                size="sm"
                label="Instant trading"
                value={instant.enabled ? "on" : "off"}
                onChange={(v) => setInstantSettings({ enabled: v === "on" })}
                items={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
              />
            </div>
            <label className={s.limit}>
              <span>Ask first above</span>
              <LimitInput value={instant.maxSol} onChange={(maxSol) => setInstantSettings({ maxSol })} label="Ask first above this many SOL per transaction" />
              <span className={s.limitUnit}>SOL</span>
            </label>
            <label className={s.limit}>
              <span>Session cap</span>
              <LimitInput value={instant.sessionCapSol} onChange={(sessionCapSol) => setInstantSettings({ sessionCapSol })} label="Session cap for instant trading, SOL" />
              <span className={s.limitUnit}>SOL</span>
            </label>
            <p className={s.fine}>
              Spent instantly this session: <span className="num">{f.sol(spentSol)}</span> of {f.sol(instant.sessionCapSol)} SOL.
              {spentSol >= instant.sessionCapSol ? " The cap is reached, so every transaction asks first until you close this tab." : ""}
            </p>
            <p className={s.fine}>
              Buys, sells, claims and launches from the Trading wallet sign without a popup, and only if they are FUMPAD transactions on the coin you&apos;re trading. The
              per-transaction limit counts the pool fee, network fees and first-time account rent. Withdrawals and key export always ask.
            </p>
          </section>
        )}

        <ul className={s.menu}>
          <li>
            <Button variant="ghost" href={`/u/${active.address}`} onClick={close} block className={s.menuBtn}>
              View profile
            </Button>
          </li>
          {trading && (
            <li>
              <Button variant="ghost" onClick={() => openSheet("export")} block className={s.menuBtn}>
                Export Trading wallet key
              </Button>
            </li>
          )}
          {!w.external && w.mode === "privy" && (
            <li>
              <Button
                variant="ghost"
                onClick={() => {
                  close();
                  walletActions().connectExternal();
                }}
                block
                className={s.menuBtn}
              >
                Connect Phantom, Solflare or Backpack
              </Button>
            </li>
          )}
          <li>
            <Button
              variant="ghost"
              onClick={() => {
                close();
                void walletActions().logout();
              }}
              block
              className={s.menuBtn}
            >
              Log out
            </Button>
          </li>
        </ul>
        {w.userLabel && <p className={s.fine}>Logged in as {w.userLabel}.</p>}
      </Dialog>

      {trading && (
        <>
          <DepositDialog open={sheet === "deposit"} onClose={() => setSheet(null)} trading={trading} external={w.external} />
          <WithdrawDialog open={sheet === "withdraw"} onClose={() => setSheet(null)} trading={trading} external={w.external} />
          <ExportDialog open={sheet === "export"} onClose={() => setSheet(null)} trading={trading} />
        </>
      )}
      <ConfirmHost />
    </>
  );
}

/** The per-trade limit, committed on blur so typing "0.5" doesn't pass through "0". */
function LimitInput({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [raw, setRaw] = useState<string | null>(null);
  const bad = raw !== null && !(Number(raw) > 0 && Number(raw) <= 1000);
  return (
    <input
      className={cx("num", s.limitInput)}
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={bad || undefined}
      value={raw ?? String(value)}
      onChange={(e) => {
        const v = e.target.value.replace(/[^\d.]/g, "");
        setRaw(v);
        if (Number(v) > 0 && Number(v) <= 1000) onChange(Number(v));
      }}
      onBlur={() => setRaw(null)}
    />
  );
}
