"use client";

/**
 * Money in and out of the Trading wallet, the key export, and the on-screen confirm that
 * instant trading uses above the per-trade limit. Withdraw and export always ask: the
 * allow-list never lets a transfer out sign silently on its own.
 */
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { vetWithdrawTx } from "@/chain/allowlist";
import { BASE_FEE_LAMPORTS, CLUSTER, CLUSTER_LABEL, getConnection, LAMPORTS, RENT_EXEMPT_LAMPORTS } from "@/chain/connection";
import { sameMessage } from "@/chain/signer";
import { AmountInput, Button, CopyButton, Dialog, TextInput, cx, parseAmount, useToast } from "@/design";
import * as f from "@/design/format";
import { announceOwnTx } from "../shell/live";
import s from "../shell/Wallet.module.css";
import { useSolBalance } from "./balance";
import { type WalletAccount, usePendingConfirm, walletActions, WALLET_MODE } from "./store";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SOL transfer as a v0 transaction, paid by `from`. */
async function transferTx(from: PublicKey, to: PublicKey, lamports: bigint) {
  const c = getConnection();
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: from, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })] }).compileToV0Message();
  return { tx: new VersionedTransaction(msg), blockhash, lastValidBlockHeight };
}

async function sendAndConfirm(signed: VersionedTransaction, blockhash: string, lastValidBlockHeight: number): Promise<string> {
  const c = getConnection();
  const signature = await c.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
  const res = await c.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error("The transfer failed on chain. Nothing but the network fee was spent.");
  return signature;
}

const toLamports = (sol: number) => BigInt(Math.round(sol * LAMPORTS));
const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const fmt = (n: number) => f.sol(n);

function parseAddress(v: string): PublicKey | null {
  try {
    return v.trim() ? new PublicKey(v.trim()) : null;
  } catch {
    return null;
  }
}

/* ── QR ──────────────────────────────────────────────────────────────────── */

function AddressQr({ value }: { value: string }) {
  const [svg, setSvg] = useState<{ value: string; markup: string } | null>(null);
  useEffect(() => {
    let live = true;
    import("qrcode")
      .then((q) => q.toString(value, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } }))
      .then((markup) => live && setSvg({ value, markup }))
      .catch(() => {
        /* the address and copy button are still there */
      });
    return () => {
      live = false;
    };
  }, [value]);
  return (
    <div className={s.qr} role="img" aria-label="QR code of the Trading wallet address">
      {/* Generated locally from the address; no external markup. */}
      {svg?.value === value && <span dangerouslySetInnerHTML={{ __html: svg.markup }} />}
    </div>
  );
}

/** The address in groups of four so it can be read back aloud. */
function GroupedAddress({ value }: { value: string }) {
  return (
    <code className={cx("num", s.addrFull)} aria-label={value}>
      {value.match(/.{1,4}/g)?.join(" ")}
    </code>
  );
}

function NetworkNote() {
  return CLUSTER_LABEL ? (
    <p className={s.netNote}>
      <span className={s.netTag}>{CLUSTER_LABEL}</span> Send {CLUSTER_LABEL} SOL only. Mainnet SOL sent here won&apos;t show up on FUMPAD.
    </p>
  ) : null;
}

/* ── Deposit ─────────────────────────────────────────────────────────────── */

export function DepositDialog({ open, onClose, trading, external }: { open: boolean; onClose: () => void; trading: WalletAccount; external: WalletAccount | null }) {
  const toast = useToast();
  const extBal = useSolBalance(open ? external?.address : null);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const amount = parseAmount(raw);
  // Leave the external wallet its fee.
  const extMax = extBal === null ? undefined : Math.max(0, extBal - BASE_FEE_LAMPORTS / LAMPORTS);

  const fromExternal = async () => {
    if (!external || !(amount > 0)) return;
    setBusy(true);
    setErr(null);
    try {
      const from = new PublicKey(external.address);
      const { tx, blockhash, lastValidBlockHeight } = await transferTx(from, new PublicKey(trading.address), toLamports(amount));
      // External wallets always show their own approval.
      const signed = await walletActions().signTransaction(external.address, tx, { silent: false });
      if (!sameMessage(tx, signed)) throw new Error("Your wallet changed the transaction, so it wasn't sent.");
      const signature = await sendAndConfirm(signed, blockhash, lastValidBlockHeight);
      announceOwnTx({ kind: "transfer", wallet: trading.address, signature });
      announceOwnTx({ kind: "transfer", wallet: external.address, signature });
      toast(`Deposited ${fmt(amount)} SOL to your Trading wallet.`);
      setRaw("");
      onClose();
    } catch (e) {
      setErr(errMsg(e, "The deposit didn't go through."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Deposit SOL" description="Send SOL to your Trading wallet from any wallet or exchange. It stays yours: withdraw it or export the key any time." size="sm">
      <NetworkNote />
      <div className={s.depositAddr}>
        <AddressQr value={trading.address} />
        <div className={s.depositText}>
          <span className={s.kicker}>Trading wallet address</span>
          <GroupedAddress value={trading.address} />
          <span className={s.copyRow}>
            <CopyButton value={trading.address} label="Copy Trading wallet address" /> Copy address
          </span>
        </div>
      </div>
      {external && WALLET_MODE === "privy" && (
        <div className={s.fromExt}>
          <AmountInput label={`From ${external.name}`} value={raw} onChange={setRaw} unit="SOL" balance={extMax} hint={`${external.name} asks you to approve the transfer.`} />
          <Button block onClick={fromExternal} loading={busy} disabled={!(amount > 0) || (extMax !== undefined && amount > extMax)}>
            {amount > 0 ? `Deposit ${fmt(amount)} SOL` : "Deposit"}
          </Button>
          {err && (
            <p className={s.err} role="alert">
              {err}
            </p>
          )}
        </div>
      )}
      {CLUSTER === "devnet" && (
        <p className={s.fine}>
          Need test SOL?{" "}
          <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
            Use the devnet faucet
          </a>{" "}
          with the address above.
        </p>
      )}
    </Dialog>
  );
}

/* ── Withdraw ────────────────────────────────────────────────────────────── */

/** What withdraw keeps behind: the account's rent-exempt minimum plus this transfer's fee. */
const KEEP_LAMPORTS = RENT_EXEMPT_LAMPORTS + BASE_FEE_LAMPORTS;

export function WithdrawDialog({ open, onClose, trading, external }: { open: boolean; onClose: () => void; trading: WalletAccount; external: WalletAccount | null }) {
  const toast = useToast();
  const bal = useSolBalance(open ? trading.address : null);
  const [raw, setRaw] = useState("");
  const [destRaw, setDestRaw] = useState<string | null>(null);
  const [step, setStep] = useState<"form" | "review">("form");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dest = destRaw ?? external?.address ?? "";
  const destKey = parseAddress(dest);
  const amount = parseAmount(raw);
  const max = bal === null ? undefined : Math.max(0, Math.floor(bal * LAMPORTS) - KEEP_LAMPORTS) / LAMPORTS;
  const destErr = dest && !destKey ? "That isn't a Solana address." : destKey && destKey.toBase58() === trading.address ? "That's the Trading wallet itself." : null;
  const amountErr = max !== undefined && amount > max + 1e-12 ? `At most ${fmt(max)} SOL: ${fmt(KEEP_LAMPORTS / LAMPORTS)} SOL stays for rent and the fee.` : undefined;
  const canReview = amount > 0 && !!destKey && !destErr && !amountErr && max !== undefined;

  const close = () => {
    setStep("form");
    setErr(null);
    onClose();
  };

  const withdraw = async () => {
    if (!canReview || !destKey) return;
    setBusy(true);
    setErr(null);
    try {
      if (WALLET_MODE === "mock") {
        await wait(700);
        toast(`Demo: withdrew ${fmt(amount)} SOL. Nothing moved.`);
        close();
        return;
      }
      const from = new PublicKey(trading.address);
      const lamports = toLamports(amount);
      const { tx, blockhash, lastValidBlockHeight } = await transferTx(from, destKey, lamports);
      // Exactly the transfer the user just confirmed, or nothing.
      vetWithdrawTx(tx, from, destKey, lamports);
      const signed = await walletActions().signTransaction(trading.address, tx, { silent: true });
      if (!sameMessage(tx, signed)) throw new Error("The wallet changed the transaction, so it wasn't sent.");
      const signature = await sendAndConfirm(signed, blockhash, lastValidBlockHeight);
      announceOwnTx({ kind: "transfer", wallet: trading.address, signature });
      announceOwnTx({ kind: "transfer", wallet: destKey.toBase58(), signature });
      toast(`Withdrew ${fmt(amount)} SOL to ${f.shortAddr(destKey.toBase58())}.`);
      setRaw("");
      close();
    } catch (e) {
      setErr(errMsg(e, "The withdrawal didn't go through."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={step === "review" ? "Confirm withdrawal" : "Withdraw SOL"}
      description={step === "review" ? "Check the address. Solana transfers can't be reversed." : "Move SOL out of your Trading wallet."}
      size="sm"
      footer={
        step === "review" ? (
          <>
            <Button variant="ghost" onClick={() => setStep("form")} disabled={busy}>
              Back
            </Button>
            <Button onClick={withdraw} loading={busy}>
              Withdraw {fmt(amount)} SOL
            </Button>
          </>
        ) : (
          <Button onClick={() => setStep("review")} disabled={!canReview}>
            Review
          </Button>
        )
      }
    >
      <NetworkNote />
      {step === "form" ? (
        <div className={s.stack}>
          <AmountInput
            label="Amount"
            value={raw}
            onChange={setRaw}
            unit="SOL"
            balance={max}
            error={amountErr}
            hint={bal === null ? "Reading the balance…" : `Max keeps ${fmt(KEEP_LAMPORTS / LAMPORTS)} SOL in the wallet for rent and the network fee.`}
          />
          <TextInput
            label="To"
            value={dest}
            onChange={(e) => setDestRaw(e.target.value)}
            placeholder="Solana address"
            spellCheck={false}
            autoComplete="off"
            error={destErr ?? undefined}
            hint={external && dest === external.address ? `Your connected ${external.name}.` : external ? undefined : "Connect a wallet to fill this in, or paste any Solana address."}
          />
          {external && dest !== external.address && (
            <Button variant="quiet" size="sm" onClick={() => setDestRaw(null)}>
              Send to {external.name} instead
            </Button>
          )}
        </div>
      ) : (
        <dl className={s.review}>
          <div>
            <dt>Amount</dt>
            <dd className="num">{fmt(amount)} SOL</dd>
          </div>
          <div>
            <dt>From</dt>
            <dd>Trading wallet</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>
              <GroupedAddress value={destKey!.toBase58()} />
            </dd>
          </div>
          <div>
            <dt>Network fee</dt>
            <dd className="num">{fmt(BASE_FEE_LAMPORTS / LAMPORTS)} SOL</dd>
          </div>
        </dl>
      )}
      {err && (
        <p className={s.err} role="alert">
          {err}
        </p>
      )}
    </Dialog>
  );
}

/* ── Export ──────────────────────────────────────────────────────────────── */

export function ExportDialog({ open, onClose, trading }: { open: boolean; onClose: () => void; trading: WalletAccount }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reveal = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (WALLET_MODE === "mock") throw new Error("The demo wallet has no key to export.");
      onClose();
      await walletActions().exportKey(trading.address);
    } catch (e) {
      setErr(errMsg(e, "Couldn't open the export window."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Export your Trading wallet key"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={reveal} loading={busy}>
            Show the key
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <p className={s.body}>
          The key opens in a Privy window that FUMPAD can&apos;t read. Paste it into Phantom, Solflare or Backpack to use this wallet there.
        </p>
        <p className={s.body}>
          <b>Anyone with this key controls the wallet and everything in it.</b> Don&apos;t paste it into a website, a chat or a support form. FUMPAD will never ask
          for it.
        </p>
        {err && (
          <p className={s.err} role="alert">
            {err}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/* ── Confirm (instant trading above the limit) ───────────────────────────── */

export function ConfirmHost() {
  const p = usePendingConfirm();
  return (
    <Dialog
      open={!!p}
      onClose={() => p?.resolve(false)}
      title={p?.title ?? ""}
      size="sm"
      footer={
        p && (
          <>
            <Button variant="ghost" onClick={() => p.resolve(false)}>
              Cancel
            </Button>
            <Button onClick={() => p.resolve(true)}>{p.confirmLabel}</Button>
          </>
        )
      }
    >
      {p && <p className={s.body}>{p.body}</p>}
    </Dialog>
  );
}
