/**
 * Mainnet bootstrap keys + config file (no @fumpad/sdk import: the entry points read the program id from here BEFORE
 * the SDK is loaded, see bootstrap-mainnet.ts).
 *
 * Generated here (hot keys, dir 700 / files 600, never overwritten, secrets never printed):
 *   attestor-1/2/3.json        Global.keepers (attestors ONLY: they sign + submit attestations; DEPLOY-v07.md §1 —
 *                              copy each one to its own host / provider account, never next to the operator key)
 *   operator.json              Global.operators[0]: the jobs keeper's hot key (samples, claim_for, pre-grad buybacks,
 *                              cranks); never an attestor
 *   launch-signer.json         Params.launch_signer (the API's launch co-signer)
 *   dbc-config.json            address of the FUMPAD DBC config account (signs its creation only)
 *   dbc-config-first-coin.json address of the one-off first-coin DBC config (99% → 3% / 25 slots, 3% DAMM v2;
 *                              INTERFACE §5.9), allow-listed with the wallet-split policy (config `firstCoin.feeWallet`)
 *   fumpad-program-keypair.json  the MAINNET program id: back it up OFFLINE (it only matters until the first deploy,
 *                              but a lost keypair before that = a new id and a rebuild)
 * NOT generated (public keys in the config file; the deployer keypair is provided by you): admin, guardian,
 * treasury, upgrade authority = Squads multisig vaults or hardware wallets.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Keypair, PublicKey } from "@solana/web3.js";

export const HOT_KEYS = ["attestor-1", "attestor-2", "attestor-3", "operator", "launch-signer", "dbc-config", "dbc-config-first-coin", "fumpad-program-keypair"] as const;
/** The hot keys `--step fund` tops up (in this order). */
export const FUNDED_KEYS = ["operator", "attestor-1", "attestor-2", "attestor-3"] as const;
export type FundedKey = (typeof FUNDED_KEYS)[number];
export type HotKey = (typeof HOT_KEYS)[number];

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

/** A governance role: a Squads v4 multisig (vault[0] acts) or a hardware wallet (signs itself). */
export interface PartyConfig {
  kind: "squads" | "hardware";
  /** squads: the multisig PDA (`multisig.ts status` prints it) */
  multisig?: string;
  /** squads: vault[0] of `multisig` (checked); hardware: the wallet address */
  address: string;
  label?: string;
}

export interface MainnetConfig {
  /** hot key that pays everything and is the initial upgrade authority + admin + guardian until the handover */
  deployerKeypair: string;
  admin: PartyConfig;
  guardian: PartyConfig;
  /** Global.platform_treasury */
  treasury: string;
  /** final program upgrade authority; default = admin */
  upgradeAuthority?: PartyConfig;
  /**
   * optional Squads member key with Initiate + Execute only (MULTISIG.md "ops key"): lets `--step accept-admin`
   * create and later execute the admin multisig's accept_admin vault transaction (voters approve in the Squads app)
   */
  opsKeypair?: string;
  /** µlamports per CU for every bootstrap tx and the program deploy (default 20,000) */
  computeUnitPriceMicroLamports?: number;
  /** SOL each hot key is topped up to by `--step fund` (defaults: MAINNET-COSTS.md) */
  fund?: Partial<Record<FundedKey, number>>;
  /** refuse `fund` / `program` when the committed total exceeds this (default 12 SOL) */
  budgetSol?: number;
  /** extra program-data bytes reserved at deploy (`--max-len` = .so + this; default 0; MULTISIG.md: extend later) */
  programHeadroomBytes?: number;
  /**
   * The one-off first-coin launch config (user decision 2026-10-14, INTERFACE §5.9): `feeWallet` receives 1.4% of the
   * first coin's volume and FUMPAD's whole launch-window share; 1.0% → its buyback. Required: `config` / `init`
   * allow-list it next to the standard config. `maxCoins` default 1. Other fields are notes.
   */
  firstCoin?: { feeWallet: string; maxCoins?: number; [note: string]: unknown };
}

/** The operator (jobs keeper) carries the graduation-setup float; attestors only ticket / marker rent. */
export const DEFAULT_FUND_SOL: Record<FundedKey, number> = { operator: 2, "attestor-1": 0.3, "attestor-2": 0.3, "attestor-3": 0.3 };

export function loadConfig(path: string): { cfg: MainnetConfig; dir: string; rel: (p: string) => string } {
  const file = resolve(expandHome(path));
  if (!existsSync(file)) throw new Error(`no config file ${file} (copy services/scripts/mainnet/mainnet-config.example.json)`);
  const cfg = JSON.parse(readFileSync(file, "utf8")) as MainnetConfig;
  const dir = dirname(file);
  const rel = (p: string) => (isAbsolute(expandHome(p)) ? expandHome(p) : join(dir, p));
  const problems: string[] = [];
  const pk = (what: string, v: string | undefined) => {
    try {
      if (!v) throw new Error();
      return new PublicKey(v);
    } catch {
      problems.push(`${what}: not a public key`);
      return null;
    }
  };
  for (const [name, p] of [["admin", cfg.admin], ["guardian", cfg.guardian], ["upgradeAuthority", cfg.upgradeAuthority]] as const) {
    if (!p) continue;
    if (p.kind !== "squads" && p.kind !== "hardware") problems.push(`${name}.kind must be "squads" or "hardware"`);
    pk(`${name}.address`, p.address);
    if (p.kind === "squads") pk(`${name}.multisig`, p.multisig);
  }
  pk("treasury", cfg.treasury);
  if (!cfg.deployerKeypair) problems.push("deployerKeypair missing");
  if (cfg.admin && cfg.guardian && cfg.admin.address === cfg.guardian.address) problems.push("admin and guardian must differ");
  if (problems.length) throw new Error(`config ${file}: ${problems.join("; ")}`);
  return { cfg, dir, rel };
}

export const keyPath = (dir: string, n: HotKey) => join(dir, `${n}.json`);
export const readKeypairFile = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(expandHome(path), "utf8")) as number[]));

/** Create the missing hot keys (dir 700, files 600, `wx`: never overwrites). Returns the names created. */
export function ensureHotKeys(dir: string): HotKey[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const created: HotKey[] = [];
  for (const n of HOT_KEYS) {
    const p = keyPath(dir, n);
    if (existsSync(p)) {
      chmodSync(p, 0o600);
      continue;
    }
    writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600, flag: "wx" });
    created.push(n);
  }
  return created;
}

/** The program id = pubkey of `<dir>/fumpad-program-keypair.json`, or null before `--step keys`. */
export function programIdOf(dir: string): string | null {
  const p = keyPath(dir, "fumpad-program-keypair");
  return existsSync(p) ? readKeypairFile(p).publicKey.toBase58() : null;
}
