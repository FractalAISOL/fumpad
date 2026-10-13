/**
 * One shared `Connection` for transactions and wallet balances, on the cluster in
 * NEXT_PUBLIC_SOLANA_RPC (see ./cluster).
 */
import { Connection } from "@solana/web3.js";
import { CLUSTER, RPC } from "./cluster";

export { CLUSTER, CLUSTER_LABEL, RPC, type Cluster } from "./cluster";

/** Wallet Standard chain id for signing (`solana:devnet` …). */
export const SOLANA_CHAIN = `solana:${CLUSTER}` as const;
/** WebSocket endpoint for the same RPC (http→ws, https→wss). */
export const RPC_WS = RPC.replace(/^http/, "ws");

let conn: Connection | null = null;
export function getConnection(): Connection {
  return (conn ??= new Connection(RPC, "confirmed"));
}

export const LAMPORTS = 1_000_000_000;
/** Rent-exempt minimum for a plain system account (0 data bytes). */
export const RENT_EXEMPT_LAMPORTS = 890_880;
/** One signature's base fee. */
export const BASE_FEE_LAMPORTS = 5_000;

export function explorerTx(signature: string): string {
  const q = CLUSTER === "mainnet" ? "" : CLUSTER === "localnet" ? `?cluster=custom&customUrl=${encodeURIComponent(RPC)}` : `?cluster=${CLUSTER}`;
  return `https://explorer.solana.com/tx/${signature}${q}`;
}
