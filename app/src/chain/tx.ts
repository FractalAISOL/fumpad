"use client";

/**
 * Transaction hooks. The UI calls these. Every action is live when NEXT_PUBLIC_FUMPAD_API is
 * set and a wallet is connected: buy / sell / claim / set_auto_claim are built by
 * `./build` (via @fumpad/sdk) against the cluster in NEXT_PUBLIC_SOLANA_RPC, launch is
 * prepared by the API (D18). Otherwise (mock, or the demo wallet) they simulate (delay +
 * fake signature) so every flow can be exercised end to end. Amounts arrive in display
 * units and are converted with `@/data/chain` (tokensToBase / solToLamports) in `./build`.
 *
 * Program instructions (contracts/programs/fumpad/src/lib.rs):
 *   create_coin(name, symbol, uri) · buy(sol_in, min_tokens_out) · sell(tokens_in, min_sol_out)
 *   swap_buy / swap_sell (router, post-graduation) · claim(ticket) · close_ticket
 *   register_holdings · withdraw_creator_fees
 */

import { type BuiltTx, customErrorCode, FUMPAD_IDL } from "@fumpad/sdk";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useCallback, useMemo, useRef, useState } from "react";
import { DEMO_WALLET } from "@/data";
import { solToLamports } from "@/data/chain";
import { mockRecordTrade, mockSetAutoClaim, mockWithdrawCreatorFees } from "@/data/mock";
import { announceOwnTx, type OwnTxKind } from "@/components/shell/live";
import { requestConfirm, useInstantSettings, useWallet, walletActions } from "@/components/wallet/store";
import type { SilentPolicy } from "./allowlist";
import { buildBuyTx, buildClaimTx, buildSellTx, buildSetAutoClaimTx, buildWithdrawCreatorFeesTx, fumpadClient } from "./build";
import { getConnection } from "./connection";
import { checkPreparedLaunch, VANITY_SUFFIX } from "./program";
import { type FumpadSigner, signFumpadTx } from "./signer";

export interface TxOk {
  signature: string;
  /** True while running against the mock data source. */
  simulated: boolean;
}

export type TxStatus = "idle" | "building" | "signing" | "confirming" | "done" | "error";

export interface BuyArgs {
  mint: string;
  solIn: number;
  /** Minimum tokens after slippage. */
  minTokensOut: number;
  /** Every open ticket on this coin (≤5): the program applies the rebuy rule to them. */
  openTickets: string[];
  /** Quoted tokens out (mock mode applies it to the simulated balance). */
  expectedOut?: number;
}
export interface SellArgs {
  mint: string;
  tokensIn: number;
  minSolOut: number;
  /** Quoted SOL out (mock mode applies it to the simulated balance). */
  expectedOut?: number;
}
export interface ClaimArgs {
  mint: string;
  ticket: string;
}
export interface LaunchArgs {
  name: string;
  symbol: string;
  /** Metadata JSON URI (image + description), uploaded before the transaction. */
  uri: string;
  initialBuySol: number;
}

/**
 * A launch the API has prepared (D18): a reserved `…fmbL` mint and a transaction already
 * signed by that mint; the wallet signs as creator/fee payer. Mock mode returns a fake
 * `…fmbL` address so the review step looks the same.
 */
export interface PreparedLaunch {
  mint: string;
  suffix: string;
  simulated: boolean;
  args: LaunchArgs;
  preparedAt: number;
  /** base64 v0 transaction (live only). */
  transaction?: string;
  lastValidBlockHeight?: number;
}

export interface AutoClaimArgs {
  mint: string;
  enabled: boolean;
  /** Mock mode: whose tickets to update (the demo wallet when no wallet is connected). */
  owner?: string;
}

/** Blockhashes live ~60–90 s; re-prepare (same mint comes back) before signing an older one. */
const PREPARED_MAX_AGE_MS = 45_000;

export class WalletRequiredError extends Error {
  constructor() {
    super("Log in first.");
  }
}

const fakeSig = () => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 88; i++) s += B58[Math.floor(Math.random() * 58)];
  return s;
};
const fakeMint = () => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 40; i++) s += B58[Math.floor(Math.random() * 58)];
  return s + VANITY_SUFFIX;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The live API base when configured (same switch as the data layer). */
const API = process.env.NEXT_PUBLIC_FUMPAD_API?.replace(/\/+$/, "");
/** Pyth SOL/USD PriceUpdateV2 account for sells (SDK default: the sponsored feed, on mainnet and devnet). */
const PYTH_SOL_USD = process.env.NEXT_PUBLIC_PYTH_SOL_USD || undefined;

async function postPrepare(body: Record<string, unknown>): Promise<{ mint: string; transaction: string; lastValidBlockHeight: number; suffix: string }> {
  const res = await fetch(`${API}/v1/launch/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.status === 503 ? "No launch addresses are ready right now. Try again in a minute." : "Couldn't prepare the launch.";
    try {
      const e = ((await res.json()) as { error?: string }).error;
      if (e && res.status < 500) msg = e.charAt(0).toUpperCase() + e.slice(1) + ".";
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return res.json();
}

/** Program errors (preflight / confirmation) → the IDL's message, e.g. "Price has not held 10x the sell price." */
function txErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const logs = (e as { logs?: unknown } | null)?.logs;
  const code = customErrorCode(raw + (logs ? JSON.stringify(logs) : ""));
  const known = code === null ? undefined : ((FUMPAD_IDL.errors ?? []) as { code: number; msg?: string }[]).find((x) => x.code === code);
  if (known?.msg) return known.msg.endsWith(".") ? known.msg : `${known.msg}.`;
  return raw || "Transaction failed.";
}

async function simulate(setStatus: (s: TxStatus) => void, ms = 900): Promise<TxOk> {
  setStatus("building");
  await wait(ms * 0.3);
  setStatus("signing");
  await wait(ms * 0.3);
  setStatus("confirming");
  await wait(ms * 0.4);
  setStatus("done");
  return { signature: fakeSig(), simulated: true };
}

/** The active wallet as a `FumpadSigner` (live mode only; the mock signs nothing). */
function useActiveSigner(): FumpadSigner | null {
  const { mode, active } = useWallet();
  const address = active?.address;
  const kind = active?.kind;
  const name = active?.name;
  return useMemo(() => {
    if (mode !== "privy" || !address || !kind) return null;
    return {
      publicKey: new PublicKey(address),
      kind,
      name: name ?? "Wallet",
      sign: (tx, opts) => walletActions().signTransaction(address, tx, opts),
    } satisfies FumpadSigner;
  }, [mode, address, kind, name]);
}

const fmtSol = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3)).replace(/\.?0+$/, "");

/**
 * One hook per screen action. `requireWallet` is false in the mock so the demo wallet
 * can act.
 *
 * Signing: the Trading wallet (Privy embedded) with Instant trading on signs vetted FUMPAD
 * transactions without a prompt (`./signer`, `./allowlist`); above the per-trade limit an
 * on-screen confirm comes first. With Instant off, Privy shows its own approval window.
 * External wallets always prompt.
 */
export function useFumpadTx({ requireWallet = false }: { requireWallet?: boolean } = {}) {
  const wallet = useWallet();
  const settings = useInstantSettings();
  const signer = useActiveSigner();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  /** The latest error without waiting for a re-render (callers read it right after `await`). */
  const errorRef = useRef<string | null>(null);
  const connection = getConnection();
  const owner = wallet.active?.address ?? DEMO_WALLET;
  /** The active wallet signs without a popup (Trading wallet + Instant trading on; also the demo wallet). */
  const instant = wallet.active?.kind === "embedded" && settings.enabled;

  /**
   * Above the per-trade limit, instant signing asks on screen first. Prompting wallets
   * (external, or Instant off) already ask, so they skip this.
   */
  const guardSpend = useCallback(
    async (sol: number, verb: string) => {
      if (!instant || !(sol > settings.maxSol)) return;
      const ok = await requestConfirm({
        title: `${verb} ${fmtSol(sol)} SOL?`,
        body: `That's above your instant limit of ${fmtSol(settings.maxSol)} SOL, so FUMPAD asks first. Change the limit in the wallet menu.`,
        confirmLabel: `${verb} ${fmtSol(sol)} SOL`,
      });
      if (!ok) throw new Error("Cancelled. Nothing was sent.");
    },
    [instant, settings.maxSol],
  );

  const run = useCallback(
    async (fn: () => Promise<TxOk>, kind: OwnTxKind, mint?: string): Promise<TxOk | null> => {
      setError(null);
      errorRef.current = null;
      try {
        if (requireWallet && !wallet.active) throw new WalletRequiredError();
        const ok = await fn();
        // Confirmed: every mounted view that shows this wallet or coin refetches (components/shell/live.ts).
        announceOwnTx({ kind, mint, wallet: owner, signature: ok.signature });
        return ok;
      } catch (e) {
        setStatus("error");
        errorRef.current = txErrorMessage(e);
        setError(errorRef.current);
        return null;
      }
    },
    [owner, requireWallet, wallet.active],
  );

  /** Live = the API is configured and a real wallet is logged in; otherwise simulate. */
  const live = !!API && !!signer;
  const client = useMemo(() => fumpadClient(connection, { solUsdAccount: PYTH_SOL_USD }), [connection]);

  /** Build → vet + sign (silently when allowed) → send → confirm. Program errors surface from preflight. */
  const sendBuilt = useCallback(
    async (build: () => Promise<BuiltTx> | BuiltTx, failed: string, policy: SilentPolicy): Promise<TxOk> => {
      const s = signer!;
      setStatus("building");
      const built = await build();
      const { tx, blockhash, lastValidBlockHeight } = await client.toTransaction(s.publicKey, built);
      if (built.signers?.length) tx.sign(built.signers);
      setStatus("signing");
      const signed = await signFumpadTx(s, tx, policy, instant);
      setStatus("confirming");
      const signature = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
      const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(failed);
      setStatus("done");
      return { signature, simulated: false };
    },
    [client, signer, connection, instant],
  );

  const buy = useCallback(
    (args: BuyArgs) =>
      run(
        async () => {
          await guardSpend(args.solIn, "Buy");
          if (!live) {
            const ok = await simulate(setStatus);
            mockRecordTrade(owner, args.mint, "buy", args.solIn, args.expectedOut ?? args.minTokensOut);
            return ok;
          }
          // Curve → buy; graduated → swap_buy (WSOL wrap/unwrap inside the program). Open
          // tickets for the rebuy rule are read from the wallet's Position on chain. The
          // signed sol_in may not exceed what the user entered.
          return sendBuilt(() => buildBuyTx(client, signer!.publicKey, args), "The buy failed on chain. Nothing but the network fee was spent.", {
            action: "buy",
            maxSolInLamports: solToLamports(args.solIn),
          });
        },
        "buy",
        args.mint,
      ),
    [run, guardSpend, live, sendBuilt, client, signer, owner],
  );

  const sell = useCallback(
    (args: SellArgs) =>
      run(
        async () => {
          await guardSpend(args.expectedOut ?? args.minSolOut, "Sell for");
          if (!live) {
            const ok = await simulate(setStatus);
            mockRecordTrade(owner, args.mint, "sell", args.tokensIn, args.expectedOut ?? args.minSolOut);
            return ok;
          }
          // Curve → sell; graduated → swap_sell. Carries the Pyth SOL/USD account for the
          // minimum-USD ticket check (a stale price never blocks the sell, it just files no ticket).
          return sendBuilt(() => buildSellTx(client, signer!.publicKey, args), "The sell failed on chain. Nothing but the network fee was spent.", { action: "sell" });
        },
        "sell",
        args.mint,
      ),
    [run, guardSpend, live, sendBuilt, client, signer, owner],
  );

  const claim = useCallback(
    (args: ClaimArgs) =>
      run(
        async () => {
          if (!live) return simulate(setStatus, 650);
          // Pays in the same tx (ClaimPaid) or joins the queue (ClaimQueued); the UI re-reads.
          return sendBuilt(() => buildClaimTx(client, signer!.publicKey, args), "The claim failed on chain. Nothing but the network fee was spent.", { action: "claim" });
        },
        "claim",
        args.mint,
      ),
    [run, live, sendBuilt, client, signer],
  );

  /**
   * D18 step 1 (review): reserve a `…fmbL` mint. Live: `POST /v1/launch/prepare` returns the
   * mint and a create_coin(+first buy) transaction the server already signed AS THE MINT
   * (the mint's secret never leaves the server). Mock: a fake `…fmbL` address.
   */
  const prepareLaunch = useCallback(
    async (args: LaunchArgs): Promise<PreparedLaunch | null> => {
      setError(null);
      setStatus("building");
      try {
        if (!live) {
          await wait(350);
          setStatus("idle");
          return { mint: fakeMint(), suffix: VANITY_SUFFIX, simulated: true, args, preparedAt: Date.now() };
        }
        const r = await postPrepare({
          creator: signer!.publicKey.toBase58(),
          name: args.name,
          symbol: args.symbol,
          uri: args.uri,
          initialBuyLamports: args.initialBuySol > 0 ? solToLamports(args.initialBuySol).toString() : undefined,
        });
        setStatus("idle");
        return { mint: r.mint, suffix: r.suffix, simulated: false, args, preparedAt: Date.now(), transaction: r.transaction, lastValidBlockHeight: r.lastValidBlockHeight };
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Couldn't prepare the launch.");
        return null;
      }
    },
    [live, signer],
  );

  /**
   * D18 step 2 (confirm): the wallet signs as creator/fee payer and the launch is sent. The
   * API's transaction is checked twice before signing: `checkPreparedLaunch` (shape, mint,
   * creator) and the silent-signing allow-list (programs, signers, first-buy amount).
   */
  const launch = useCallback(
    (prepared: PreparedLaunch) =>
      run(async () => {
        await guardSpend(prepared.args.initialBuySol, "Launch with a first buy of");
        if (prepared.simulated || !live) return simulate(setStatus, 1400);
        const s = signer!;
        setStatus("building");
        let p = prepared;
        if (Date.now() - p.preparedAt > PREPARED_MAX_AGE_MS) {
          // Blockhash about to expire: the API returns the same reserved mint with a fresh tx.
          const r = await postPrepare({
            creator: s.publicKey.toBase58(),
            name: p.args.name,
            symbol: p.args.symbol,
            uri: p.args.uri,
            initialBuyLamports: p.args.initialBuySol > 0 ? solToLamports(p.args.initialBuySol).toString() : undefined,
          });
          if (r.mint !== p.mint) throw new Error("The launch address changed. Review it again before launching.");
          p = { ...p, transaction: r.transaction, lastValidBlockHeight: r.lastValidBlockHeight, preparedAt: Date.now() };
        }
        const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(p.transaction!), (ch) => ch.charCodeAt(0)));
        checkPreparedLaunch(tx, s.publicKey, p.mint, p.suffix);
        setStatus("signing");
        // A wallet that rewrites the message would void the mint's signature: signFumpadTx refuses it.
        const signed = await signFumpadTx(s, tx, { action: "launch", coSigner: p.mint, maxSolInLamports: solToLamports(p.args.initialBuySol) }, instant);
        setStatus("confirming");
        const signature = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
        const res = await connection.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: p.lastValidBlockHeight! }, "confirmed");
        if (res.value.err) throw new Error("The launch transaction failed on chain. Nothing but the network fee was spent.");
        setStatus("done");
        return { signature, simulated: false };
      }, "launch", prepared.mint),
    [run, guardSpend, live, signer, instant, connection],
  );

  /** D17: let (or stop) the keeper claim this coin's tickets for you. */
  const setAutoClaim = useCallback(
    (args: AutoClaimArgs) =>
      run(
        async () => {
          if (!live) {
            const o = args.owner ?? wallet.active?.address;
            if (o) mockSetAutoClaim(o, args.mint, args.enabled);
            return simulate(setStatus, 600);
          }
          return sendBuilt(() => buildSetAutoClaimTx(client, signer!.publicKey, args), "The change didn't go through.", { action: "auto-claim" });
        },
        "auto-claim",
        args.mint,
      ),
    [run, live, wallet.active, sendBuilt, client, signer],
  );

  /** Creator: move the coin's unclaimed creator fees to the wallet. */
  const withdrawCreatorFees = useCallback(
    (args: { mint: string }) =>
      run(
        async () => {
          if (!live) {
            mockWithdrawCreatorFees(args.mint);
            return simulate(setStatus, 700);
          }
          return sendBuilt(() => buildWithdrawCreatorFeesTx(client, signer!.publicKey, args), "The withdrawal failed on chain. Nothing but the network fee was spent.", {
            action: "withdraw",
          });
        },
        "withdraw",
        args.mint,
      ),
    [run, live, sendBuilt, client, signer],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    errorRef.current = null;
  }, []);
  const lastError = useCallback(() => errorRef.current, []);

  return {
    status,
    error,
    lastError,
    buy,
    sell,
    claim,
    prepareLaunch,
    launch,
    setAutoClaim,
    withdrawCreatorFees,
    reset,
    live,
    /** True when the active wallet signs without a popup (copy: "Signing…" instead of "Approve it in your wallet."). */
    instant,
    wallet: wallet.active?.address ?? null,
  };
}
