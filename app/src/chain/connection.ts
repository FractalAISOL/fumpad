/**
 * The cluster the app trades on, from NEXT_PUBLIC_SOLANA_RPC (mainnet when unset). One
 * shared `Connection` for transactions and wallet balances.
 */
import { Connection } from "@solana/web3.js";

export const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.mainnet-beta.solana.com";

export type Cluster = "mainnet" | "devnet" | "testnet";

/** Inferred from the RPC URL: anything that names devnet/testnet is that cluster. */
export const CLUSTER: Cluster = /devnet/i.test(RPC) ? "devnet" : /testnet/i.test(RPC) ? "testnet" : "mainnet";
/** Wallet Standard chain id for signing (`solana:devnet` …). */
export const SOLANA_CHAIN = `solana:${CLUSTER}` as const;
/** "Devnet" / "Testnet"; null on mainnet (nothing to warn about). */
export const CLUSTER_LABEL: string | null = CLUSTER === "mainnet" ? null : CLUSTER === "devnet" ? "Devnet" : "Testnet";

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
  return `https://explorer.solana.com/tx/${signature}${CLUSTER === "mainnet" ? "" : `?cluster=${CLUSTER}`}`;
}
