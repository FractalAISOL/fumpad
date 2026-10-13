/**
 * Startup check: is the configured FUMPAD deployment (`FUMPAD_CONFIG`: FUMPAD_PROGRAM_ID + FUMPAD_CLUSTER) really on
 * the chain behind this RPC? Every long-running service calls it before doing anything and refuses to start on a
 * mismatch, so a mainnet service with a missing / wrong id or a devnet RPC can't run silently against nothing.
 */
import { Connection, PublicKey } from "@solana/web3.js";

import { accountDiscriminator, decodeGlobal, type GlobalAccount } from "./accounts.js";
import { CLUSTER_NAMES, CLUSTER_TAG, DEFAULT_FUMPAD_PROGRAM_ID, FUMPAD_CONFIG, type FumpadConfig, SEEDS } from "./constants.js";

interface AccountLike {
  data: Uint8Array;
  owner: PublicKey;
  executable: boolean;
}
/** The part of `Connection` the check uses. */
export interface DeploymentReader {
  getAccountInfo(address: PublicKey, commitment?: "processed" | "confirmed" | "finalized"): Promise<AccountLike | null>;
}

export class FumpadDeploymentError extends Error {
  override name = "FumpadDeploymentError";
}

export interface VerifiedDeployment {
  config: FumpadConfig;
  global: PublicKey;
  globalAccount: GlobalAccount;
}

const clusterName = (tag: number) => CLUSTER_NAMES.find((n) => CLUSTER_TAG[n] === tag) ?? `unknown(${tag})`;
const describe = (c: FumpadConfig) => `program ${c.programId.toBase58()} (${c.programIdSource}), cluster ${c.cluster} (${c.clusterSource}, cluster_tag ${c.clusterTag})`;

/**
 * Throws `FumpadDeploymentError` unless: an explicit FUMPAD_CLUSTER accompanies a non-default FUMPAD_PROGRAM_ID; the
 * program account exists and is executable; Global (PDA "global" of that program) exists, is owned by it, carries the
 * Global discriminator and its `cluster_tag` equals the configured cluster's. RPC errors are retried a few times, then
 * rethrown (a service that can't read the chain shouldn't start either).
 */
export async function verifyFumpadDeployment(conn: DeploymentReader, cfg: FumpadConfig = FUMPAD_CONFIG, o: { attempts?: number; retryMs?: number } = {}): Promise<VerifiedDeployment> {
  const fail = (why: string): never => {
    throw new FumpadDeploymentError(`refusing to start: ${why} [${describe(cfg)}]`);
  };
  if (cfg.programId.toBase58() !== DEFAULT_FUMPAD_PROGRAM_ID && cfg.clusterSource === "default") fail("FUMPAD_PROGRAM_ID is not the devnet default, so FUMPAD_CLUSTER must be set explicitly (mainnet | devnet | localnet)");
  const global = PublicKey.findProgramAddressSync([SEEDS.global], cfg.programId)[0];
  const attempts = o.attempts ?? 4;
  let prog: AccountLike | null = null;
  let g: AccountLike | null = null;
  for (let i = 1; ; i++) {
    try {
      [prog, g] = await Promise.all([conn.getAccountInfo(cfg.programId, "confirmed"), conn.getAccountInfo(global, "confirmed")]);
      break;
    } catch (e) {
      if (i >= attempts) throw new FumpadDeploymentError(`refusing to start: can't read the program / Global from the RPC (${(e as Error).message}) [${describe(cfg)}]`);
      await new Promise((r) => setTimeout(r, (o.retryMs ?? 1_000) * i));
    }
  }
  if (!prog) fail("no account at the program id on this RPC's cluster (wrong FUMPAD_PROGRAM_ID or RPC_URL?)");
  if (!prog!.executable) fail("the account at the program id is not an executable program");
  if (!g) fail(`no Global at ${global.toBase58()} (initialize_global not run on this cluster, or the wrong program id)`);
  if (!g!.owner.equals(cfg.programId)) fail(`Global ${global.toBase58()} is owned by ${g!.owner.toBase58()}, not the program`);
  const disc = accountDiscriminator("Global");
  if (g!.data.length < disc.length || !disc.every((b, i) => g!.data[i] === b)) fail(`Global ${global.toBase58()} has no Global discriminator`);
  const globalAccount = decodeGlobal(g!.data);
  if (globalAccount.clusterTag !== cfg.clusterTag)
    fail(`Global.cluster_tag is ${globalAccount.clusterTag} (${clusterName(globalAccount.clusterTag)}) but FUMPAD_CLUSTER is ${cfg.cluster} (${cfg.clusterTag})`);
  return { config: cfg, global, globalAccount };
}

/** One log line for a verified deployment. */
export const deploymentSummary = (d: VerifiedDeployment) => `FUMPAD deployment ok: ${describe(d.config)}, Global ${d.global.toBase58()}`;

/**
 * Service entry points: `verifyFumpadDeployment` over `rpcUrl`, the summary logged; on failure the reason is printed
 * (the RPC URL, which may carry an API key, redacted) and the process exits 1 — the service never starts.
 */
export async function requireFumpadDeployment(service: string, rpcUrl: string, cfg: FumpadConfig = FUMPAD_CONFIG): Promise<VerifiedDeployment> {
  try {
    const d = await verifyFumpadDeployment(new Connection(rpcUrl, "confirmed"), cfg);
    console.log(`${service}: ${deploymentSummary(d)}`);
    return d;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split(rpcUrl).join("<RPC_URL>");
    console.error(`${service}: ✗ ${msg}`);
    const p = (globalThis as { process?: { exit(code: number): never } }).process;
    if (p) p.exit(1);
    throw e;
  }
}
