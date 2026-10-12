"use client";

/**
 * Transaction hooks. The UI calls these. Launch (D18, via the API) and set_auto_claim (D17)
 * are live when NEXT_PUBLIC_FUMPAD_API is set and a wallet is connected; everything else
 * still simulates (delay + fake signature) so
 * every flow can be exercised end to end. Each TODO marks where the real Anchor
 * instruction is built. Amounts arrive in display units and MUST be converted with
 * `@/data/chain` (tokensToBase / solToLamports), never rounded through floats twice.
 *
 * Program instructions (contracts/programs/fumpad/src/lib.rs):
 *   create_coin(name, symbol, uri) · buy(sol_in, min_tokens_out) · sell(tokens_in, min_sol_out)
 *   swap_buy / swap_sell (router, post-graduation) · claim(ticket) · close_ticket
 *   register_holdings
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { useCallback, useState } from "react";
import { solToLamports } from "@/data/chain";
import { mockSetAutoClaim } from "@/data/mock";
import { checkPreparedLaunch, setAutoClaimIx, VANITY_SUFFIX } from "./program";

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
}
export interface SellArgs {
  mint: string;
  tokensIn: number;
  minSolOut: number;
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
    async (fn: () => Promise<TxOk>): Promise<TxOk | null> => {
      setError(null);
      try {
        if (requireWallet && !publicKey) throw new WalletRequiredError();
        return await fn();
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Transaction failed.");
        return null;
      }
    },
    [publicKey, requireWallet],
  );

  const buy = useCallback(
    (args: BuyArgs) =>
      run(async () => {
        void args;
        // TODO(tx): curve → program.methods.buy(solToLamports(args.solIn), tokensToBase(args.minTokensOut))
        //   .remainingAccounts(args.openTickets.map(pubkey => ({ pubkey, isWritable: true, isSigner: false })))
        // graduated → swap_buy via router with PumpSwap accounts in remaining_accounts; wrap/unwrap WSOL in the same tx.
        return simulate(setStatus);
      }),
    [run],
  );

  const sell = useCallback(
    (args: SellArgs) =>
      run(async () => {
        void args;
        // TODO(tx): curve → program.methods.sell(tokensToBase(args.tokensIn), solToLamports(args.minSolOut))
        // graduated → swap_sell. Include the Pyth SOL/USD price update account (ticket ≥ $50 check);
        // a missing/stale price never blocks the sell, it just files no ticket.
        return simulate(setStatus);
      }),
    [run],
  );

  const claim = useCallback(
    (args: ClaimArgs) =>
      run(async () => {
        void args;
        // TODO(tx): program.methods.claim() with ticket, coin, observations ["observations", mint],
        //   claim_queue ["claim_queue", mint], reward_vault ["reward_vault", mint], user ATA.
        // Result is either ClaimPaid (same tx) or ClaimQueued — read the event from the tx logs.
        return simulate(setStatus, 650);
      }),
    [run],
  );

  /** Live = the API is configured and a real wallet is connected; otherwise simulate. */
  const live = !!API && !!publicKey;

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
      }),
    [run, live, publicKey, signTransaction, sendTransaction, connection],
  );

  /** D17: let (or stop) the keeper claim this coin's tickets for you. */
  const setAutoClaim = useCallback(
    (args: AutoClaimArgs) =>
      run(async () => {
        if (!live) {
          const owner = args.owner ?? publicKey?.toBase58();
          if (owner) mockSetAutoClaim(owner, args.mint, args.enabled);
          return simulate(setStatus, 600);
        }
        setStatus("building");
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: publicKey!, blockhash, lastValidBlockHeight }).add(setAutoClaimIx(publicKey!, new PublicKey(args.mint), args.enabled));
        setStatus("signing");
        const signature = await sendTransaction(tx, connection);
        setStatus("confirming");
        const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
        if (res.value.err) throw new Error("The change didn't go through.");
        setStatus("done");
        return { signature, simulated: false };
      }),
    [run, live, publicKey, sendTransaction, connection],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return { status, error, buy, sell, claim, prepareLaunch, launch, setAutoClaim, reset, live, wallet: publicKey?.toBase58() ?? null };
}
