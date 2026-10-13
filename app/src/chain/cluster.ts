/**
 * The cluster the app runs on, from NEXT_PUBLIC_SOLANA_RPC (mainnet when unset). No web3.js
 * import, so server components (the footer, docs pages) can read it for free.
 */
export const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.mainnet-beta.solana.com";

export type Cluster = "mainnet" | "devnet" | "testnet";

/** Inferred from the RPC URL: anything that names devnet/testnet is that cluster. */
export const CLUSTER: Cluster = /devnet/i.test(RPC) ? "devnet" : /testnet/i.test(RPC) ? "testnet" : "mainnet";
/** "Devnet" / "Testnet"; null on mainnet (nothing to warn about). */
export const CLUSTER_LABEL: string | null = CLUSTER === "mainnet" ? null : CLUSTER === "devnet" ? "Devnet" : "Testnet";

/** The FUMPAD v0.7 program (D39: a new id, the same on devnet and mainnet; contracts/INTERFACE-v0.7.md). */
export const FUMPAD_PROGRAM_ADDRESS = "5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb";
/** Solscan link for an account on this cluster. */
export function solscanAccount(address: string): string {
  return `https://solscan.io/account/${address}${CLUSTER === "mainnet" ? "" : `?cluster=${CLUSTER}`}`;
}
