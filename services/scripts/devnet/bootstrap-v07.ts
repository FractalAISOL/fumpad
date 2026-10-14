/**
 * FUMPAD v0.7 devnet bootstrap (services/DEPLOY-v07.md). Idempotent; every step re-reads the chain first and only
 * does what is missing. Run from services/ AFTER the program is deployed (`solana program deploy`, DEPLOY-v07.md §2):
 *
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step keys                 # generate missing keypairs, print pubkeys
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step all                  # PLAN only (default: nothing simulated or sent)
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step all --simulate       # simulateTransaction only (nothing sent)
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step config --yes         # create the FUMPAD DBC config
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step init --yes           # initialize_global (bootstrap keepers, operator, config)
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step operators --yes      # existing Global: migrate_global + set_operators
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step policies --yes       # existing Global (pre-2026-10-14): grow it (migrate_global),
 *                                                                         # then queue → (timelock) → execute the first-coin config add
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step first-coin-done --yes  # after the first coin: queue → (timelock) → execute its removal
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step fund --yes           # top up wallets (plan printed first)
 *   npx tsx scripts/devnet/bootstrap-v07.ts --step verify               # read back Global/config/balances, checklist
 *
 * Steps: keys | config | init | operators | policies | fund | verify | first-coin-done
 *   all = keys, config, init, operators, policies, fund, verify (first-coin-done only on its own, after the first coin).
 * Configs (INTERFACE §5.9): `dbc-config` = the standard config (99% → 1.25% / 8 slots), `dbc-config-first-coin` = the
 *   one-off first-coin config (99% → 3% / 25 slots, 3% DAMM v2) allow-listed with the wallet-split policy {buyback 100,
 *   wallet 140 (bps of volume), max_coins 1, wallet = `first-coin-wallet`} (mainnet: config firstCoin.feeWallet).
 * Modes: (none) plan · --simulate (simulateTransaction, sigVerify on) · --yes (send). --simulate of `init` while the
 *   config doesn't exist yet simulates create_config + initialize_global in ONE transaction.
 * Options: --cluster devnet|local (local = rehearsal on solana-test-validator, scripts/local/bootstrap-rehearsal.ts),
 *   --keys-dir <dir> (default ~/fumpad-keys/devnet/v07), --deployer <keypair> (default ~/.config/solana/id.json =
 *   the program upgrade authority = admin), --budget-sol <n> (default 10).
 * RPC: RPC_URL from ~/fumpad-keys/devnet/rpc.env (never printed; errors are redacted). Secrets are never printed:
 *   keypair files are written mode 600 and only pubkeys are shown.
 *
 * Roles (DEPLOY-v07.md §1): admin = guardian = deployer (devnet). Keepers = attestor-1/2/3 (attestations ONLY);
 * operators = [operator] = the jobs keeper's own key (record_samples keeper samples, claim_for, pre-graduation
 * buybacks). The program refuses a key in both sets, so no host holds an attestation key AND the jobs key.
 * `operators` step (a Global initialized before operators existed): one transaction `migrate_global` (fills
 * operators[0] from keepers[0], the old jobs key) + `set_operators([operator])`, so the overlap never persists.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
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
  type DbcConfigParameters,
  configSlot,
  dbcCreateConfigIx,
  decodeDbcConfig,
  decodeGlobal,
  DEFAULT_PARAMS,
  executeConfigIx,
  FEE_POLICY,
  type FeePolicy,
  feePolicyProblems,
  FIRST_COIN_FEE_BPS,
  FIRST_COIN_PERIODS,
  FIRST_COIN_REDUCTION,
  firstCoinConfigParams,
  queueConfigIx,
  STANDARD_FEE_POLICY,
  feeClaimerPda,
  FUMPAD_PROGRAM_ID,
  fumpadConfigParams,
  type GlobalAccount,
  globalPda,
  hasMeteoraDiscriminator,
  initializeGlobalIx,
  MAX_CONFIGS,
  migrateGlobalIx,
  type Params,
  paramsProblems,
  programDataPda,
  rewardPoolPda,
  SNIPE_CLIFF_FEE_NUMERATOR,
  SNIPE_PERIODS,
  SNIPE_REDUCTION,
  setOperatorsIx,
  WSOL_MINT,
} from "@fumpad/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(here, "../..");
const SO_PATH = resolve(SERVICES, "../contracts/target/deploy/fumpad.so");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SOL = BigInt(LAMPORTS_PER_SOL);
const sol = (l: bigint | number) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4);

export type Cluster = "devnet" | "local";
export type Mode = "plan" | "simulate" | "send";
export type Step = "keys" | "config" | "init" | "operators" | "policies" | "fund" | "verify" | "first-coin-done";
export const STEPS: Step[] = ["keys", "config", "init", "operators", "policies", "fund", "verify", "first-coin-done"];
/** `--step all`: everything but `first-coin-done` (that one runs after the first coin launched). */
export const ALL_STEPS: Step[] = ["keys", "config", "init", "operators", "policies", "fund", "verify"];

/** Global account length since the fee policies (2026-10-14); a 1,044-byte Global is the previous layout. */
export const GLOBAL_LEN = 1_491;
export const GLOBAL_LEN_V1 = 1_044;

/**
 * Keypairs the bootstrap owns (keys dir, mode 600). `dbc-config` / `dbc-config-first-coin` = the standard / first-coin
 * DBC config accounts' keypairs; `first-coin-wallet` = devnet's stand-in for the first coin's fee wallet (mainnet:
 * config firstCoin.feeWallet, never a hot key).
 */
export const KEY_NAMES = ["attestor-1", "attestor-2", "attestor-3", "operator", "launch-signer", "treasury", "guardian", "creator", "alice", "bob", "whale", "dbc-config", "dbc-config-first-coin", "first-coin-wallet"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/**
 * Funding targets (lamports). The operator is the jobs keeper: graduation setup on devnet (claim queue 0.417 SOL +
 * observations rent) is mostly NOT covered by the 1% migration fee of a 0.85 SOL raise (0.0085 SOL). Attestors pay
 * position/ticket/marker rent (~0.0055 SOL per ticket, refunded on close). Test wallets: whale can
 * complete a 0.85 SOL curve alone. launch-signer only co-signs (never pays); guardian = admin on devnet (unused).
 */
export const FUND_TARGETS: Partial<Record<KeyName, bigint>> = {
  operator: 2n * SOL,
  "attestor-1": SOL / 4n,
  "attestor-2": SOL / 4n,
  "attestor-3": SOL / 4n,
  treasury: SOL / 100n,
  creator: SOL / 2n,
  alice: (SOL * 4n) / 10n,
  bob: (SOL * 4n) / 10n,
  whale: (SOL * 12n) / 10n,
  // a fee wallet must stay rent-exempt to receive claims (claim_fees refuses otherwise: FeeWalletNotRentExempt)
  "first-coin-wallet": SOL / 100n,
};

/** The first-coin config's fee policy (user decision 2026-10-14): of FUMPAD's 2.4%, 1.0% → buyback, 1.4% → `wallet`; one coin. */
export function firstCoinPolicy(wallet: PublicKey): FeePolicy {
  return { kind: FEE_POLICY.walletSplit, buybackShare: 100, walletShare: 140, maxCoins: 1, wallet };
}

/** Why a first-coin DBC config isn't the expected one: every standard check with the first-coin fee numbers. */
export function firstCoinConfigProblems(owner: PublicKey | null, d: Uint8Array | null, expect: DbcConfigParameters): string[] {
  return configProblems(owner, d, expect, { periods: FIRST_COIN_PERIODS, reduction: FIRST_COIN_REDUCTION, label: "99% → 3% over 25 × 1 slot" });
}

/** Global params for devnet: inside `Params::is_valid` bounds, test-friendly; everything else = mainnet defaults. */
export function bootstrapParams(launchSigner: PublicKey): Params {
  return { ...DEFAULT_PARAMS, minSellUsdCents: 500n, minHoldSecs: 60n, ticketChallengeSecs: 3_600n, oracleWindowSecs: 600n, oracleMinSamples: 28, launchSigner };
}

export interface BootstrapOpts {
  cluster: Cluster;
  mode: Mode;
  steps: Step[];
  rpcUrl: string;
  keysDir: string;
  deployerPath: string;
  budgetLamports: bigint;
  log?: (s: string) => void;
}

export interface BootstrapResult {
  ok: boolean;
  failures: string[];
  pubkeys: Record<string, string>;
}

/** Read RPC_URL from an env file without exporting or printing it. */
export function readRpcUrl(file = join(homedir(), "fumpad-keys/devnet/rpc.env")): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  if (!existsSync(file)) throw new Error(`no RPC_URL in the environment and no ${file}`);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?RPC_URL\s*=\s*(.*)\s*$/.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  throw new Error(`RPC_URL not found in ${file}`);
}

const readKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));

class Keys {
  constructor(readonly dir: string) {}
  path = (n: KeyName) => join(this.dir, `${n}.json`);
  has = (n: KeyName) => existsSync(this.path(n));
  get(n: KeyName): Keypair {
    if (!this.has(n)) throw new Error(`missing ${this.path(n)}: run --step keys first`);
    return readKeypair(this.path(n));
  }
  pub = (n: KeyName) => this.get(n).publicKey;
  /** Create missing keypairs (dir 700, files 600, never overwritten). Returns the names created. */
  ensure(): KeyName[] {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const created: KeyName[] = [];
    for (const n of KEY_NAMES) {
      if (this.has(n)) {
        chmodSync(this.path(n), 0o600);
        continue;
      }
      writeFileSync(this.path(n), JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600, flag: "wx" });
      created.push(n);
    }
    return created;
  }
}

/** Why a DBC config account isn't the expected FUMPAD config (INTERFACE §5.4 structure + our numeric choices). */
export function configProblems(
  owner: PublicKey | null,
  d: Uint8Array | null,
  expect: DbcConfigParameters,
  fees: { periods: number; reduction: bigint; label: string } = { periods: SNIPE_PERIODS, reduction: SNIPE_REDUCTION, label: `99% → 1.25% over ${SNIPE_PERIODS} × 1 slot` },
): string[] {
  if (!d || !owner) return ["config account missing"];
  const out: string[] = [];
  if (!owner.equals(DBC_PROGRAM_ID)) out.push(`owner ${owner.toBase58()} is not DBC`);
  if (d.length !== 1048) out.push(`length ${d.length} ≠ 1048`);
  if (!hasMeteoraDiscriminator(d, "dbcPoolConfig")) out.push("not a DBC PoolConfig (discriminator)");
  if (out.length) return out;
  const pk = (off: number) => new PublicKey(d.subarray(off, off + 32));
  const zero = (off: number, len: number) => d.subarray(off, off + len).every((b) => b === 0);
  const c = decodeDbcConfig(d);
  const want: [string, boolean][] = [
    ["quote_mint = WSOL", pk(8).equals(WSOL_MINT)],
    ["fee_claimer = fumpad PDA", pk(40).equals(feeClaimerPda())],
    ["leftover_receiver = fumpad reward_pool PDA", pk(72).equals(rewardPoolPda())],
    ["collect_fee_mode 0 (quote)", d[232] === 0],
    ["migration_option 1 (DAMM v2)", d[233] === 1],
    ["activation_type 0 (slot)", d[234] === 0],
    ["token_decimal 6", d[235] === 6],
    ["token_type 1 (Token-2022)", d[237] === 1],
    ["partner_permanent_locked 100", d[239] === 100],
    ["partner_liquidity 0", d[240] === 0],
    ["creator_permanent_locked 0", d[241] === 0],
    ["creator_liquidity 0", d[242] === 0],
    ["migration_fee_option 6 (Customizable)", d[243] === 6],
    ["fixed_token_supply_flag 1", d[244] === 1],
    ["creator_trading_fee_percentage 0", d[245] === 0],
    ["token_update_authority 1 (Immutable)", d[246] === 1],
    ["creator_migration_fee_percentage 0", d[248] === 0],
    ["liquidity vesting infos zero", zero(184, 16) && zero(200, 16)],
    ["locked vesting zero", zero(296, 40)],
    ["migrated_collect_fee_mode 0 (OnlyB)", d[360] === 0],
    ["pre = post migration supply", c.preMigrationTokenSupply === c.postMigrationTokenSupply && c.preMigrationTokenSupply === expect.tokenSupply?.pre],
    [`migration_quote_threshold ${sol(expect.migrationQuoteThreshold)} SOL`, c.migrationQuoteThreshold === expect.migrationQuoteThreshold],
    [`migration_fee_percentage ${expect.migrationFeePercentage}%`, c.migrationFeePercentage === expect.migrationFeePercentage],
    [
      `fee scheduler ${fees.label}`,
      c.baseFee.cliffFeeNumerator === SNIPE_CLIFF_FEE_NUMERATOR && c.baseFee.numberOfPeriod === fees.periods && c.baseFee.periodFrequency === 1n && c.baseFee.reductionFactor === fees.reduction && c.baseFee.baseFeeMode === 0,
    ],
    [`migrated pool fee ${expect.migratedPoolFeeBps} bps`, c.migratedPoolFeeBps === expect.migratedPoolFeeBps],
    ["enable_first_swap_with_min_fee", c.enableFirstSwapWithMinFee === 1],
    ["sqrt_start_price + curve = the expected exact-8% curve", c.sqrtStartPrice === expect.sqrtStartPrice && c.curve.length === expect.curve.length && c.curve.every((p, i) => p.sqrtPrice === expect.curve[i].sqrtPrice && p.liquidity === expect.curve[i].liquidity)],
  ];
  for (const [what, ok] of want) if (!ok) out.push(what);
  return out;
}

/** Field-by-field differences between two Params (bigint/number/PublicKey aware). */
export function paramsDiff(a: Params, b: Params): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a) as (keyof Params)[]) {
    const x = a[k];
    const y = b[k];
    const eq = x instanceof PublicKey ? y instanceof PublicKey && x.equals(y) : String(x) === String(y);
    if (!eq) out.push(`${k}: chain ${String(x)} ≠ expected ${String(y)}`);
  }
  return out;
}

export async function runBootstrap(o: BootstrapOpts): Promise<BootstrapResult> {
  const log = o.log ?? ((s: string) => console.log(s));
  const failures: string[] = [];
  const conn = new Connection(o.rpcUrl, "confirmed");
  const keys = new Keys(o.keysDir);
  const tag = o.cluster === "devnet" ? CLUSTER_TAG.devnet : CLUSTER_TAG.localnet;
  const explorer = (sig: string) => (o.cluster === "devnet" ? `https://solscan.io/tx/${sig}?cluster=devnet` : sig);
  const expectConfig = fumpadConfigParams("devnet");
  const pubkeys: Record<string, string> = {};

  const deployer = readKeypair(o.deployerPath);
  const offline = o.steps.every((s) => s === "keys");
  if (!offline && o.cluster === "devnet") {
    const g = await conn.getGenesisHash();
    if (g !== DEVNET_GENESIS) throw new Error("refusing: the RPC is not devnet (genesis hash mismatch)");
  }
  const bal = offline ? "" : ` (${sol(await conn.getBalance(deployer.publicKey))} SOL)`;
  log(`cluster ${o.cluster} (cluster_tag ${tag}) · mode ${o.mode} · deployer/admin ${deployer.publicKey.toBase58()}${bal}`);

  /** Build, then plan / simulate / send. `accounts`: addresses whose post-state the simulation returns. */
  /** `cu = 0`: no compute-budget instruction (only the bundled create_config + initialize_global simulation, which
   * would otherwise exceed 1,232 bytes; 200k default CU per instruction is enough for both). */
  const execute = async (name: string, ixs: TransactionInstruction[], signers: Signer[], accounts: PublicKey[] = [], cu = 400_000) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: deployer.publicKey, recentBlockhash: blockhash, instructions: [...(cu ? [ComputeBudgetProgram.setComputeUnitLimit({ units: cu })] : []), ...ixs] }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([deployer, ...signers]);
    const raw = tx.serialize();
    if (o.mode === "plan") {
      log(`  PLAN ${name}: ${ixs.length} ix, ${raw.length} bytes, signers ${[deployer, ...signers].map((s) => s.publicKey.toBase58().slice(0, 8)).join(", ")} (add --simulate or --yes)`);
      return { ok: true as const, accounts: [] as ({ owner: PublicKey; data: Uint8Array } | null)[] };
    }
    if (o.mode === "simulate") {
      const r = await conn.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: accounts.map((a) => a.toBase58()) } });
      const ok = !r.value.err;
      log(`  SIM  ${name}: ${ok ? "OK" : "FAIL"} · ${r.value.unitsConsumed ?? "?"} CU · ${raw.length} bytes${ok ? "" : ` · err ${JSON.stringify(r.value.err)}`}`);
      if (!ok) for (const l of (r.value.logs ?? []).slice(-12)) log(`       ${l}`);
      if (!ok) failures.push(`simulate ${name}`);
      const accs = (r.value.accounts ?? []).map((a) => (a ? { owner: new PublicKey(a.owner), data: Uint8Array.from(Buffer.from((a.data as unknown as [string, string])[0], "base64")) } : null));
      return { ok, accounts: accs };
    }
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
    await confirmSignature(conn, sig, lastValidBlockHeight, "confirmed", raw);
    log(`  SENT ${name}: ${explorer(sig)}`);
    return { ok: true as const, accounts: [] };
  };

  // ── keys ────────────────────────────────────────────────────────────────
  if (o.steps.includes("keys")) {
    log("\n▶ keys");
    const created = keys.ensure();
    log(`  dir ${o.keysDir} (700, files 600) · created: ${created.length ? created.join(", ") : "none (all present)"}`);
  }
  for (const n of KEY_NAMES) if (keys.has(n)) pubkeys[n] = keys.pub(n).toBase58();
  if (Object.keys(pubkeys).length) {
    pubkeys["admin (= deployer = guardian)"] = deployer.publicKey.toBase58();
    if (pubkeys.operator) pubkeys["jobs keeper (= operator)"] = pubkeys.operator;
    if (o.steps.includes("keys") || o.steps.includes("verify")) for (const [k, v] of Object.entries(pubkeys)) log(`  ${k.padEnd(30)} ${v}`);
    if (existsSync(o.keysDir)) {
      writeFileSync(join(o.keysDir, "pubkeys.json"), `${JSON.stringify({ cluster: o.cluster, program: FUMPAD_PROGRAM_ID.toBase58(), ...pubkeys }, null, 2)}\n`, { mode: 0o600 });
    }
  }

  const config = () => keys.pub("dbc-config");
  const firstConfig = () => keys.pub("dbc-config-first-coin");
  const expectFirst = firstCoinConfigParams("devnet");
  const policy = () => firstCoinPolicy(keys.pub("first-coin-wallet"));
  const readAcc = async (k: PublicKey) => {
    const a = await conn.getAccountInfo(k, "confirmed");
    return a ? { owner: a.owner, data: new Uint8Array(a.data) } : null;
  };
  const readConfig = () => readAcc(config());
  const createConfigIx = () => dbcCreateConfigIx({ config: config(), payer: deployer.publicKey, params: expectConfig });
  const createFirstIx = () => dbcCreateConfigIx({ config: firstConfig(), payer: deployer.publicKey, params: expectFirst });
  /** [standard, first-coin]: key name, address, expected params, checker, label. */
  const CONFIGS = () =>
    [
      { name: "dbc-config" as const, key: config(), expect: expectConfig, problems: configProblems, ix: createConfigIx, label: `standard: 99% → 1.25% over ${SNIPE_PERIODS} slots, ${expectConfig.migratedPoolFeeBps} bps DAMM v2` },
      { name: "dbc-config-first-coin" as const, key: firstConfig(), expect: expectFirst, problems: firstCoinConfigProblems, ix: createFirstIx, label: `first coin: 99% → 3% over ${FIRST_COIN_PERIODS} slots, ${FIRST_COIN_FEE_BPS} bps DAMM v2` },
    ] as const;

  // ── config ──────────────────────────────────────────────────────────────
  if (o.steps.includes("config")) {
    log(`\n▶ config (DBC create_config ×2, devnet curve: ${sol(expectConfig.migrationQuoteThreshold)} SOL raise, migration fee ${expectConfig.migrationFeePercentage}%; the standard + the first-coin config)`);
    log(`  fee_claimer ${feeClaimerPda().toBase58()} · leftover_receiver ${rewardPoolPda().toBase58()}`);
    for (const c of CONFIGS()) {
      log(`  ${c.name} ${c.key.toBase58()} (${c.label})`);
      const cur = await readAcc(c.key);
      if (cur) {
        const p = c.problems(cur.owner, cur.data, c.expect);
        log(p.length ? `  EXISTS but wrong: ${p.join("; ")}` : "  exists and matches (skip)");
        if (p.length) failures.push(`${c.name}: ${p.join("; ")}`);
        continue;
      }
      const r = await execute(`create_config (${c.name})`, [c.ix()], [keys.get(c.name)], [c.key]);
      if (o.mode === "simulate" && r.ok) {
        const p = c.problems(r.accounts[0]?.owner ?? null, r.accounts[0]?.data ?? null, c.expect);
        log(p.length ? `  simulated config FAILS §5.4: ${p.join("; ")}` : "  simulated config passes every §5.4 check (what initialize_global validates)");
        if (p.length) failures.push(`simulated ${c.name}: ${p.join("; ")}`);
      }
      if (o.mode === "send") {
        const after = await readAcc(c.key);
        const p = c.problems(after?.owner ?? null, after?.data ?? null, c.expect);
        if (p.length) failures.push(`${c.name} after create: ${p.join("; ")}`);
      }
    }
  }

  // ── init ────────────────────────────────────────────────────────────────
  const expectedKeepers = () => [keys.pub("attestor-1"), keys.pub("attestor-2"), keys.pub("attestor-3")];
  const expectedParams = () => bootstrapParams(keys.pub("launch-signer"));
  if (o.steps.includes("init")) {
    log("\n▶ init (initialize_global: bootstrap keepers attestor-1/2/3 with no 6 h freeze, operators [operator], configs [standard, first-coin + its wallet-split policy] with no timelock)");
    const params = expectedParams();
    const bad = paramsProblems(params);
    if (bad.length) throw new Error(`bootstrap params invalid: ${bad.join("; ")}`);
    log(`  params: min sell $${Number(params.minSellUsdCents) / 100}, hold ${params.minHoldSecs}s, challenge ${params.ticketChallengeSecs}s, oracle window ${params.oracleWindowSecs}s / ${params.oracleMinSamples} samples, launch_signer ${params.launchSigner.toBase58()}`);
    const prog = await programState(conn);
    const g = await conn.getAccountInfo(globalPda(), "confirmed");
    if (g) {
      log("  Global exists (skip; see --step verify)");
    } else if (!prog.deployed) {
      log("  program NOT deployed yet: deploy it first (DEPLOY-v07.md §2); nothing to simulate");
      if (o.mode !== "plan") failures.push("program not deployed");
    } else if (!prog.authority?.equals(deployer.publicKey)) {
      failures.push(`upgrade authority ${prog.authority?.toBase58() ?? "none"} ≠ deployer`);
      log(`  REFUSING: upgrade authority ${prog.authority?.toBase58() ?? "none"} is not the deployer (initialize_global would fail Unauthorized)`);
    } else {
      const pp = feePolicyProblems(policy());
      if (pp.length) throw new Error(`first-coin policy invalid: ${pp.join("; ")}`);
      log(`  first-coin policy: buyback ${policy().buybackShare} / wallet ${policy().walletShare} bps of volume, max_coins ${policy().maxCoins}, wallet ${policy().wallet.toBase58()}`);
      const initIx = initializeGlobalIx({
        payer: deployer.publicKey,
        admin: deployer.publicKey,
        platformTreasury: keys.pub("treasury"),
        clusterTag: tag,
        params,
        keepers: expectedKeepers(),
        operators: [keys.pub("operator")],
        configs: [config(), firstConfig()],
        policies: [STANDARD_FEE_POLICY, policy()],
      });
      const [cfg, cfgFirst] = [await readConfig(), await readAcc(firstConfig())];
      if (!cfg || !cfgFirst) {
        // Two create_config + initialize_global exceed 1,232 bytes: init can only be simulated once both configs exist.
        log("  config(s) missing: run --step config --yes first (initialize_global needs both configs on chain to simulate)");
        if (o.mode === "send") failures.push("config(s) missing: run --step config --yes first");
      } else {
        await execute("initialize_global", [initIx], [], [globalPda()]);
      }
    }
  }

  // ── operators (a Global initialized before operators existed, or one whose jobs key is still an attestor) ──
  if (o.steps.includes("operators")) {
    log("\n▶ operators (Global.operators = [operator]: the jobs keeper's own key, never an attestor)");
    const ga = await conn.getAccountInfo(globalPda(), "confirmed");
    if (!ga) {
      log("  no Global yet: run --step init (it sets the operators)");
    } else {
      const g = decodeGlobal(new Uint8Array(ga.data));
      const op = keys.pub("operator");
      const empty = g.operators.every((k) => k.equals(PublicKey.default));
      if (g.operators[0].equals(op) && g.operators.slice(1).every((k) => k.equals(PublicKey.default))) {
        log("  operators = [operator] (skip)");
      } else if (!g.admin.equals(deployer.publicKey)) {
        failures.push("operators: the admin is not the deployer (the admin multisig must propose set_operators)");
        log(`  REFUSING: admin ${g.admin.toBase58()} is not the deployer`);
      } else if (g.keepers.some((k) => k.equals(op))) {
        failures.push("operators: the operator key is one of the keepers");
        log("  REFUSING: the operator key is an attestor (generate a fresh operator key)");
      } else {
        // pre-operators Global: migrate_global first (fills operators[0] = keepers[0], the old jobs key), then move the
        // jobs role to the operator key in the SAME transaction, so no key is ever both on chain after it lands.
        const ixs = empty ? [migrateGlobalIx(deployer.publicKey), setOperatorsIx(deployer.publicKey, [op])] : [setOperatorsIx(deployer.publicKey, [op])];
        log(`  current operators ${g.operators.map((k) => k.toBase58()).join(", ")}${empty ? " (pre-operators layout: migrate_global first)" : ""}`);
        await execute(empty ? "migrate_global + set_operators([operator])" : "set_operators([operator])", ixs, [], [globalPda()]);
      }
    }
  }

  // ── policies (a Global from before the fee policies: grow it, then allow-list the first-coin config) ──────
  // Timelocked like every later config change (CONFIG_TIMELOCK_SECS): queue now, execute once the eta passed (rerun).
  const configChange = async (what: "add" | "remove") => {
    const ga = await conn.getAccountInfo(globalPda(), "confirmed");
    if (!ga) return log("  no Global yet: run --step init (it allow-lists both configs with their policies)");
    if (ga.data.length !== GLOBAL_LEN) return log(`  Global is ${ga.data.length} bytes (the pre-policy layout): run --step policies first (migrate_global)`);
    const g = decodeGlobal(new Uint8Array(ga.data));
    const slot = configSlot(g, firstConfig());
    const done = what === "add" ? !!slot : !slot;
    if (done) {
      log(what === "add" ? `  first-coin config allow-listed: policy kind ${slot!.policy.kind}, wallet ${slot!.policy.wallet.toBase58()}, coins ${slot!.coins}/${slot!.policy.maxCoins || "∞"} (skip)` : "  first-coin config is not on the allow-list (skip)");
      return;
    }
    if (!g.admin.equals(deployer.publicKey)) {
      failures.push(`${what} first-coin config: the admin is not the deployer (the admin multisig must queue it)`);
      return log(`  REFUSING: admin ${g.admin.toBase58()} is not the deployer`);
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    const pendingThis = g.pendingConfigEta !== 0n && g.pendingConfig.equals(firstConfig()) && (g.pendingConfigAdd === 1) === (what === "add");
    if (pendingThis && now >= g.pendingConfigEta) {
      await execute(`execute_config (${what} first-coin config)`, [executeConfigIx(deployer.publicKey, firstConfig())], [], [globalPda()]);
    } else if (pendingThis) {
      log(`  queued; executable after ${new Date(Number(g.pendingConfigEta) * 1000).toISOString()} (rerun this step then)`);
    } else if (g.pendingConfigEta !== 0n) {
      failures.push(`another config change is pending (${g.pendingConfig.toBase58()}): cancel or execute it first`);
    } else {
      const cfgFirst = await readAcc(firstConfig());
      if (what === "add" && !cfgFirst) return log("  first-coin config account missing: run --step config --yes first");
      await execute(`queue_config (${what} first-coin config${what === "add" ? " + wallet-split policy" : ""})`, [queueConfigIx(deployer.publicKey, firstConfig(), what === "add", what === "add" ? policy() : STANDARD_FEE_POLICY)], [], [globalPda()]);
    }
  };
  if (o.steps.includes("policies")) {
    log("\n▶ policies (Global 1,044 → 1,491 bytes via migrate_global; then queue → timelock → execute the first-coin config add)");
    const ga = await conn.getAccountInfo(globalPda(), "confirmed");
    if (!ga) log("  no Global yet: run --step init");
    else if (ga.data.length === GLOBAL_LEN_V1) {
      const g = decodeGlobal(new Uint8Array(ga.data)); // a 1,044-byte Global decodes with a zero tail
      if (!g.admin.equals(deployer.publicKey)) {
        failures.push("policies: the admin is not the deployer (the admin multisig must run migrate_global)");
        log(`  REFUSING: admin ${g.admin.toBase58()} is not the deployer`);
      } else {
        log(`  Global is ${GLOBAL_LEN_V1} bytes: migrate_global grows it (admin pays ${sol(BigInt(await conn.getMinimumBalanceForRentExemption(GLOBAL_LEN)) - BigInt(ga.lamports))} SOL rent)`);
        await execute("migrate_global (grow to the fee-policy layout)", [migrateGlobalIx(deployer.publicKey)], [], [globalPda()]);
      }
    } else if (ga.data.length !== GLOBAL_LEN) failures.push(`policies: unexpected Global length ${ga.data.length}`);
    if (o.mode === "send" || (await conn.getAccountInfo(globalPda(), "confirmed"))?.data.length === GLOBAL_LEN) await configChange("add");
    else log("  (the first-coin config add follows once migrate_global landed: rerun with --yes)");
  }

  // ── first-coin-done (right after the first coin launched: take its config off the allow-list) ───────────
  if (o.steps.includes("first-coin-done")) {
    log("\n▶ first-coin-done (queue → timelock → execute the first-coin config REMOVAL; the launched coin keeps its policy snapshot)");
    await configChange("remove");
  }

  // ── fund ────────────────────────────────────────────────────────────────
  if (o.steps.includes("fund")) {
    log(`\n▶ fund (from the deployer; budget ${sol(o.budgetLamports)} SOL committed incl. program rent)`);
    const prog = await programState(conn);
    const soLen = existsSync(SO_PATH) ? readFileSync(SO_PATH).length : 0;
    const programRent = prog.deployed ? prog.programDataLamports : BigInt(await conn.getMinimumBalanceForRentExemption(45 + soLen));
    const configRent = BigInt(await conn.getMinimumBalanceForRentExemption(1048));
    const globalRent = BigInt(await conn.getMinimumBalanceForRentExemption(GLOBAL_LEN)) + BigInt(await conn.getMinimumBalanceForRentExemption(1048));
    const rows: { name: KeyName; to: PublicKey; have: bigint; target: bigint; topUp: bigint }[] = [];
    for (const [name, target] of Object.entries(FUND_TARGETS) as [KeyName, bigint][]) {
      const to = keys.pub(name);
      const have = BigInt(await conn.getBalance(to, "confirmed"));
      rows.push({ name, to, have, target, topUp: have >= target ? 0n : target - have });
    }
    const topUps = rows.reduce((s, r) => s + r.topUp, 0n);
    const committed = programRent + configRent + globalRent + rows.reduce((s, r) => s + (r.have > r.target ? r.have : r.target), 0n);
    const deployerBal = BigInt(await conn.getBalance(deployer.publicKey, "confirmed"));
    log(`  ${"wallet".padEnd(14)} ${"pubkey".padEnd(44)} ${"has".padStart(9)} ${"target".padStart(9)} ${"top-up".padStart(9)}`);
    for (const r of rows) log(`  ${r.name.padEnd(14)} ${r.to.toBase58().padEnd(44)} ${sol(r.have).padStart(9)} ${sol(r.target).padStart(9)} ${sol(r.topUp).padStart(9)}`);
    log(`  top-ups ${sol(topUps)} SOL · program rent ${sol(programRent)}${prog.deployed ? "" : " (estimate: not deployed)"} + config ${sol(configRent)} + Global ${sol(globalRent)} · committed ${sol(committed)} SOL · deployer ${sol(deployerBal)} → ${sol(deployerBal - topUps)} SOL`);
    if (committed > o.budgetLamports) {
      failures.push(`over budget: ${sol(committed)} > ${sol(o.budgetLamports)} SOL`);
      log("  REFUSING: over budget (lower FUND_TARGETS or pass --budget-sol)");
    } else if (deployerBal < topUps + SOL / 5n) {
      failures.push("deployer balance too low for the top-ups (+0.2 SOL reserve)");
      log("  REFUSING: deployer balance too low (+0.2 SOL reserve)");
    } else if (topUps === 0n) {
      log("  every wallet at or above target (skip)");
    } else {
      const ixs = rows.filter((r) => r.topUp > 0n).map((r) => SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: r.to, lamports: r.topUp }));
      await execute(`fund ${ixs.length} wallets (${sol(topUps)} SOL)`, ixs, []);
    }
  }

  // ── verify ──────────────────────────────────────────────────────────────
  if (o.steps.includes("verify")) {
    log("\n▶ verify");
    const checks: [string, boolean, string?][] = [];
    const prog = await programState(conn);
    checks.push([`program ${FUMPAD_PROGRAM_ID.toBase58()} deployed (upgradeable)`, prog.deployed]);
    checks.push(["upgrade authority = deployer", !!prog.authority?.equals(deployer.publicKey), prog.authority?.toBase58()]);
    if (prog.deployed && existsSync(SO_PATH)) {
      const so = readFileSync(SO_PATH);
      const same = prog.elf !== null && prog.elf.length >= so.length && sha(prog.elf.subarray(0, so.length)) === sha(so) && prog.elf.subarray(so.length).every((b) => b === 0);
      checks.push(["deployed bytecode = local contracts/target/deploy/fumpad.so", same, `${so.length} B, sha256 ${sha(so).slice(0, 12)}…`]);
    }
    const [dbc, damm, mcfg, flash] = await Promise.all([conn.getAccountInfo(DBC_PROGRAM_ID), conn.getAccountInfo(DAMM_V2_PROGRAM_ID), conn.getAccountInfo(DAMM_V2_MIGRATION_CONFIG), conn.getBalance(DBC_POOL_AUTHORITY)]);
    checks.push(["Meteora DBC + DAMM v2 programs present", !!dbc?.executable && !!damm?.executable]);
    checks.push([`DAMM v2 migration config ${DAMM_V2_MIGRATION_CONFIG.toBase58().slice(0, 8)}… exists`, !!mcfg && mcfg.owner.equals(DAMM_V2_PROGRAM_ID)]);
    checks.push(["DBC pool authority holds flash rent (≥ 0.05 SOL)", BigInt(flash) >= SOL / 20n, `${sol(flash)} SOL`]);
    for (const c of keys.has("dbc-config-first-coin") ? CONFIGS() : CONFIGS().slice(0, 1)) {
      const a = await readAcc(c.key);
      const cp = c.problems(a?.owner ?? null, a?.data ?? null, c.expect);
      checks.push([`DBC config ${c.name} ${c.key.toBase58()} passes §5.4 + devnet curve (${c.label})`, cp.length === 0, cp.join("; ") || undefined]);
    }
    const ga = await conn.getAccountInfo(globalPda(), "confirmed");
    checks.push([`Global ${globalPda().toBase58()} initialized`, !!ga]);
    if (ga) {
      const g: GlobalAccount = decodeGlobal(new Uint8Array(ga.data));
      const now = BigInt(Math.floor(Date.now() / 1000));
      const ks = expectedKeepers();
      const same = (a: PublicKey[], b: PublicKey[]) => a.length === b.length && a.every((x, i) => x.equals(b[i]));
      checks.push([`cluster_tag ${tag}`, g.clusterTag === tag, String(g.clusterTag)]);
      checks.push(["admin = deployer, guardian = admin (devnet)", g.admin.equals(deployer.publicKey) && g.guardian.equals(g.admin)]);
      checks.push(["platform_treasury = treasury", g.platformTreasury.equals(keys.pub("treasury"))]);
      checks.push(["keepers = attestor-1/2/3", same(g.keepers, ks)]);
      checks.push(["operators = [operator] (the jobs key), disjoint from the attestors", g.operators[0].equals(keys.pub("operator")) && g.operators.slice(1).every((k) => k.equals(PublicKey.default)) && !ks.some((k) => g.operators.some((x) => x.equals(k)))]);
      checks.push(["bootstrap keepers: keeper_added_at = 0 (no 6 h freeze), all 3 active now", g.keeperAddedAt.every((t) => t === 0n) && activeKeepers(g, now).length === 3, g.keeperAddedAt.join(",")]);
      checks.push([`Global is the fee-policy layout (${GLOBAL_LEN} bytes)`, ga.data.length === GLOBAL_LEN, `${ga.data.length} bytes`]);
      const std = configSlot(g, config());
      checks.push(["configs[0] = the standard DBC config, standard fee policy", !!std && std.index === 0 && std.policy.kind === FEE_POLICY.standard && g.configs.length === MAX_CONFIGS]);
      const first = keys.has("dbc-config-first-coin") ? configSlot(g, firstConfig()) : null;
      const want = keys.has("first-coin-wallet") ? policy() : null;
      const samePolicy = !!first && !!want && first.policy.kind === want.kind && first.policy.buybackShare === want.buybackShare && first.policy.walletShare === want.walletShare && first.policy.maxCoins === want.maxCoins && first.policy.wallet.equals(want.wallet);
      checks.push([
        "first-coin config allow-listed with the wallet-split policy {100, 140, max 1, first-coin-wallet} (or already removed after the first coin: --step first-coin-done)",
        samePolicy || (!first && keys.has("dbc-config-first-coin")),
        first ? `coins ${first.coins}/${first.policy.maxCoins}` : "not allow-listed",
      ]);
      checks.push(["only those configs", g.configs.filter((c) => !c.equals(PublicKey.default)).length === (first ? 2 : 1)]);
      checks.push(["nothing pending (params / admin), not paused", g.pendingEta === 0n && g.pendingAdminEta === 0n && g.paused === 0]);
      if (g.pendingConfigEta !== 0n) checks.push([`config change pending (${g.pendingConfig.toBase58()} ${g.pendingConfigAdd ? "add" : "remove"}, eta ${new Date(Number(g.pendingConfigEta) * 1000).toISOString()}): rerun policies / first-coin-done after it`, true]);
      const pd = paramsDiff(g.params, expectedParams());
      checks.push(["params = devnet bootstrap params (launch_signer = launch-signer)", pd.length === 0, pd.join("; ") || undefined]);
    }
    for (const [name, target] of Object.entries(FUND_TARGETS) as [KeyName, bigint][]) {
      if (!keys.has(name)) continue;
      const have = BigInt(await conn.getBalance(keys.pub(name), "confirmed"));
      checks.push([`${name} funded ≥ ${sol(target)} SOL`, have >= target, `${sol(have)} SOL`]);
    }
    for (const [what, ok, detail] of checks) {
      log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  (${detail})` : ""}`);
      if (!ok) failures.push(what);
    }
    log(`  PDAs: global ${globalPda().toBase58()} · fee_claimer ${feeClaimerPda().toBase58()} · reward_pool ${rewardPoolPda().toBase58()}`);
  }

  log(failures.length ? `\n✗ ${failures.length} problem(s):\n  - ${failures.join("\n  - ")}` : "\n✓ done");
  return { ok: failures.length === 0, failures, pubkeys };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** fumpad program + ProgramData (upgradeable loader: tag u32 = 3, slot u64, Option<Pubkey> authority, then the ELF). */
async function programState(conn: Connection) {
  const p = await conn.getAccountInfo(FUMPAD_PROGRAM_ID, "confirmed");
  if (!p?.executable) return { deployed: false, authority: null as PublicKey | null, programDataLamports: 0n, elf: null as Uint8Array | null };
  const pd = await conn.getAccountInfo(programDataPda(), "confirmed");
  if (!pd) return { deployed: false, authority: null, programDataLamports: 0n, elf: null };
  const d = new Uint8Array(pd.data);
  const authority = d[12] === 1 ? new PublicKey(d.subarray(13, 45)) : null;
  return { deployed: true, authority, programDataLamports: BigInt(pd.lamports), elf: d.subarray(45) };
}

function parseArgs(argv: string[]) {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cluster = (get("--cluster") ?? "devnet") as Cluster;
  if (cluster !== "devnet" && cluster !== "local") throw new Error("--cluster devnet|local");
  const stepArg = get("--step") ?? "verify";
  const steps = stepArg === "all" ? ALL_STEPS : stepArg.split(",").map((s) => s.trim() as Step);
  for (const s of steps) if (!STEPS.includes(s)) throw new Error(`unknown step ${s} (keys|config|init|operators|policies|fund|verify|first-coin-done|all)`);
  const simulate = argv.includes("--simulate");
  const yes = argv.includes("--yes");
  if (simulate && yes) throw new Error("--simulate and --yes are exclusive");
  const local = join(SERVICES, ".local");
  return {
    cluster,
    steps,
    mode: (simulate ? "simulate" : yes ? "send" : "plan") as Mode,
    keysDir: get("--keys-dir") ?? (cluster === "devnet" ? join(homedir(), "fumpad-keys/devnet/v07") : join(local, "bootstrap-v07")),
    deployerPath: get("--deployer") ?? (cluster === "devnet" ? join(homedir(), ".config/solana/id.json") : join(local, "upgrade-authority.json")),
    budgetLamports: BigInt(Math.round(Number(get("--budget-sol") ?? 10) * LAMPORTS_PER_SOL)),
    rpcUrl: cluster === "devnet" ? readRpcUrl() : (process.env.RPC_URL ?? "http://127.0.0.1:8899"),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let secret = "";
  try {
    const a = parseArgs(process.argv.slice(2));
    secret = a.rpcUrl;
    const r = await runBootstrap(a);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error(secret ? msg.split(secret).join("<RPC_URL>") : msg);
    process.exit(1);
  }
}
