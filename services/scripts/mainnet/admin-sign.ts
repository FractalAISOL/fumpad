/**
 * FUMPAD single-wallet admin (user decision 2026-10-18; runbook: services/LAUNCH-DAY.md "single-wallet admin"):
 * prepare ONE admin action as a proposal file (no secrets) for the local signing page (admin-sign-server.ts), where
 * the admin / guardian wallet (Phantom / Solflare / Backpack, key never on this machine) signs it.
 *
 *   A="npx tsx scripts/mainnet/admin-sign.ts --cluster mainnet --config ~/fumpad-keys/mainnet/bootstrap.json"
 *   $A --action accept-admin                           # after the propose_admin eta (6 h)
 *   $A --action set-pause --bits 0                     # guardian drill (no effect when nothing is paused)
 *   $A --action set-pause --bits all                   # incident: launch,trade,claims,graduate,attest (or a number)
 *   $A --action cancel-admin                           # guardian: cancel a pending propose_admin
 *   $A --action queue-config-remove                    # remove the first-coin config (default: dbc-config-first-coin.json)
 *   $A --action ix-json --ix-json ix.json --title "…"  # escape hatch: {programId, keys[{pubkey,isSigner,isWritable}], data(base64)}
 *
 * Flags: --cluster mainnet|devnet|local (must match the RPC's genesis) · --rpc-env <file> (RPC_URL=…; default
 * ~/fumpad-keys/mainnet/rpc.env on mainnet; local: http://127.0.0.1:8899) · --config <bootstrap.json> (program id =
 * its fumpad-program-keypair.json pubkey; signer = its admin / guardian when kind "hardware") · --program-id <id> ·
 * --signer <wallet> · --bits · --config-account <pubkey> · --title · --note <line> (repeatable) · --cu-price
 * <µlamports> · --out <file> (default <config dir>/proposals/<action>-<time>.json; never overwritten).
 * It simulates the action with the wallet as signer + fee payer and refuses (no file) when it would fail.
 * Then: npx tsx scripts/mainnet/admin-sign-server.ts --proposal <file> --rpc-env <same env file>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Connection, PublicKey } from "@solana/web3.js";

import { detectCluster, readEnvValue, redactText } from "../ops/common.js";
import type { ProposalAction, ProposalCluster, ProposalIx } from "./admin-sign-tx.js";
import { PROPOSAL_ACTIONS } from "./admin-sign-tx.js";
import { expandHome, keyPath, loadConfig, type PartyConfig, programIdOf, readKeypairFile } from "./keys.js";

export interface AdminSignArgs {
  action: ProposalAction;
  cluster: ProposalCluster;
  rpcUrl: string;
  configPath?: string;
  programId?: string;
  signer?: string;
  bits?: string;
  configAccount?: string;
  ixJson?: string;
  title?: string;
  notes: string[];
  cuPrice?: number;
  out?: string;
}

const FLAGS_WITH_VALUE = ["--action", "--cluster", "--rpc-env", "--config", "--program-id", "--signer", "--bits", "--config-account", "--ix-json", "--title", "--note", "--cu-price", "--out"];

export function parseAdminSignCli(argv: string[]): AdminSignArgs {
  const notes: string[] = [];
  const vals: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!FLAGS_WITH_VALUE.includes(a)) throw new Error(`unknown flag ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    if (a === "--note") notes.push(v);
    else vals[a] = v;
  }
  const action = vals["--action"] as ProposalAction;
  if (!PROPOSAL_ACTIONS.includes(action)) throw new Error(`--action ${PROPOSAL_ACTIONS.join("|")} is required`);
  const cluster = vals["--cluster"] as ProposalCluster;
  if (!["mainnet", "devnet", "local"].includes(cluster)) throw new Error("--cluster mainnet|devnet|local is required");
  const envFile = vals["--rpc-env"] ? expandHome(vals["--rpc-env"]) : cluster === "mainnet" ? join(homedir(), "fumpad-keys/mainnet/rpc.env") : undefined;
  const rpcUrl = envFile ? readEnvValue(envFile, "RPC_URL") : cluster === "local" ? (process.env.RPC_URL ?? "http://127.0.0.1:8899") : undefined;
  if (!rpcUrl) throw new Error(`no RPC_URL${envFile ? ` in ${envFile}` : ": pass --rpc-env"}`);
  const cuPrice = vals["--cu-price"] !== undefined ? Number(vals["--cu-price"]) : undefined;
  if (cuPrice !== undefined && (!Number.isInteger(cuPrice) || cuPrice < 0)) throw new Error("--cu-price: a non-negative integer (µlamports per CU)");
  if (action === "set-pause" && vals["--bits"] === undefined) throw new Error("set-pause needs --bits (0 = unpause / drill; launch,trade,claims,graduate,attest; all; or a number)");
  if (action === "ix-json" && (!vals["--ix-json"] || !vals["--title"])) throw new Error("ix-json needs --ix-json <file> and --title");
  return {
    action,
    cluster,
    rpcUrl,
    configPath: vals["--config"] ? resolve(expandHome(vals["--config"])) : undefined,
    programId: vals["--program-id"],
    signer: vals["--signer"],
    bits: vals["--bits"],
    configAccount: vals["--config-account"],
    ixJson: vals["--ix-json"] ? resolve(expandHome(vals["--ix-json"])) : undefined,
    title: vals["--title"],
    notes,
    cuPrice,
    out: vals["--out"] ? resolve(expandHome(vals["--out"])) : undefined,
  };
}

/** Which config party signs `action` (single wallet: admin = guardian). */
const roleOf = (action: ProposalAction): "admin" | "guardian" => (action === "set-pause" || action === "cancel-admin" ? "guardian" : "admin");

/** Program id + signer + defaults from the CLI flags and the optional bootstrap config. */
export function resolveTargets(a: AdminSignArgs): { programId: string; signer: string; configAccount?: string; cuPrice?: number; outDir: string } {
  let programId = a.programId;
  let signer = a.signer;
  let configAccount = a.configAccount;
  let cuPrice = a.cuPrice;
  let outDir = process.cwd();
  if (a.configPath) {
    const { cfg, dir } = loadConfig(a.configPath);
    outDir = join(dir, "proposals");
    const id = programIdOf(dir);
    if (!id) throw new Error(`no fumpad-program-keypair.json next to ${a.configPath}`);
    if (programId && programId !== id) throw new Error(`--program-id ${programId} ≠ the config's program ${id}`);
    programId = id;
    const party: PartyConfig = cfg[roleOf(a.action)];
    if (!signer) {
      if (party.kind !== "hardware") throw new Error(`config ${roleOf(a.action)} is a Squads multisig (kind "${party.kind}"): use the Squads flow (MULTISIG.md), or pass --signer`);
      signer = party.address;
    } else if (party.kind === "hardware" && party.address !== signer && a.action !== "ix-json") {
      throw new Error(`wrong signer: --signer ${signer} ≠ config ${roleOf(a.action)} ${party.address}`);
    }
    if (a.action === "queue-config-remove" && !configAccount) {
      const f = keyPath(dir, "dbc-config-first-coin");
      if (!existsSync(f)) throw new Error(`no ${f}: pass --config-account`);
      configAccount = readKeypairFile(f).publicKey.toBase58();
    }
    cuPrice ??= cfg.computeUnitPriceMicroLamports;
  }
  if (!programId) throw new Error("pass --config (bootstrap.json) or --program-id");
  if (!signer) throw new Error("pass --signer <wallet> (or --config with a hardware admin / guardian)");
  for (const [n, v] of [["program id", programId], ["signer", signer], ["config account", configAccount]] as const) {
    if (v === undefined) continue;
    try {
      new PublicKey(v);
    } catch {
      throw new Error(`${n} ${v}: not a public key`);
    }
  }
  return { programId, signer, configAccount, cuPrice, outDir };
}

export function readIxJson(file: string): { ixs: ProposalIx[]; summary?: string[] } {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (Array.isArray(raw)) return { ixs: raw as ProposalIx[] };
  const o = raw as { instructions?: ProposalIx[]; summary?: string[] } & ProposalIx;
  if (o.instructions) return { ixs: o.instructions, summary: o.summary };
  return { ixs: [o], summary: o.summary as never };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let secret = "";
  try {
    const a = parseAdminSignCli(process.argv.slice(2));
    secret = a.rpcUrl;
    const t = resolveTargets(a);
    if (process.env.FUMPAD_PROGRAM_ID && process.env.FUMPAD_PROGRAM_ID !== t.programId) throw new Error(`FUMPAD_PROGRAM_ID=${process.env.FUMPAD_PROGRAM_ID} in the environment ≠ ${t.programId}`);
    process.env.FUMPAD_PROGRAM_ID = t.programId;
    if (a.cluster === "mainnet") process.env.FUMPAD_CLUSTER ??= "mainnet";
    const conn = new Connection(a.rpcUrl, "confirmed");
    const actual = await detectCluster(conn);
    if (actual !== a.cluster) throw new Error(`--cluster ${a.cluster} but the RPC serves ${actual}: refusing`);
    const { buildProposal, connectionChain, parsePauseBits } = await import("./admin-sign-core.js");
    const ixj = a.ixJson ? readIxJson(a.ixJson) : undefined;
    const p = await buildProposal(
      {
        action: a.action,
        cluster: a.cluster,
        signer: new PublicKey(t.signer),
        pauseBits: a.bits !== undefined ? parsePauseBits(a.bits) : undefined,
        config: t.configAccount ? new PublicKey(t.configAccount) : undefined,
        ixs: ixj?.ixs,
        title: a.title,
        summary: [...(ixj?.summary ?? []), ...a.notes],
        computeUnitPriceMicroLamports: t.cuPrice,
      },
      connectionChain(conn),
      (s) => console.log(redactText(s, a.rpcUrl)),
    );
    const out = a.out ?? join(t.outDir, `${a.action}-${p.createdAt.replace(/[:.]/g, "-")}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(p, null, 2)}\n`, { flag: "wx" });
    console.log(`\n${p.title}  [${p.cluster}]`);
    for (const l of p.summary) console.log(`  • ${l}`);
    console.log(`  signer + fee payer: ${p.signer} (${p.signerRole})`);
    for (const v of p.values) console.log(`  ${v.label}: ${v.value}`);
    console.log(`  simulated OK: ${p.simulation.unitsConsumed ?? "?"} CU`);
    console.log(`\n✓ proposal written: ${out}\n  next: npx tsx scripts/mainnet/admin-sign-server.ts --proposal ${out}${a.cluster === "local" ? "" : " --rpc-env <the same rpc.env>"}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`✗ ${secret ? redactText(msg, secret) : msg}`);
    process.exit(1);
  }
}
