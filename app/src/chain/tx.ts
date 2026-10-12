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
 *   register_holdings
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { type BuiltTx, customErrorCode, FUMPAD_IDL } from "@fumpad/sdk";
import { VersionedTransaction } from "@solana/web3.js";
import { useCallback, useMemo, useState } from "react";
import { DEMO_WALLET } from "@/data";
import { solToLamports } from "@/data/chain";
import { mockRecordTrade, mockSetAutoClaim } from "@/data/mock";
import { announceOwnTx, type OwnTxKind } from "@/components/shell/live";
import { buildBuyTx, buildClaimTx, buildSellTx, buildSetAutoClaimTx, fumpadClient } from "./build";
import { checkPreparedLaunch, VANITY_SUFFIX } from "./program";

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
    super("Connect a wallet first.");
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

/**
 * One hook per screen action. `requireWallet` is false in the mock so the demo wallet
 * can act; flip it when the real builders land.
 */
export function useFumpadTx({ requireWallet = false }: { requireWallet?: boolean } = {}) {
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<TxStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<TxOk>, kind: OwnTxKind, mint?: string): Promise<TxOk | null> => {
      setError(null);
      try {
        if (requireWallet && !publicKey) throw new WalletRequiredError();
        const ok = await fn();
        // Confirmed: every mounted view that shows this wallet or coin refetches (components/shell/live.ts).
        announceOwnTx({ kind, mint, wallet: publicKey?.toBase58() ?? DEMO_WALLET, signature: ok.signature });
        return ok;
      } catch (e) {
        setStatus("error");
        setError(txErrorMessage(e));
        return null;
      }
    },
    [publicKey, requireWallet],
  );

  /** Live = the API is configured and a real wallet is connected; otherwise simulate. */
  const live = !!API && !!publicKey;
  const client = useMemo(() => fumpadClient(connection, { solUsdAccount: PYTH_SOL_USD }), [connection]);

  /** Build → wallet signs and sends (v0) → confirm. Program errors surface from preflight. */
  const sendBuilt = useCallback(
    async (build: () => Promise<BuiltTx> | BuiltTx, failed: string): Promise<TxOk> => {
      setStatus("building");
      const built = await build();
      const { tx, blockhash, lastValidBlockHeight } = await client.toTransaction(publicKey!, built);
      if (built.signers?.length) tx.sign(built.signers);
      setStatus("signing");
      const signature = await sendTransaction(tx, connection);
      setStatus("confirming");
      const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(failed);
      setStatus("done");
      return { signature, simulated: false };
    },
    [client, publicKey, sendTransaction, connection],
  );

  const buy = useCallback(
    (args: BuyArgs) =>
      run(
        async () => {
          if (!live) {
            const ok = await simulate(setStatus);
            mockRecordTrade(publicKey?.toBase58() ?? DEMO_WALLET, args.mint, "buy", args.solIn, args.expectedOut ?? args.minTokensOut);
            return ok;
          }
          // Curve → buy; graduated → swap_buy (WSOL wrap/unwrap inside the program). Open
          // tickets for the rebuy rule are read from the wallet's Position on chain.
          return sendBuilt(() => buildBuyTx(client, publicKey!, args), "The buy failed on chain. Nothing but the network fee was spent.");
        },
        "buy",
        args.mint,
      ),
    [run, live, sendBuilt, client, publicKey],
  );

  const sell = useCallback(
    (args: SellArgs) =>
      run(
        async () => {
          if (!live) {
            const ok = await simulate(setStatus);
            mockRecordTrade(publicKey?.toBase58() ?? DEMO_WALLET, args.mint, "sell", args.tokensIn, args.expectedOut ?? args.minSolOut);
            return ok;
          }
          // Curve → sell; graduated → swap_sell. Carries the Pyth SOL/USD account for the
          // minimum-USD ticket check (a stale price never blocks the sell, it just files no ticket).
          return sendBuilt(() => buildSellTx(client, publicKey!, args), "The sell failed on chain. Nothing but the network fee was spent.");
        },
        "sell",
        args.mint,
      ),
    [run, live, sendBuilt, client, publicKey],
  );

  const claim = useCallback(
    (args: ClaimArgs) =>
      run(
        async () => {
          if (!live) return simulate(setStatus, 650);
          // Pays in the same tx (ClaimPaid) or joins the queue (ClaimQueued); the UI re-reads.
          return sendBuilt(() => buildClaimTx(client, publicKey!, args), "The claim failed on chain. Nothing but the network fee was spent.");
        },
        "claim",
        args.mint,
      ),
    [run, live, sendBuilt, client, publicKey],
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
          creator: publicKey!.toBase58(),
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
    [live, publicKey],
  );

  /** D18 step 2 (confirm): the wallet signs as creator/fee payer and the launch is sent. */
  const launch = useCallback(
    (prepared: PreparedLaunch) =>
      run(async () => {
        if (prepared.simulated || !live) return simulate(setStatus, 1400);
        setStatus("building");
        let p = prepared;
        if (Date.now() - p.preparedAt > PREPARED_MAX_AGE_MS) {
          // Blockhash about to expire: the API returns the same reserved mint with a fresh tx.
          const r = await postPrepare({
            creator: publicKey!.toBase58(),
            name: p.args.name,
            symbol: p.args.symbol,
            uri: p.args.uri,
            initialBuyLamports: p.args.initialBuySol > 0 ? solToLamports(p.args.initialBuySol).toString() : undefined,
          });
          if (r.mint !== p.mint) throw new Error("The launch address changed. Review it again before launching.");
          p = { ...p, transaction: r.transaction, lastValidBlockHeight: r.lastValidBlockHeight, preparedAt: Date.now() };
        }
        const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(p.transaction!), (ch) => ch.charCodeAt(0)));
        checkPreparedLaunch(tx, publicKey!, p.mint, p.suffix);
        const before = tx.message.serialize();
        setStatus("signing");
        let signature: string;
        if (signTransaction) {
          const signed = await signTransaction(tx);
          // A wallet that rewrites the message would void the mint's signature: refuse early.
          const after = signed.message.serialize();
          if (after.length !== before.length || after.some((b, i) => b !== before[i])) throw new Error("Your wallet changed the transaction, so it can't be co-signed. Try again.");
          setStatus("confirming");
          signature = await connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
        } else {
          setStatus("confirming");
          signature = await sendTransaction(tx, connection);
        }
        const res = await connection.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: p.lastValidBlockHeight! }, "confirmed");
        if (res.value.err) throw new Error("The launch transaction failed on chain. Nothing but the network fee was spent.");
        setStatus("done");
        return { signature, simulated: false };
      }, "launch", prepared.mint),
    [run, live, publicKey, signTransaction, sendTransaction, connection],
  );

  /** D17: let (or stop) the keeper claim this coin's tickets for you. */
  const setAutoClaim = useCallback(
    (args: AutoClaimArgs) =>
      run(
        async () => {
          if (!live) {
            const owner = args.owner ?? publicKey?.toBase58();
            if (owner) mockSetAutoClaim(owner, args.mint, args.enabled);
            return simulate(setStatus, 600);
          }
          return sendBuilt(() => buildSetAutoClaimTx(client, publicKey!, args), "The change didn't go through.");
        },
        "auto-claim",
        args.mint,
      ),
    [run, live, publicKey, sendBuilt, client],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return { status, error, buy, sell, claim, prepareLaunch, launch, setAutoClaim, reset, live, wallet: publicKey?.toBase58() ?? null };
}
