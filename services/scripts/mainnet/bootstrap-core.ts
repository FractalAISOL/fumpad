/**
 * FUMPAD MAINNET bootstrap, the library (CLI: bootstrap-mainnet.ts; runbook: services/LAUNCH-DAY.md). Imported only
 * after `FUMPAD_PROGRAM_ID` is set to the mainnet program id (the SDK reads it at import).
 *
 * Steps (idempotent: each re-reads the chain and does only what is missing):
 *   keys               hot keys (keys.ts; done by the entry point before the SDK loads)
 *   program            deploy fumpad.so (built for this id by build-program.ts) with the deployer as upgrade authority
 *   config             DBC create_config, MAINNET values (85 SOL, D17 curve, 1% migration fee, 99% → 1.25% / 8 slots);
 *                      the instruction bytes must equal contracts/tests/vectors/dbc_config.json `mainnet`
 *                      + the first-coin config (99% → 3% / 25 slots, 3% DAMM v2; vector `first_coin_mainnet`)
 *   init               initialize_global: cluster_tag 0, Params = defaults + launch_signer, keepers attestor-1/2/3
 *                      (no 6 h freeze), operators [operator] (the jobs keeper's key, never an attestor), configs [the
 *                      standard config, the first-coin config + its wallet-split policy {1.0% buyback, 1.4% config
 *                      firstCoin.feeWallet, max_coins 1}] (no timelock), admin = guardian = deployer, platform_treasury
 *                      = config `treasury`
 *   fund               top up operator + attestor-1/2/3 from the deployer
 *   alt                the launch address lookup table: create + extend with @fumpad/sdk `launchAltAddresses()` +
 *                      FREEZE in one tx (scripts/ops/launch-alt.ts); recorded in <config dir>/launch-alt.json →
 *                      LAUNCH_ALT (api) + NEXT_PUBLIC_LAUNCH_ALT (app). Without it the API refuses every launch.
 *   propose-admin      propose_admin(new admin = admin vault, treasury, guardian vault) by the deployer (6 h)
 *   accept-admin       admin multisig vault tx `accept_admin`: create it (ops key), report approvals, execute once both
 *                      the 6 h FUMPAD eta and the Squads time lock have passed (voters approve in the Squads app)
 *   upgrade-authority  BPF loader authority deployer → admin vault; refused until Global.admin = admin vault
 *   remove-first-coin-config  right after the first coin launched: queue_config(first-coin config, remove) by the admin
 *                      (deployer before the handover; else an admin-multisig vault tx by the ops key, voters approve),
 *                      then execute_config once the config timelock passed (rerun; permissionless)
 *   verify             read-only checklist + "next action"
 * Modes: plan (default; builds + prints, reads the chain) · simulate (simulateTransaction, sigVerify on) · send
 * (each step asks `confirm` with a typed phrase first).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as sq from "@sqds/multisig";
import {
  ComputeBudgetProgram,
  Connection,
  type Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  type Signer,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  activeKeepers,
  CLUSTER_TAG,
  confirmSignature,
  DAMM_V2_MIGRATION_CONFIG,
  DAMM_V2_PROGRAM_ID,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  configSlot,
  dbcCreateConfigIx,
  decodeGlobal,
  DEFAULT_PARAMS,
  encodeDbcConfigParameters,
  executeConfigIx,
  FEE_POLICY,
  type FeePolicy,
  feePolicyProblems,
  feeClaimerPda,
  firstCoinConfigParams,
  GLOBAL_ACCOUNT_LEN,
  queueConfigIx,
  STANDARD_FEE_POLICY,
  FUMPAD_PROGRAM_ID,
  fumpadConfigParams,
  globalPda,
  initializeGlobalIx,
  MAX_CONFIGS,
  type Params,
  paramsProblems,
  programDataPda,
  proposeAdminIx,
  rewardPoolPda,
  ADMIN_TIMELOCK_SECS,
} from "@fumpad/sdk";

import { configProblems, firstCoinConfigProblems, firstCoinPolicy, paramsDiff } from "../devnet/bootstrap-v07.js";
import { GENESIS, redactText } from "../ops/common.js";
import { launchAltCheck, launchAltStep } from "../ops/launch-alt.js";
import { executeVaultTx, proposalState, proposeVaultTx, readMultisig, setUpgradeAuthorityIx, SQUADS_PROGRAM_ID, vaultPdaOf } from "../ops/multisig.js";
import { committedMainnetId } from "./build-program.js";
import { type Manifest, SERVICES, TESTED_MANIFEST } from "./fork.js";
import { DEFAULT_FUND_SOL, ensureHotKeys, type FundedKey, type HotKey, keyPath, loadConfig, type MainnetConfig, type PartyConfig, readKeypairFile } from "./keys.js";

export type MainnetCluster = "mainnet" | "local-fork";
export type Mode = "plan" | "simulate" | "send";
export const STEPS = ["keys", "program", "config", "init", "fund", "alt", "propose-admin", "accept-admin", "upgrade-authority", "verify", "remove-first-coin-config"] as const;
export type Step = (typeof STEPS)[number];
/** `all` = everything that can happen on day 0 (the handover's accept + upgrade authority need 6 h + approvals). */
export const DAY0_STEPS: Step[] = ["keys", "program", "config", "init", "fund", "alt", "propose-admin", "verify"];

/** Asked once per sending step with a summary; must return true to proceed (CLI: the operator types `phrase`). */
export type Confirm = (step: Step, summary: string[], phrase: string) => Promise<boolean>;

export interface MainnetBootstrapOpts {
  cluster: MainnetCluster;
  mode: Mode;
  steps: Step[];
  rpcUrl: string;
  configPath: string;
  /** default: services/.local/program-build/<program id>/deploy/fumpad.so (build-program.ts) */
  soPath?: string;
  confirm: Confirm;
  log?: (s: string) => void;
  /** solana CLI binary dir (default: the active Agave release) */
  solanaBin?: string;
}

export interface MainnetBootstrapResult {
  ok: boolean;
  failures: string[];
  warnings: string[];
  pubkeys: Record<string, string>;
  /** what the operator does next (verify) */
  next: string[];
  /** lamports the deployer spent per step (send mode) */
  spent: Partial<Record<Step, bigint>>;
}

const SOL = BigInt(LAMPORTS_PER_SOL);
const sol = (l: bigint | number) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const VECTORS = resolve(SERVICES, "../contracts/tests/vectors/dbc_config.json");
const ACCEPT_ADMIN_DISC = createHash("sha256").update("global:accept_admin").digest().subarray(0, 8);

/** The mainnet Params: every default (INTERFACE §5 / SPEC) + the API's launch co-signer. */
export function mainnetParams(launchSigner: PublicKey): Params {
  return { ...DEFAULT_PARAMS, launchSigner };
}

/** create_config instruction data must equal the committed mainnet vector byte for byte (standard, then first coin). */
export function configBytesProblem(which: "mainnet" | "first_coin_mainnet" = "mainnet"): string | null {
  const v = JSON.parse(readFileSync(VECTORS, "utf8")) as Record<string, { create_config_data_hex: string }>;
  const params = which === "mainnet" ? fumpadConfigParams("mainnet") : firstCoinConfigParams("mainnet");
  const ix = dbcCreateConfigIx({ config: PublicKey.default, payer: PublicKey.default, params });
  const got = hex(ix.data);
  const want = v[which]?.create_config_data_hex ?? "";
  return got === want ? null : `create_config data ${got.slice(0, 24)}… ≠ vector ${want.slice(0, 24)}… (contracts/tests/vectors/dbc_config.json ${which})`;
}

/** ProgramData: tag u32 = 3 | slot u64 | Option<authority> | ELF. */
export async function programState(conn: Connection, id = FUMPAD_PROGRAM_ID) {
  const p = await conn.getAccountInfo(id, "confirmed");
  if (!p) return { exists: false, deployed: false, authority: null as PublicKey | null, slot: 0n, programDataLamports: 0n, elf: null as Uint8Array | null };
  if (!p.executable) return { exists: true, deployed: false, authority: null, slot: 0n, programDataLamports: 0n, elf: null };
  const pdKey = id.equals(FUMPAD_PROGRAM_ID) ? programDataPda() : PublicKey.findProgramAddressSync([id.toBytes()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
  const pd = await conn.getAccountInfo(pdKey, "confirmed");
  if (!pd) return { exists: true, deployed: false, authority: null, slot: 0n, programDataLamports: 0n, elf: null };
  const d = new Uint8Array(pd.data);
  return { exists: true, deployed: true, authority: d[12] === 1 ? new PublicKey(d.subarray(13, 45)) : null, slot: Buffer.from(d).readBigUInt64LE(4), programDataLamports: BigInt(pd.lamports), elf: d.subarray(45) };
}

const elfMatches = (elf: Uint8Array | null, so: Uint8Array) => !!elf && elf.length >= so.length && sha(elf.subarray(0, so.length)) === sha(so) && elf.subarray(so.length).every((b) => b === 0);

/** Problems with a governance party on chain (Squads: live multisig whose vault[0] = address, threshold ≥ 2). */
export async function partyProblems(conn: Connection, name: string, p: PartyConfig): Promise<{ problems: string[]; warnings: string[]; lines: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];
  const address = new PublicKey(p.address);
  if (p.kind === "hardware") {
    if (!PublicKey.isOnCurve(address.toBytes())) problems.push(`${name}: ${p.address} is off-curve (a PDA can't sign as a hardware wallet)`);
    warnings.push(`${name} is a single hardware wallet (MULTISIG.md recommends a Squads multisig)`);
    lines.push(`${name}: hardware wallet ${p.address}`);
    return { problems, warnings, lines };
  }
  const ms = new PublicKey(p.multisig!);
  if (!vaultPdaOf(ms).equals(address)) problems.push(`${name}: address ${p.address} is not vault[0] of multisig ${p.multisig} (= ${vaultPdaOf(ms).toBase58()})`);
  const acc = await conn.getAccountInfo(ms, "confirmed");
  if (!acc) {
    problems.push(`${name}: Squads multisig ${p.multisig} does not exist on this cluster`);
    return { problems, warnings, lines };
  }
  if (!acc.owner.equals(SQUADS_PROGRAM_ID)) {
    problems.push(`${name}: ${p.multisig} is not owned by Squads v4`);
    return { problems, warnings, lines };
  }
  const m = await readMultisig(conn, ms);
  const voters = m.members.filter((x) => (x.permissions.mask & 2) !== 0).length;
  lines.push(`${name}: Squads ${p.multisig} vault ${p.address} · ${m.threshold}-of-${voters} voters · time lock ${m.timeLock}s · ${m.members.length} members`);
  if (m.threshold < 2) problems.push(`${name}: threshold ${m.threshold} < 2`);
  if (!m.configAuthority.equals(PublicKey.default)) warnings.push(`${name}: config authority ${m.configAuthority.toBase58()} set (MULTISIG.md: autonomous, null)`);
  if (name === "admin" && m.timeLock < ADMIN_TIMELOCK_SECS) warnings.push(`admin: Squads time lock ${m.timeLock}s < 6 h (MULTISIG.md recommends 21,600 s)`);
  if (name === "guardian" && m.timeLock > 0) warnings.push(`guardian: Squads time lock ${m.timeLock}s (a pause should be immediate: MULTISIG.md recommends 0)`);
  return { problems, warnings, lines };
}

/** The admin multisig's vault transactions whose only inner instruction is FUMPAD accept_admin by the vault. */
async function findAcceptAdminTx(conn: Connection, multisig: PublicKey): Promise<bigint | null> {
  const m = await readMultisig(conn, multisig);
  const last = BigInt(m.transactionIndex.toString());
  for (let i = last; i >= 1n && i > last - 50n; i--) {
    const pda = sq.getTransactionPda({ multisigPda: multisig, index: i })[0];
    const a = await conn.getAccountInfo(pda, "confirmed");
    if (!a) continue;
    try {
      const [tx] = sq.accounts.VaultTransaction.fromAccountInfo(a);
      const keys = tx.message.accountKeys;
      const ixs = tx.message.instructions;
      if (ixs.length === 1 && keys[ixs[0].programIdIndex].equals(FUMPAD_PROGRAM_ID) && Buffer.from(ixs[0].data).subarray(0, 8).equals(ACCEPT_ADMIN_DISC)) return i;
    } catch {
      /* a config transaction or something else */
    }
  }
  return null;
}

export async function runMainnetBootstrap(o: MainnetBootstrapOpts): Promise<MainnetBootstrapResult> {
  const log = o.log ?? ((s: string) => console.log(s));
  const failures: string[] = [];
  const warnings: string[] = [];
  const next: string[] = [];
  const spent: MainnetBootstrapResult["spent"] = {};
  const { cfg, dir, rel } = loadConfig(o.configPath);
  const conn = new Connection(o.rpcUrl, "confirmed");
  const say = (s: string) => log(redactText(s, o.rpcUrl));

  // ── refuse the wrong cluster before anything else ────────────────────────
  const genesis = await conn.getGenesisHash();
  if (o.cluster === "mainnet" && genesis !== GENESIS.mainnet) throw new Error("refusing: --cluster mainnet but the RPC is not mainnet-beta (genesis hash mismatch)");
  if (o.cluster === "local-fork" && Object.values(GENESIS).includes(genesis as never)) throw new Error("refusing: --cluster local-fork but the RPC serves a public cluster");

  const programKey = readKeypairFile(keyPath(dir, "fumpad-program-keypair"));
  if (!programKey.publicKey.equals(FUMPAD_PROGRAM_ID)) throw new Error(`FUMPAD_PROGRAM_ID (${FUMPAD_PROGRAM_ID.toBase58()}) ≠ the program keypair ${programKey.publicKey.toBase58()}: start through bootstrap-mainnet.ts`);
  const deployerPath = rel(cfg.deployerKeypair);
  if (!existsSync(deployerPath)) throw new Error(`deployer keypair ${deployerPath} missing (config deployerKeypair)`);
  const deployer = readKeypairFile(deployerPath);
  const hot = (n: HotKey) => readKeypairFile(keyPath(dir, n));
  const cuPrice = cfg.computeUnitPriceMicroLamports ?? 20_000;
  const budget = BigInt(Math.round((cfg.budgetSol ?? 12) * LAMPORTS_PER_SOL));
  const soPath = o.soPath ?? join(SERVICES, ".local/program-build", FUMPAD_PROGRAM_ID.toBase58(), "deploy/fumpad.so");
  const admin = new PublicKey(cfg.admin.address);
  const guardian = new PublicKey(cfg.guardian.address);
  const treasury = new PublicKey(cfg.treasury);
  const upParty = cfg.upgradeAuthority ?? cfg.admin;
  const configKey = hot("dbc-config");
  const firstKey = hot("dbc-config-first-coin");
  if (!cfg.firstCoin?.feeWallet) throw new Error("config firstCoin.feeWallet missing: the first-coin launch config's fee wallet (INTERFACE §5.9; see mainnet-config.example.json)");
  const firstWallet = new PublicKey(cfg.firstCoin.feeWallet);
  const firstPolicy: FeePolicy = { ...firstCoinPolicy(firstWallet), maxCoins: cfg.firstCoin.maxCoins ?? 1 };
  const fpp = feePolicyProblems(firstPolicy);
  if (fpp.length) throw new Error(`firstCoin policy invalid: ${fpp.join("; ")}`);
  const expectFirst = firstCoinConfigParams("mainnet");
  const keepers = [hot("attestor-1").publicKey, hot("attestor-2").publicKey, hot("attestor-3").publicKey];
  const operator = hot("operator").publicKey;
  const launchSigner = hot("launch-signer").publicKey;
  const params = mainnetParams(launchSigner);
  const expectConfig = fumpadConfigParams("mainnet");

  const pubkeys: Record<string, string> = {
    program: FUMPAD_PROGRAM_ID.toBase58(),
    deployer: deployer.publicKey.toBase58(),
    "operator (jobs keeper)": operator.toBase58(),
    "attestor-1": keepers[0].toBase58(),
    "attestor-2": keepers[1].toBase58(),
    "attestor-3": keepers[2].toBase58(),
    "launch-signer": launchSigner.toBase58(),
    "dbc-config": configKey.publicKey.toBase58(),
    "dbc-config-first-coin": firstKey.publicKey.toBase58(),
    "first-coin fee wallet (config)": firstWallet.toBase58(),
    admin: admin.toBase58(),
    guardian: guardian.toBase58(),
    treasury: treasury.toBase58(),
    "upgrade authority (final)": upParty.address,
    global: globalPda().toBase58(),
    fee_claimer: feeClaimerPda().toBase58(),
    reward_pool: rewardPoolPda().toBase58(),
  };
  const balance = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));
  say(`cluster ${o.cluster} (cluster_tag ${CLUSTER_TAG.mainnet}) · mode ${o.mode} · program ${FUMPAD_PROGRAM_ID.toBase58()} · deployer ${deployer.publicKey.toBase58()} (${sol(await balance(deployer.publicKey))} SOL) · CU price ${cuPrice} µlamports`);

  /** confirm gate for a sending step: the operator must type `phrase`. */
  const gate = async (step: Step, summary: string[]) => {
    const phrase = `${step} ${FUMPAD_PROGRAM_ID.toBase58().slice(0, 6)}`;
    if (!(await o.confirm(step, summary, phrase))) throw new Error(`${step}: not confirmed (nothing sent)`);
  };
  const track = async <T>(step: Step, fn: () => Promise<T>): Promise<T> => {
    const before = await balance(deployer.publicKey);
    const r = await fn();
    if (o.mode === "send") spent[step] = (spent[step] ?? 0n) + (before - (await balance(deployer.publicKey)));
    return r;
  };

  /** Build a v0 tx (deployer pays, CU limit + price), then plan / simulate / send. */
  /** `cu = 0`: no compute-budget instructions (only for the bundled create_config + initialize_global simulation, which is otherwise over the 1,232-byte limit). */
  const exec = async (step: Step, name: string, ixs: TransactionInstruction[], signers: Signer[], accounts: PublicKey[] = [], cu = 400_000, payer: Keypair = deployer) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...(cu ? [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice })] : []), ...ixs],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))]);
    const raw = tx.serialize();
    const fee = 5_000n * BigInt(msg.header.numRequiredSignatures) + (BigInt(cu) * BigInt(cuPrice)) / 1_000_000n;
    if (raw.length > 1_232) throw new Error(`${name}: transaction is ${raw.length} B (> 1,232)`);
    if (o.mode === "plan") {
      say(`  PLAN ${name}: ${ixs.length} ix, ${raw.length} B, ${msg.header.numRequiredSignatures} sig(s), max fee ${sol(fee)} SOL (add --simulate)`);
      return { ok: true, accounts: [] as ({ owner: PublicKey; data: Uint8Array } | null)[], sig: undefined as string | undefined };
    }
    const r = await conn.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: accounts.map((a) => a.toBase58()) } });
    const ok = !r.value.err;
    if (o.mode === "simulate" || !ok) {
      say(`  SIM  ${name}: ${ok ? "OK" : "FAIL"} · ${r.value.unitsConsumed ?? "?"} CU · ${raw.length} B${ok ? "" : ` · err ${JSON.stringify(r.value.err)}`}`);
      if (!ok) {
        for (const l of (r.value.logs ?? []).slice(-12)) say(`       ${l}`);
        failures.push(`simulate ${name}`);
      }
      const accs = (r.value.accounts ?? []).map((a) => (a ? { owner: new PublicKey(a.owner), data: Uint8Array.from(Buffer.from((a.data as unknown as [string, string])[0], "base64")) } : null));
      return { ok, accounts: accs, sig: undefined };
    }
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    await confirmSignature(conn, sig, lastValidBlockHeight, "confirmed", raw);
    const st = await conn.getSignatureStatus(sig);
    if (st.value?.err) throw new Error(`${name}: failed on chain ${JSON.stringify(st.value.err)} (${sig})`);
    say(`  SENT ${name}: ${sig}`);
    return { ok: true, accounts: [], sig };
  };

  // ── keys (public view; generation happened in the entry point) ───────────
  if (o.steps.includes("keys")) {
    say("\n▶ keys");
    const created = ensureHotKeys(dir);
    say(`  dir ${dir} (700, files 600) · created: ${created.length ? created.join(", ") : "none (all present)"}`);
    for (const [k, v] of Object.entries(pubkeys)) say(`  ${k.padEnd(28)} ${v}`);
    say("  ! back up fumpad-program-keypair.json OFFLINE before deploying (and the attestor / launch-signer keys to your secret store)");
    writeFileSync(join(dir, "pubkeys.json"), `${JSON.stringify({ cluster: o.cluster, ...pubkeys }, null, 2)}\n`, { mode: 0o600 });
  }

  // ── program ──────────────────────────────────────────────────────────────
  if (o.steps.includes("program")) {
    say("\n▶ program (deploy fumpad.so; upgrade authority = deployer until the handover)");
    if (!existsSync(soPath)) {
      failures.push(`no .so at ${soPath}`);
      say(`  missing ${soPath}: npx tsx scripts/mainnet/build-program.ts --program-keypair ${keyPath(dir, "fumpad-program-keypair")}`);
    } else {
      const so = readFileSync(soPath);
      const declares = so.indexOf(Buffer.from(FUMPAD_PROGRAM_ID.toBytes())) >= 0;
      const st = await programState(conn);
      const maxLen = so.length + (cfg.programHeadroomBytes ?? 0);
      const pdRent = BigInt(await conn.getMinimumBalanceForRentExemption(45 + maxLen));
      const progRent = BigInt(await conn.getMinimumBalanceForRentExemption(36));
      const bufRent = BigInt(await conn.getMinimumBalanceForRentExemption(37 + so.length));
      const writes = Math.ceil(so.length / 1_000);
      say(`  .so ${soPath}: ${so.length} B, sha256 ${sha(so)}${declares ? "" : " · DOES NOT EMBED THIS PROGRAM ID"}`);
      say(`  cost: program data rent ${sol(pdRent)} (${45 + maxLen} B) + program account ${sol(progRent)} SOL kept; buffer ${sol(bufRent)} SOL transient (refunded at the deploy); ≈ ${writes} write txs`);
      if (!declares) failures.push(".so does not embed the program id (build it with build-program.ts)");
      // Verifiable build (LAUNCH-DAY.md §1.11): the release commit's contracts/program-ids/mainnet.txt holds this id
      const committed = committedMainnetId();
      if (committed !== FUMPAD_PROGRAM_ID.toBase58()) {
        say(`  contracts/program-ids/mainnet.txt = ${committed ?? "UNSET"} ≠ ${FUMPAD_PROGRAM_ID.toBase58()}: commit the id there and build verifiably from that commit`);
        if (o.cluster === "mainnet") failures.push("contracts/program-ids/mainnet.txt does not hold the program id (verifiable build input)");
      }
      // (a separate check, not part of the chain below: on a local fork the stand-in id is never committed, and the
      // deploy must still run — 13bfa7b had chained it, so the rehearsal never deployed)
      if (o.cluster === "mainnet" && committed !== FUMPAD_PROGRAM_ID.toBase58()) {
        // refused above
      } else if (st.deployed) {
        const same = elfMatches(st.elf, so);
        say(`  deployed already: authority ${st.authority?.toBase58() ?? "none"}, bytecode ${same ? "= this .so (skip)" : "≠ this .so"}`);
        if (!same) failures.push("program deployed with different bytes: upgrades go through the admin multisig (MULTISIG.md), not this step");
      } else if (st.exists) {
        failures.push(`${FUMPAD_PROGRAM_ID.toBase58()} exists but is not a deployed program`);
      } else if (o.mode === "send") {
        const bal = await balance(deployer.publicKey);
        if (bal < pdRent + progRent + bufRent + SOL / 10n) {
          failures.push(`deployer has ${sol(bal)} SOL < program rent + buffer + 0.1 SOL fees`);
        } else {
          await gate("program", [`deploy ${so.length} B (sha256 ${sha(so).slice(0, 16)}…) as ${FUMPAD_PROGRAM_ID.toBase58()}`, `upgrade authority ${deployer.publicKey.toBase58()} (deployer)`, `≈ ${sol(pdRent + progRent)} SOL rent kept + ${sol(bufRent)} SOL transient`]);
          await track("program", async () => deployProgram({ rpcUrl: o.rpcUrl, so: soPath, programKeypair: keyPath(dir, "fumpad-program-keypair"), deployer: deployerPath, cuPrice, maxLen, log: say, solanaBin: o.solanaBin }));
          const after = await programState(conn);
          if (!after.deployed || !elfMatches(after.elf, so) || !after.authority?.equals(deployer.publicKey)) failures.push("after deploy: program missing, bytes differ, or authority ≠ deployer");
          else {
            say(`  ✓ deployed at slot ${after.slot}, authority = deployer, bytes = .so`);
            // the program is callable from a later slot (rehearsed: init simulated in the deploy slot → UnsupportedProgramId)
            for (let i = 0; i < 120 && BigInt(await conn.getSlot("finalized")) <= after.slot + 2n; i++) await new Promise((r) => setTimeout(r, 500));
          }
        }
      } else {
        say(`  ${o.mode === "plan" ? "PLAN" : "SIM "} solana program deploy (not simulatable as a whole: ${writes} buffer writes + deploy); runs only with send`);
      }
    }
  }

  const readAcc = async (k: PublicKey) => {
    const a = await conn.getAccountInfo(k, "confirmed");
    return a ? { owner: a.owner, data: new Uint8Array(a.data) } : null;
  };
  const readConfig = () => readAcc(configKey.publicKey);
  /** [standard, first coin]: keypair, expected params, checker, vector, label. */
  const CONFIGS = [
    { key: configKey, expect: expectConfig, problems: configProblems, vector: "mainnet" as const, label: "standard: 99% → 1.25% over 8 slots, 1.25% DAMM v2" },
    { key: firstKey, expect: expectFirst, problems: firstCoinConfigProblems, vector: "first_coin_mainnet" as const, label: "first coin: 99% → 3% over 25 slots, 3% DAMM v2" },
  ];

  // ── config ───────────────────────────────────────────────────────────────
  if (o.steps.includes("config")) {
    say(`\n▶ config (DBC create_config ×2, MAINNET: ${sol(expectConfig.migrationQuoteThreshold)} SOL threshold, migration fee ${expectConfig.migrationFeePercentage}%, D17 curve; the standard + the first-coin config)`);
    say(`  fee_claimer ${feeClaimerPda().toBase58()} · leftover_receiver ${rewardPoolPda().toBase58()} · rent ${sol(await conn.getMinimumBalanceForRentExemption(1048))} SOL each`);
    for (const c of CONFIGS) {
      const vb = configBytesProblem(c.vector);
      if (vb) failures.push(vb);
      else say(`  ✓ ${c.label}: create_config data = contracts/tests/vectors/dbc_config.json ${c.vector} (${encodeDbcConfigParameters(c.expect).length + 8} B)`);
      say(`  config ${c.key.publicKey.toBase58()}`);
      const cur = await readAcc(c.key.publicKey);
      if (cur) {
        const p = c.problems(cur.owner, cur.data, c.expect);
        say(p.length ? `  EXISTS but wrong: ${p.join("; ")}` : "  exists and passes every §5.4 check + mainnet numbers (skip)");
        if (p.length) failures.push(`config ${c.vector}: ${p.join("; ")}`);
      } else if (!vb) {
        if (o.mode === "send") await gate("config", [`DBC create_config at ${c.key.publicKey.toBase58()} (${c.vector} vector bytes)`, `payer ${deployer.publicKey.toBase58()}`]);
        const r = await track("config", () => exec("config", `create_config (${c.vector})`, [dbcCreateConfigIx({ config: c.key.publicKey, payer: deployer.publicKey, params: c.expect })], [c.key], [c.key.publicKey]));
        if (o.mode === "simulate" && r.ok) {
          const p = c.problems(r.accounts[0]?.owner ?? null, r.accounts[0]?.data ?? null, c.expect);
          say(p.length ? `  simulated config FAILS: ${p.join("; ")}` : "  simulated config passes every §5.4 check + mainnet numbers");
          if (p.length) failures.push(`simulated config ${c.vector}: ${p.join("; ")}`);
        }
        if (o.mode === "send") {
          const after = await readAcc(c.key.publicKey);
          const p = c.problems(after?.owner ?? null, after?.data ?? null, c.expect);
          if (p.length) failures.push(`config ${c.vector} after create: ${p.join("; ")}`);
        }
      }
    }
  }

  // ── init ─────────────────────────────────────────────────────────────────
  if (o.steps.includes("init")) {
    say("\n▶ init (initialize_global: cluster_tag 0, default Params + launch_signer, keepers attestor-1/2/3, operators [operator], configs [standard, first coin + wallet-split policy])");
    say(`  first-coin policy: of FUMPAD's 2.4%, ${firstPolicy.buybackShare / 100}% → buyback, ${firstPolicy.walletShare / 100}% → ${firstWallet.toBase58()} (+ the whole launch-window share), max_coins ${firstPolicy.maxCoins}`);
    const bad = paramsProblems(params);
    if (bad.length) throw new Error(`mainnet params invalid: ${bad.join("; ")}`);
    say(`  params: min sell $${Number(params.minSellUsdCents) / 100}, hold ${params.minHoldSecs}s, challenge ${params.ticketChallengeSecs}s, oracle ${params.oracleWindowSecs}s / ${params.oracleMinSamples} samples (spacing ${params.oracleMinSpacingSecs}s), claim window ${Number(params.claimWindowSecs) / 86_400} d, rebuy ${Number(params.rebuyWindowSecs) / 86_400} d, fees ${params.feeBuybackShareBps}/${params.feePlatformShareBps}/${params.feeCreatorShareBps} bps, trigger ${params.triggerMultipleBps / 10_000}x, claim ${params.claimBps / 100}%, launch_signer ${launchSigner.toBase58()}`);
    say(`  admin = guardian = deployer until the handover · treasury ${treasury.toBase58()} · Global rent ${sol(await conn.getMinimumBalanceForRentExemption(GLOBAL_ACCOUNT_LEN))} SOL`);
    const prog = await programState(conn);
    if (await conn.getAccountInfo(globalPda(), "confirmed")) say("  Global exists (skip; see verify)");
    else if (!prog.deployed) {
      say("  program not deployed yet: run --step program first (nothing to simulate)");
      if (o.mode !== "plan") failures.push("init: program not deployed");
    } else if (!prog.authority?.equals(deployer.publicKey)) {
      failures.push(`init: upgrade authority ${prog.authority?.toBase58() ?? "none"} ≠ deployer (initialize_global would fail)`);
    } else {
      const initIx = initializeGlobalIx({
        payer: deployer.publicKey,
        admin: deployer.publicKey,
        platformTreasury: treasury,
        clusterTag: CLUSTER_TAG.mainnet,
        params,
        keepers,
        operators: [operator],
        configs: [configKey.publicKey, firstKey.publicKey],
        policies: [STANDARD_FEE_POLICY, firstPolicy],
      });
      const [a1, a2] = [await readConfig(), await readAcc(firstKey.publicKey)];
      if (!a1 || !a2) {
        // Two create_config + initialize_global exceed 1,232 bytes: init is simulated once both configs exist.
        say("  config(s) missing: run --step config first (initialize_global needs both configs on chain to simulate)");
        if (o.mode === "send") failures.push("init: config(s) missing (run --step config first)");
      } else {
        if (o.mode === "send") await gate("init", ["initialize_global (irreversible: cluster_tag, keepers, params, configs + policies)", `keepers ${keepers.map((k) => k.toBase58()).join(", ")} · operator ${operator.toBase58()}`, `launch_signer ${launchSigner.toBase58()} · treasury ${treasury.toBase58()}`, `first-coin config ${firstKey.publicKey.toBase58()} → wallet ${firstWallet.toBase58()} (1.0% buyback / 1.4% wallet, max ${firstPolicy.maxCoins})`]);
        await track("init", () => exec("init", "initialize_global", [initIx], [], [globalPda()]));
      }
    }
  }

  // ── fund ─────────────────────────────────────────────────────────────────
  if (o.steps.includes("fund")) {
    say("\n▶ fund (top up the operator + attestors from the deployer)");
    const targets = { ...DEFAULT_FUND_SOL, ...(cfg.fund ?? {}) };
    const rows = await Promise.all(
      (Object.entries(targets) as [FundedKey, number][]).map(async ([name, s]) => {
        const to = hot(name).publicKey;
        const have = await balance(to);
        const target = BigInt(Math.round(s * LAMPORTS_PER_SOL));
        return { name, to, have, target, topUp: have >= target ? 0n : target - have };
      }),
    );
    const topUps = rows.reduce((s, r) => s + r.topUp, 0n);
    for (const r of rows) say(`  ${r.name.padEnd(11)} ${r.to.toBase58().padEnd(44)} has ${sol(r.have)} target ${sol(r.target)} top-up ${sol(r.topUp)}`);
    const prog = await programState(conn);
    const committed = prog.programDataLamports + 2n * BigInt(await conn.getMinimumBalanceForRentExemption(1048)) + BigInt(await conn.getMinimumBalanceForRentExemption(GLOBAL_ACCOUNT_LEN)) + rows.reduce((s, r) => s + (r.have > r.target ? r.have : r.target), 0n);
    say(`  top-ups ${sol(topUps)} SOL · committed (program data + config + Global + keeper balances) ${sol(committed)} SOL · budget ${sol(budget)} SOL`);
    if (committed > budget) failures.push(`fund: committed ${sol(committed)} > budget ${sol(budget)} SOL (config budgetSol)`);
    else if (topUps === 0n) say("  every keeper at or above target (skip)");
    else {
      if (o.mode === "send") await gate("fund", rows.filter((r) => r.topUp > 0n).map((r) => `${sol(r.topUp)} SOL → ${r.name} ${r.to.toBase58()}`));
      await track("fund", () => exec("fund", `fund ${rows.filter((r) => r.topUp > 0n).length} keepers (${sol(topUps)} SOL)`, rows.filter((r) => r.topUp > 0n).map((r) => SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: r.to, lamports: r.topUp })), []));
    }
  }

  // ── alt (the launch lookup table; frozen, so the deployer's authority ends with its creation tx) ─────────────
  if (o.steps.includes("alt")) {
    const addr = await track("alt", () =>
      launchAltStep({
        conn,
        dir,
        cluster: o.cluster,
        authority: deployer,
        mode: o.mode,
        exec: (name, ixs, accounts) => exec("alt", name, ixs, [], accounts),
        say,
        failures,
        beforeSend: (summary) => gate("alt", summary),
      }),
    );
    if (addr) pubkeys["launch-alt"] = addr.toBase58();
    else if (o.mode === "send") next.push("--step alt (the launch lookup table; the API refuses every launch without LAUNCH_ALT)");
  }

  // ── governance parties (read-only; needed by the handover steps and verify) ──
  const partyCheck = async () => {
    const out = { problems: [] as string[], warnings: [] as string[] };
    for (const [name, p] of [["admin", cfg.admin], ["guardian", cfg.guardian], ...(cfg.upgradeAuthority ? [["upgradeAuthority", cfg.upgradeAuthority] as const] : [])] as const) {
      const r = await partyProblems(conn, name, p);
      for (const l of r.lines) say(`  ${l}`);
      out.problems.push(...r.problems);
      out.warnings.push(...r.warnings);
    }
    return out;
  };
  const globalNow = async () => {
    const a = await conn.getAccountInfo(globalPda(), "confirmed");
    return a ? decodeGlobal(new Uint8Array(a.data)) : null;
  };
  const chainNow = async () => Number((await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"), "confirmed"))!.data.readBigInt64LE(32));

  // ── propose-admin ────────────────────────────────────────────────────────
  if (o.steps.includes("propose-admin")) {
    say("\n▶ propose-admin (deployer proposes admin = admin vault, guardian = guardian vault, treasury; 6 h; the guardian (= deployer until then) can cancel_admin)");
    const pc = await partyCheck();
    warnings.push(...pc.warnings);
    const g = await globalNow();
    if (pc.problems.length) failures.push(...pc.problems.map((p) => `propose-admin: ${p}`));
    else if (!g) {
      say("  no Global yet (run init first)");
      if (o.mode !== "plan") failures.push("propose-admin: no Global");
    } else if (g.admin.equals(admin)) say("  admin is already the admin vault (handover done; skip)");
    else if (!g.admin.equals(deployer.publicKey)) failures.push(`propose-admin: Global.admin ${g.admin.toBase58()} is neither the deployer nor the configured admin`);
    else if (g.pendingAdminEta !== 0n) {
      const same = g.pendingAdmin.equals(admin) && g.pendingGuardian.equals(guardian) && g.pendingTreasury.equals(treasury);
      if (same) say(`  already pending with these keys, eta ${new Date(Number(g.pendingAdminEta) * 1000).toISOString()} (skip)`);
      else failures.push(`propose-admin: another proposal is pending (admin ${g.pendingAdmin.toBase58()}): cancel_admin first`);
    } else {
      if (o.mode === "send") await gate("propose-admin", [`propose_admin(new_admin ${admin.toBase58()}, treasury ${treasury.toBase58()}, guardian ${guardian.toBase58()})`, "accept_admin possible after 48 h, signed by the admin vault (Squads)"]);
      await track("propose-admin", () => exec("propose-admin", "propose_admin", [proposeAdminIx(deployer.publicKey, admin, treasury, guardian)], []));
    }
  }

  // ── accept-admin ─────────────────────────────────────────────────────────
  if (o.steps.includes("accept-admin")) {
    say("\n▶ accept-admin (through the admin multisig: vault tx → voters approve in the Squads app → after 6 h eta AND Squads time lock → execute)");
    const g = await globalNow();
    if (!g) failures.push("accept-admin: no Global");
    else if (g.admin.equals(admin)) say("  Global.admin = admin vault already (skip)");
    else if (g.pendingAdminEta === 0n || !g.pendingAdmin.equals(admin)) failures.push("accept-admin: no pending propose_admin for the configured admin (run propose-admin)");
    else if (cfg.admin.kind !== "squads") {
      say(`  admin is a hardware wallet: it signs accept_admin itself after ${new Date(Number(g.pendingAdminEta) * 1000).toISOString()} (not automated here)`);
      next.push("hardware admin signs accept_admin");
    } else {
      const ms = new PublicKey(cfg.admin.multisig!);
      const ops = cfg.opsKeypair ? readKeypairFile(rel(cfg.opsKeypair)) : null;
      let index = await findAcceptAdminTx(conn, ms);
      if (index === null) {
        if (!ops) {
          say("  no accept_admin vault tx yet and no opsKeypair in the config: create it in the Squads app (transaction builder: program = FUMPAD, ix accept_admin, signer = vault) or set opsKeypair");
          next.push("create the accept_admin vault transaction");
        } else {
          if (o.mode === "send") await gate("accept-admin", [`create vault tx accept_admin on admin multisig ${ms.toBase58()} (creator = ops key ${ops.publicKey.toBase58()}, no approval)`]);
          if (o.mode === "plan") say(`  PLAN create vault tx accept_admin on ${ms.toBase58()} by the ops key`);
          else index = await proposeVaultTx(conn, ms, ops, { kind: "accept-admin" }, o.mode === "send" ? "send" : "simulate", say);
          if (o.mode === "simulate") index = null;
        }
      }
      if (index !== null) {
        const st = await proposalState(conn, ms, index);
        const now = await chainNow();
        const eta = Number(g.pendingAdminEta);
        say(`  vault tx #${index}: ${st.status}, ${st.approvals.length}/${st.threshold} approvals${st.executableAt ? ` · Squads time lock releases ${new Date(st.executableAt * 1000).toISOString()}` : ""} · FUMPAD eta ${new Date(eta * 1000).toISOString()} · chain now ${new Date(now * 1000).toISOString()}`);
        if (st.status === "Active" || st.status === "Draft") next.push(`voters approve admin multisig tx #${index} in the Squads app (${st.threshold - st.approvals.length} more)`);
        else if (st.status === "Approved" && (now < eta || (st.executableAt ?? 0) > now)) next.push(`execute admin multisig tx #${index} after ${new Date(Math.max(eta, st.executableAt ?? 0) * 1000).toISOString()}`);
        else if (st.status === "Approved") {
          if (!ops) next.push(`execute admin multisig tx #${index} in the Squads app (or set opsKeypair)`);
          else if (o.mode === "plan") say(`  PLAN execute #${index} with the ops key`);
          else {
            if (o.mode === "send") await gate("accept-admin", [`execute admin multisig tx #${index} (accept_admin): Global.admin → ${admin.toBase58()}, guardian → ${guardian.toBase58()}`]);
            await executeVaultTx(conn, ms, index, ops, o.mode === "send" ? "send" : "simulate", say);
            if (o.mode === "send") {
              const g2 = await globalNow();
              if (!g2?.admin.equals(admin) || !g2.guardian.equals(guardian)) failures.push("accept-admin: executed but Global.admin/guardian not updated");
              else say("  ✓ Global.admin = admin vault, guardian = guardian vault");
            }
          }
        } else if (st.status !== "Executed") failures.push(`accept-admin: vault tx #${index} is ${st.status}`);
      }
    }
  }

  // ── upgrade-authority ────────────────────────────────────────────────────
  if (o.steps.includes("upgrade-authority")) {
    const target = new PublicKey(upParty.address);
    say(`\n▶ upgrade-authority (deployer → ${upParty.kind === "squads" ? "admin multisig vault" : "hardware wallet"} ${target.toBase58()}; irreversible; only after the admin vault executed accept_admin)`);
    const g = await globalNow();
    const st = await programState(conn);
    const pr = await partyProblems(conn, "upgradeAuthority", upParty);
    if (st.authority?.equals(target)) say("  already the target (skip)");
    else if (!g?.admin.equals(admin)) {
      say("  refusing: Global.admin is not the admin vault yet (MULTISIG.md order: accept_admin first)");
      if (o.mode !== "plan") failures.push("upgrade-authority: handover not complete");
    } else if (pr.problems.length) failures.push(...pr.problems.map((p) => `upgrade-authority: ${p}`));
    else if (!st.authority?.equals(deployer.publicKey)) failures.push(`upgrade-authority: current authority ${st.authority?.toBase58() ?? "none"} ≠ deployer`);
    else {
      if (o.mode === "send") await gate("upgrade-authority", [`BPF loader SetAuthority: ${FUMPAD_PROGRAM_ID.toBase58()} upgrade authority ${deployer.publicKey.toBase58()} → ${target.toBase58()}`, "IRREVERSIBLE: from now on upgrades need the admin multisig"]);
      await track("upgrade-authority", () => exec("upgrade-authority", "set upgrade authority", [setUpgradeAuthorityIx(deployer.publicKey, target)], []));
    }
  }

  // ── verify ───────────────────────────────────────────────────────────────
  if (o.steps.includes("verify")) {
    say("\n▶ verify");
    const checks: [string, boolean, string?][] = [];
    const prog = await programState(conn);
    const so = existsSync(soPath) ? readFileSync(soPath) : null;
    checks.push([`program ${FUMPAD_PROGRAM_ID.toBase58()} deployed (upgradeable)`, prog.deployed]);
    if (so) checks.push(["deployed bytecode = the built .so", elfMatches(prog.elf, so), `${so.length} B, sha256 ${sha(so).slice(0, 12)}…`]);
    const g = await globalNow();
    const handedOver = !!g?.admin.equals(admin);
    const finalAuth = new PublicKey(upParty.address);
    checks.push([`upgrade authority = ${prog.authority?.equals(finalAuth) ? "final (" + upParty.kind + ")" : "deployer (pre-handover)"}`, !!prog.authority && (prog.authority.equals(deployer.publicKey) || prog.authority.equals(finalAuth)), prog.authority?.toBase58()]);
    const [dbc, damm, mcfg, flash] = await Promise.all([conn.getAccountInfo(DBC_PROGRAM_ID), conn.getAccountInfo(DAMM_V2_PROGRAM_ID), conn.getAccountInfo(DAMM_V2_MIGRATION_CONFIG), conn.getBalance(DBC_POOL_AUTHORITY)]);
    checks.push(["Meteora DBC + DAMM v2 programs present", !!dbc?.executable && !!damm?.executable]);
    if (existsSync(TESTED_MANIFEST)) {
      const tested = JSON.parse(readFileSync(TESTED_MANIFEST, "utf8")) as Manifest;
      for (const name of ["dbc", "damm_v2", "squads_v4"]) {
        const t = tested.programs.find((p) => p.name === name);
        if (!t) continue;
        const live = await programState(conn, new PublicKey(t.id));
        checks.push([`${name} bytes = the rehearsed ones (${TESTED_MANIFEST.split("/").pop()})`, !!live.elf && sha(live.elf) === t.sha256, live.elf ? sha(live.elf).slice(0, 12) : "missing"]);
      }
    }
    checks.push([`DAMM v2 migration config ${DAMM_V2_MIGRATION_CONFIG.toBase58().slice(0, 8)}… exists`, !!mcfg && mcfg.owner.equals(DAMM_V2_PROGRAM_ID)]);
    checks.push(["DBC pool authority holds flash rent (≥ 0.05 SOL)", BigInt(flash) >= SOL / 20n, `${sol(flash)} SOL`]);
    for (const c of CONFIGS) {
      const vb = configBytesProblem(c.vector);
      checks.push([`create_config bytes = ${c.vector} vector`, !vb, vb ?? undefined]);
      const acc = await readAcc(c.key.publicKey);
      const cp = c.problems(acc?.owner ?? null, acc?.data ?? null, c.expect);
      checks.push([`DBC config ${c.key.publicKey.toBase58()} (${c.label}) passes §5.4 + mainnet numbers`, cp.length === 0, cp.join("; ") || undefined]);
    }
    checks.push([`Global ${globalPda().toBase58()} initialized`, !!g]);
    if (g) {
      const now = BigInt(await chainNow());
      const same = (a: PublicKey[], b: PublicKey[]) => a.length === b.length && a.every((x, i) => x.equals(b[i]));
      checks.push(["cluster_tag 0 (mainnet)", g.clusterTag === CLUSTER_TAG.mainnet, String(g.clusterTag)]);
      checks.push(["keepers = attestor-1/2/3, keeper_added_at = 0, all 3 active", same(g.keepers, keepers) && g.keeperAddedAt.every((t) => t === 0n) && activeKeepers(g, now).length === 3]);
      checks.push(["operators = [operator] (jobs key), disjoint from the attestors", same(g.operators, [operator, PublicKey.default]) && !keepers.some((k) => k.equals(operator))]);
      const std = configSlot(g, configKey.publicKey);
      const first = configSlot(g, firstKey.publicKey);
      const fp = first?.policy;
      checks.push(["configs[0] = the standard config, standard fee policy", !!std && std.index === 0 && std.policy.kind === FEE_POLICY.standard && g.configs.length === MAX_CONFIGS]);
      checks.push([
        `first-coin config allow-listed: wallet-split {buyback ${firstPolicy.buybackShare}, wallet ${firstPolicy.walletShare}, max ${firstPolicy.maxCoins}} → ${firstWallet.toBase58()} (or removed after the first coin)`,
        first ? !!fp && fp.kind === FEE_POLICY.walletSplit && fp.buybackShare === firstPolicy.buybackShare && fp.walletShare === firstPolicy.walletShare && fp.maxCoins === firstPolicy.maxCoins && fp.wallet.equals(firstWallet) : true,
        first ? `coins ${first.coins}/${fp?.maxCoins}` : "not allow-listed (removed)",
      ]);
      if (first && first.coins >= (fp?.maxCoins || Infinity)) next.push("the first coin launched: --step remove-first-coin-config (LAUNCH-DAY.md)");
      checks.push(["only those configs", g.configs.filter((c) => !c.equals(PublicKey.default)).length === (first ? 2 : 1)]);
      const pd = paramsDiff(g.params, params);
      checks.push(["params = mainnet defaults + launch_signer (field by field)", pd.length === 0, pd.join("; ") || undefined]);
      checks.push(["platform_treasury = config treasury", g.platformTreasury.equals(treasury), g.platformTreasury.toBase58()]);
      checks.push(["not paused, no params change pending", g.paused === 0 && g.pendingEta === 0n]);
      if (g.pendingConfigEta !== 0n) next.push(`config change pending (${g.pendingConfig.toBase58()} ${g.pendingConfigAdd ? "add" : "remove"}): --step remove-first-coin-config after ${new Date(Number(g.pendingConfigEta) * 1000).toISOString()}`);
      if (handedOver) {
        checks.push(["admin = admin vault, guardian = guardian vault, nothing pending", g.guardian.equals(guardian) && g.pendingAdminEta === 0n]);
        if (!prog.authority?.equals(finalAuth)) next.push("run --step upgrade-authority (the admin vault has proven it executes)");
      } else if (g.pendingAdminEta !== 0n) {
        checks.push(["handover pending: pending admin/guardian/treasury = configured", g.pendingAdmin.equals(admin) && g.pendingGuardian.equals(guardian) && g.pendingTreasury.equals(treasury)]);
        next.push(`after ${new Date(Number(g.pendingAdminEta) * 1000).toISOString()} and the Squads approvals + time lock: --step accept-admin`);
      } else {
        checks.push(["admin = guardian = deployer (pre-handover)", g.admin.equals(deployer.publicKey) && g.guardian.equals(deployer.publicKey)]);
        next.push("--step propose-admin");
      }
    } else next.push("--step program, config, init");
    const altCheck = await launchAltCheck(conn, dir);
    checks.push(altCheck);
    if (!altCheck[1]) next.push("--step alt, then set LAUNCH_ALT (api) + NEXT_PUBLIC_LAUNCH_ALT (app)");
    const pc = await partyCheck();
    for (const p of pc.problems) checks.push([`governance: ${p}`, false]);
    warnings.push(...pc.warnings);
    const targets = { ...DEFAULT_FUND_SOL, ...(cfg.fund ?? {}) };
    // funded to the target by `fund`; operating keepers spend (rent float, fees): fail below a quarter of it, warn below it
    for (const [name, s] of Object.entries(targets) as [FundedKey, number][]) {
      const have = await balance(hot(name).publicKey);
      const target = BigInt(Math.round(s * LAMPORTS_PER_SOL));
      checks.push([`${name} balance ≥ ¼ of its ${s} SOL target`, have * 4n >= target, `${sol(have)} SOL`]);
      if (have < target) warnings.push(`${name} below its ${s} SOL target (${sol(have)} SOL): --step fund tops it up`);
    }
    for (const [what, ok, detail] of checks) {
      say(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  (${detail})` : ""}`);
      if (!ok) failures.push(what);
    }
    if (prog.authority?.equals(finalAuth) && handedOver) say("  ✓ governance handover complete: admin, guardian and upgrade authority are the configured parties");
  }

  // ── remove-first-coin-config (LAUNCH-DAY.md: right after the first coin) ────────────────────────────────
  if (o.steps.includes("remove-first-coin-config")) {
    say("\n▶ remove-first-coin-config (queue_config remove by the admin → config timelock → execute_config; the launched coin keeps its policy snapshot)");
    const g = await globalNow();
    const slot = g ? configSlot(g, firstKey.publicKey) : null;
    const now = BigInt(await chainNow());
    const pending = !!g && g.pendingConfigEta !== 0n && g.pendingConfig.equals(firstKey.publicKey) && g.pendingConfigAdd === 0;
    if (!g) failures.push("remove-first-coin-config: no Global");
    else if (!slot) say("  the first-coin config is not on the allow-list (done)");
    else if (pending && now >= g.pendingConfigEta) {
      if (o.mode === "send") await gate("remove-first-coin-config", [`execute_config: remove ${firstKey.publicKey.toBase58()} from the allow-list (permissionless after the eta)`]);
      await track("remove-first-coin-config", () => exec("remove-first-coin-config", "execute_config (remove first-coin config)", [executeConfigIx(deployer.publicKey, firstKey.publicKey)], [], [globalPda()]));
    } else if (pending) {
      next.push(`rerun --step remove-first-coin-config after ${new Date(Number(g.pendingConfigEta) * 1000).toISOString()} (config timelock)`);
      say(`  removal queued; executable after ${new Date(Number(g.pendingConfigEta) * 1000).toISOString()}`);
    } else if (g.pendingConfigEta !== 0n) failures.push(`remove-first-coin-config: another config change is pending (${g.pendingConfig.toBase58()})`);
    else {
      if (slot.coins === 0) warnings.push("no coin registered on the first-coin config yet: removing it means the first coin can't launch on it");
      const ix = (admin_: PublicKey) => queueConfigIx(admin_, firstKey.publicKey, false);
      if (g.admin.equals(deployer.publicKey)) {
        if (o.mode === "send") await gate("remove-first-coin-config", [`queue_config(${firstKey.publicKey.toBase58()}, remove) by the deployer (admin before the handover)`]);
        await track("remove-first-coin-config", () => exec("remove-first-coin-config", "queue_config (remove first-coin config)", [ix(deployer.publicKey)], [], [globalPda()]));
      } else if (cfg.admin.kind === "squads" && g.admin.equals(admin)) {
        const ms = new PublicKey(cfg.admin.multisig!);
        const ops = cfg.opsKeypair ? readKeypairFile(rel(cfg.opsKeypair)) : null;
        if (!ops) next.push(`propose it on the admin multisig: npx tsx scripts/ops/multisig.ts propose --multisig ${ms.toBase58()} --action remove-config --config ${firstKey.publicKey.toBase58()} (or the Squads app), voters approve, execute; then rerun this step`);
        else if (o.mode === "plan") say(`  PLAN admin-multisig vault tx queue_config(remove ${firstKey.publicKey.toBase58()}) by the ops key`);
        else {
          if (o.mode === "send") await gate("remove-first-coin-config", [`create admin-multisig vault tx queue_config(${firstKey.publicKey.toBase58()}, remove) (creator = ops key ${ops.publicKey.toBase58()})`]);
          const index = await proposeVaultTx(conn, ms, ops, { kind: "custom", name: "queue_config(remove first-coin config)", ixs: (vault) => [ix(vault)] }, o.mode === "send" ? "send" : "simulate", say);
          next.push(`voters approve admin multisig tx #${index}, then execute it (Squads app or multisig.ts execute); rerun this step after the config timelock`);
        }
      } else next.push(`the admin (${g.admin.toBase58()}) queues queue_config(${firstKey.publicKey.toBase58()}, remove)`);
    }
  }

  for (const w of [...new Set(warnings)]) say(`  ! ${w}`);
  if (next.length) say(`\nnext: ${[...new Set(next)].join(" · ")}`);
  say(failures.length ? `\n✗ ${failures.length} problem(s):\n  - ${failures.join("\n  - ")}` : "\n✓ done");
  return { ok: failures.length === 0, failures, warnings, pubkeys, next, spent };
}

/** `solana program deploy` with a temporary CLI config (mode 600) so the RPC URL is never on a command line. */
export function deployProgram(a: { rpcUrl: string; so: string; programKeypair: string; deployer: string; cuPrice: number; maxLen: number; log: (s: string) => void; solanaBin?: string }): void {
  const bin = a.solanaBin ?? join(process.env.HOME ?? "", ".local/share/solana/install/active_release/bin");
  const tmp = mkdtempSync(join(tmpdir(), "fumpad-deploy-"));
  const cliConfig = join(tmp, "cli.yml");
  writeFileSync(cliConfig, `json_rpc_url: "${a.rpcUrl}"\nwebsocket_url: ""\nkeypair_path: "${a.deployer}"\naddress_labels: {}\ncommitment: confirmed\n`, { mode: 0o600 });
  try {
    const out = execFileSync(
      join(bin, "solana"),
      ["program", "deploy", a.so, "--config", cliConfig, "--program-id", a.programKeypair, "--upgrade-authority", a.deployer, "--keypair", a.deployer, "--max-len", String(a.maxLen), "--with-compute-unit-price", String(a.cuPrice), "--max-sign-attempts", "100", "--use-rpc", "--commitment", "confirmed"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    for (const l of out.trim().split("\n")) a.log(`  solana: ${redactText(l, a.rpcUrl)}`);
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(redactText(`solana program deploy failed: ${x.stderr || x.stdout || x.message} (a partial deploy leaves a buffer: \`solana program show --buffers\`; resume with --buffer or close it)`, a.rpcUrl));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export type { MainnetConfig };
