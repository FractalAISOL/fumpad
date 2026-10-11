"use client";

/**
 * Transaction hooks. The UI calls these; today they simulate (delay + fake signature) so
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
import { useCallback, useState } from "react";

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const { publicKey, sendTransaction } = useWallet();
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

  // Referenced so the real builders have them in scope; unused while simulating.
  void connection;
  void sendTransaction;

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

  const launch = useCallback(
    (args: LaunchArgs) =>
      run(async () => {
        void args;
        // TODO(tx): program.methods.createCoin(name, symbol, uri) with a vanity "…fum" mint keypair,
        //   then an optional buy() in the same transaction for initialBuySol.
        return simulate(setStatus, 1400);
      }),
    [run],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return { status, error, buy, sell, claim, launch, reset, wallet: publicKey?.toBase58() ?? null };
}
