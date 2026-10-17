/**
 * The cluster and FUMPAD deployment the app runs on. Build-time config (NEXT_PUBLIC_*, inlined by Next):
 *
 *   NEXT_PUBLIC_SOLANA_RPC          the RPC (mainnet-beta public RPC when unset)
 *   NEXT_PUBLIC_FUMPAD_PROGRAM_ID   the FUMPAD program (unset = the devnet deployment, DEVNET_PROGRAM_ADDRESS)
 *   NEXT_PUBLIC_FUMPAD_CLUSTER      mainnet | devnet | localnet (unset = inferred from the RPC URL); REQUIRED with a
 *                                   non-default program id, so a mainnet build can't silently run as "devnet"
 *   NEXT_PUBLIC_LAUNCH_ALT          the FUMPAD launch address lookup table (bootstrap `--step alt`, = the API's
 *                                   LAUNCH_ALT). The only table a launch may use: the app loads it from chain and
 *                                   checks its contents before signing (`./allowlist.ts`). Unset = this build signs
 *                                   only inline launches (it refuses every launch that uses a lookup table).
 *
 * next.config.ts hands the same two values to @fumpad/sdk (as FUMPAD_PROGRAM_ID / FUMPAD_CLUSTER), and
 * `./allowlist.ts` refuses to load if the SDK's program id differs from FUMPAD_PROGRAM_ADDRESS.
 * No web3.js import, so server components (the footer, docs pages) can read it for free.
 */
export const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.mainnet-beta.solana.com";

export type Cluster = "mainnet" | "devnet" | "testnet" | "localnet";

/** The v0.7 program id of the default build (contracts/program-ids/devnet.txt), deployed on devnet. */
export const DEVNET_PROGRAM_ADDRESS = "5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb";

const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Pure resolution of the build-time config (unit-tested). Throws on a malformed program id, an unknown cluster, a
 * non-default program id without an explicit cluster, or a mainnet cluster with a devnet/testnet RPC URL.
 */
export function resolveDeployment(env: { rpc?: string; programId?: string; cluster?: string }): { program: string; cluster: Cluster; explicitCluster: boolean } {
  const rpc = env.rpc || "https://api.mainnet-beta.solana.com";
  const id = (env.programId ?? "").trim();
  if (id && !BASE58_KEY.test(id)) throw new Error(`NEXT_PUBLIC_FUMPAD_PROGRAM_ID=${JSON.stringify(id)} is not a base58 public key`);
  const program = id || DEVNET_PROGRAM_ADDRESS;
  const c = (env.cluster ?? "").trim().toLowerCase();
  if (c && c !== "mainnet" && c !== "devnet" && c !== "localnet") throw new Error(`NEXT_PUBLIC_FUMPAD_CLUSTER=${JSON.stringify(c)}: expected mainnet, devnet or localnet`);
  if (program !== DEVNET_PROGRAM_ADDRESS && !c) throw new Error("NEXT_PUBLIC_FUMPAD_PROGRAM_ID is set: set NEXT_PUBLIC_FUMPAD_CLUSTER too (mainnet | devnet | localnet)");
  const inferred: Cluster = /devnet/i.test(rpc) ? "devnet" : /testnet/i.test(rpc) ? "testnet" : "mainnet";
  if (c === "mainnet" && inferred !== "mainnet") throw new Error(`NEXT_PUBLIC_FUMPAD_CLUSTER=mainnet but NEXT_PUBLIC_SOLANA_RPC looks like ${inferred}`);
  return { program, cluster: (c || inferred) as Cluster, explicitCluster: !!c };
}

const DEPLOYMENT = resolveDeployment({ rpc: RPC, programId: process.env.NEXT_PUBLIC_FUMPAD_PROGRAM_ID, cluster: process.env.NEXT_PUBLIC_FUMPAD_CLUSTER });

/** NEXT_PUBLIC_FUMPAD_CLUSTER, else inferred from the RPC URL (anything naming devnet/testnet is that cluster). */
export const CLUSTER: Cluster = DEPLOYMENT.cluster;
/** "Devnet" / "Testnet" / "Localnet"; null on mainnet (nothing to warn about). */
export const CLUSTER_LABEL: string | null = CLUSTER === "mainnet" ? null : CLUSTER === "devnet" ? "Devnet" : CLUSTER === "testnet" ? "Testnet" : "Localnet";

/** The FUMPAD program this build talks to (NEXT_PUBLIC_FUMPAD_PROGRAM_ID; default the devnet deployment). */
export const FUMPAD_PROGRAM_ADDRESS = DEPLOYMENT.program;
/** Base58 check of NEXT_PUBLIC_LAUNCH_ALT (pure; unit-tested). Throws on a malformed value; undefined when unset. */
export function resolveLaunchAlt(v: string | undefined): string | undefined {
  const s = (v ?? "").trim();
  if (!s) return undefined;
  if (!BASE58_KEY.test(s)) throw new Error(`NEXT_PUBLIC_LAUNCH_ALT=${JSON.stringify(s)} is not a base58 address`);
  return s;
}

/** The FUMPAD launch lookup table this build accepts (NEXT_PUBLIC_LAUNCH_ALT); undefined = inline launches only. */
export const LAUNCH_ALT_ADDRESS: string | undefined = resolveLaunchAlt(process.env.NEXT_PUBLIC_LAUNCH_ALT);

/** Solscan's query string for this cluster ("" on mainnet). */
export const SOLSCAN_QUERY = CLUSTER === "mainnet" ? "" : CLUSTER === "localnet" ? `?cluster=custom&customUrl=${encodeURIComponent(RPC)}` : `?cluster=${CLUSTER}`;

/** Solscan link for an account on this cluster. */
export function solscanAccount(address: string): string {
  return `https://solscan.io/account/${address}${SOLSCAN_QUERY}`;
}
