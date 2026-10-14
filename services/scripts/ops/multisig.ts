/**
 * FUMPAD governance on Squads v4 multisigs (program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf, immutable on
 * mainnet; @sqds/multisig SDK). Runbook: services/MULTISIG.md. Rehearsal: `npm run multisig:rehearsal`.
 *
 *   create                 create a multisig from a JSON config (members + threshold + time lock); idempotent
 *   status                 Global (admin / guardian / treasury / pending), upgrade authority, both multisigs
 *   propose-admin          propose_admin(admin vault, treasury, guardian vault), signed by the CURRENT admin key
 *   set-upgrade-authority  program upgrade authority → the admin multisig vault (current authority signs)
 *   propose                vault transaction + proposal (actions below), by a member with Initiate
 *   approve | execute      by a member key file (rehearsal / hot ops key; mainnet voters approve in the Squads app)
 *   show-tx                one vault transaction: inner instructions, approvals, status, time lock left
 *   buffer-hash            sha256 of an upgrade buffer's program bytes vs a local .so (check before approving)
 *   extend-program         grow the program data (unchecked ExtendProgram: any payer, ≥ 10,240 bytes)
 *
 * Actions (`--action`): accept-admin · set-pause --bits <0..31> · cancel-params · cancel-admin ·
 *   propose-admin --new-admin <pk> --treasury <pk> --guardian <pk> · upgrade --buffer <pk> --spill <pk>
 *   (no "extend": the loader refuses it from a vault CPI; use the `extend-program` command, permissionless).
 *
 * Every write simulates first and only sends with `--yes`. `--cluster <mainnet|devnet|local>` must match the
 * RPC's genesis. RPC_URL comes from `--rpc-env <file>` (never printed; only a redacted host is shown).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as sq from "@sqds/multisig";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  type Signer,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";

import {
  acceptAdminIx,
  BPF_LOADER_UPGRADEABLE_ID,
  cancelAdminIx,
  cancelParamsIx,
  decodeGlobal,
  FUMPAD_CONFIG,
  FUMPAD_PROGRAM_ID,
  globalPda,
  PAUSE_ALL,
  programDataPda,
  proposeAdminIx,
  setPauseIx,
} from "@fumpad/sdk";

import { assertCluster, expandHome, parseArgs, readEnvValue, readKeypair, redactHost, redactText } from "./common.js";

export const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
if (!sq.PROGRAM_ID.equals(SQUADS_PROGRAM_ID)) throw new Error(`@sqds/multisig targets ${sq.PROGRAM_ID.toBase58()}, expected Squads v4 ${SQUADS_PROGRAM_ID.toBase58()}`);

/** FUMPAD's own admin timelock (propose_admin → accept_admin), contracts ADMIN_TIMELOCK_SECS (SPEC v0.7 C-TL: 6 h,
 * was 48 h). Also the recommended Squads time lock of the admin multisig (MULTISIG.md §2: it gates program upgrades). */
export const ADMIN_TIMELOCK_SECS = 6 * 3600;
const SQUADS_MAX_TIME_LOCK_SECS = 90 * 86_400; // Squads v4 MAX_TIME_LOCK (3 months)

// ── config ────────────────────────────────────────────────────────────────────
export type PermissionName = "initiate" | "vote" | "execute";
export interface MemberConfig {
  pubkey: string;
  /** "all" or a subset. Hardware-wallet voters: ["vote"] (or all); a hot ops key: ["initiate", "execute"] (never "vote"). */
  permissions: PermissionName[] | "all";
  label?: string;
}
export interface MultisigConfig {
  /** "admin" | "guardian" (free text, shown in logs). */
  label: string;
  threshold: number;
  /** Squads time lock: seconds between a proposal reaching the threshold and its execution. */
  timeLockSecs: number;
  members: MemberConfig[];
  /**
   * Keypair file of the one-time create key (the multisig PDA is derived from it). Generated (600) by
   * `create` if missing; only signs the creation, never holds funds or authority afterwards.
   */
  createKeyPath: string;
}

const PERM: Record<PermissionName, sq.types.Permission> = { initiate: sq.types.Permission.Initiate, vote: sq.types.Permission.Vote, execute: sq.types.Permission.Execute };
const permsOf = (m: MemberConfig) => (m.permissions === "all" ? sq.types.Permissions.all() : sq.types.Permissions.fromPermissions(m.permissions.map((p) => PERM[p])));
const hasPerm = (mask: number, p: sq.types.Permission) => (mask & p) === p;

export function loadMultisigConfig(path: string): MultisigConfig {
  const file = expandHome(path);
  const c = JSON.parse(readFileSync(file, "utf8")) as MultisigConfig;
  // createKeyPath is relative to the config file
  return { ...c, createKeyPath: c.createKeyPath.startsWith("~") ? expandHome(c.createKeyPath) : resolve(dirname(file), c.createKeyPath) };
}

/** Problems that make the config unusable (empty = fine) and warnings worth reading. */
export function checkMultisigConfig(c: MultisigConfig): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const keys = new Set<string>();
  for (const m of c.members) {
    try {
      new PublicKey(m.pubkey);
    } catch {
      problems.push(`member ${m.label ?? m.pubkey}: not a public key`);
    }
    if (keys.has(m.pubkey)) problems.push(`duplicate member ${m.pubkey}`);
    keys.add(m.pubkey);
    if (m.permissions !== "all" && (!Array.isArray(m.permissions) || m.permissions.length === 0 || m.permissions.some((p) => !(p in PERM)))) problems.push(`member ${m.label ?? m.pubkey}: permissions must be "all" or a non-empty subset of initiate/vote/execute`);
  }
  const has = (p: PermissionName) => c.members.filter((m) => m.permissions === "all" || (Array.isArray(m.permissions) && m.permissions.includes(p))).length;
  const voters = has("vote");
  if (!Number.isInteger(c.threshold) || c.threshold < 1) problems.push("threshold must be an integer ≥ 1");
  if (c.threshold > voters) problems.push(`threshold ${c.threshold} > ${voters} voting members`);
  if (has("initiate") === 0) problems.push("no member can initiate proposals");
  if (has("execute") === 0) problems.push("no member can execute");
  if (!Number.isInteger(c.timeLockSecs) || c.timeLockSecs < 0 || c.timeLockSecs > SQUADS_MAX_TIME_LOCK_SECS) problems.push(`timeLockSecs must be 0..${SQUADS_MAX_TIME_LOCK_SECS}`);
  if (c.members.length > 65_535) problems.push("too many members");
  if (c.threshold === 1 && voters > 1) warnings.push("threshold 1: any single voter controls this multisig");
  if (voters - c.threshold < 1) warnings.push(`no spare voter: losing one of ${voters} keys locks the multisig (recommend threshold ≤ voters − 1)`);
  if (/admin/i.test(c.label) && c.timeLockSecs < ADMIN_TIMELOCK_SECS) warnings.push(`admin time lock ${c.timeLockSecs}s < 6h: program upgrades through this multisig would be faster than users can react`);
  if (/guardian/i.test(c.label) && c.timeLockSecs > 0) warnings.push("guardian time lock > 0 delays emergency pauses");
  return { problems, warnings };
}

/** The create key (generated, mode 600, if the file doesn't exist yet). */
export function ensureCreateKey(path: string): Keypair {
  if (existsSync(path)) return readKeypair(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const k = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return k;
}

export const multisigPdaOf = (createKey: PublicKey) => sq.getMultisigPda({ createKey })[0];
export const vaultPdaOf = (multisigPda: PublicKey, index = 0) => sq.getVaultPda({ multisigPda, index })[0];
export function multisigOfConfig(c: MultisigConfig): { multisig: PublicKey; vault: PublicKey } {
  if (!existsSync(c.createKeyPath)) throw new Error(`${c.label}: create key ${c.createKeyPath} missing (run create first)`);
  const multisig = multisigPdaOf(readKeypair(c.createKeyPath).publicKey);
  return { multisig, vault: vaultPdaOf(multisig) };
}

// ── sending ───────────────────────────────────────────────────────────────────
export type Mode = "simulate" | "send";
export type Log = (s: string) => void;

export class TxFailed extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
  }
  /** True when the program logs or message mention `needle` (e.g. "TimeLockNotReleased", "Unauthorized"). */
  mentions(needle: string) {
    return this.message.includes(needle) || this.logs.some((l) => l.includes(needle));
  }
}

/** Simulate, then (mode send) send + confirm. Throws TxFailed with the program logs. Returns the signature or "simulated". */
export async function run(conn: Connection, payer: Signer, ixs: TransactionInstruction[], signers: Signer[], mode: Mode, what: string, log: Log, cu = 400_000): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  const uniq = [payer, ...signers].filter((s, i, a) => a.findIndex((x) => x.publicKey.equals(s.publicKey)) === i);
  tx.sign(...uniq);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) throw new TxFailed(`${what}: simulation failed: ${JSON.stringify(sim.value.err)}`, sim.value.logs ?? []);
  if (mode === "simulate") {
    log(`  simulated OK: ${what} (${sim.value.unitsConsumed ?? "?"} CU)`);
    return "simulated";
  }
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) {
      const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      throw new TxFailed(`${what}: failed on chain: ${JSON.stringify(res.value.err)}`, t?.meta?.logMessages ?? []);
    }
    log(`  SENT ${what}: ${sig}`);
    return sig;
  } catch (e) {
    if (e instanceof TxFailed) throw e;
    if (e instanceof SendTransactionError) throw new TxFailed(`${what}: ${e.message}`, (await e.getLogs(conn).catch(() => [])) ?? []);
    throw e;
  }
}

// ── chain reads ───────────────────────────────────────────────────────────────
export async function chainTime(conn: Connection): Promise<number> {
  const a = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (!a) throw new Error("no clock sysvar");
  return Number(a.data.readBigInt64LE(32));
}

export async function readGlobal(conn: Connection) {
  const a = await conn.getAccountInfo(globalPda(), "confirmed");
  if (!a) throw new Error(`no FUMPAD Global at ${globalPda().toBase58()} (program ${FUMPAD_PROGRAM_ID.toBase58()})`);
  const g = decodeGlobal(a.data);
  // an explicit FUMPAD_CLUSTER must be the Global's cluster_tag (as the services check at start)
  if (FUMPAD_CONFIG.clusterSource === "env" && g.clusterTag !== FUMPAD_CONFIG.clusterTag) throw new Error(`Global.cluster_tag ${g.clusterTag} ≠ FUMPAD_CLUSTER=${FUMPAD_CONFIG.cluster} (${FUMPAD_CONFIG.clusterTag})`);
  return g;
}

/** ProgramData: [u32 tag=3][u64 slot][u8 has_authority][32 authority]. */
export async function upgradeAuthority(conn: Connection, program = FUMPAD_PROGRAM_ID): Promise<{ authority: PublicKey | null; slot: bigint; dataLen: number }> {
  const pd = program.equals(FUMPAD_PROGRAM_ID) ? programDataPda() : PublicKey.findProgramAddressSync([program.toBytes()], BPF_LOADER_UPGRADEABLE_ID)[0];
  const a = await conn.getAccountInfo(pd, "confirmed");
  if (!a) throw new Error(`no program data for ${program.toBase58()}`);
  return { authority: a.data[12] ? new PublicKey(a.data.subarray(13, 45)) : null, slot: a.data.readBigUInt64LE(4), dataLen: a.data.length - 45 };
}

export async function readMultisig(conn: Connection, multisig: PublicKey) {
  return sq.accounts.Multisig.fromAccountAddress(conn, multisig, "confirmed");
}

export function describeMultisig(label: string, multisig: PublicKey, m: sq.accounts.Multisig): string[] {
  const perms = (mask: number) => ["initiate", "vote", "execute"].filter((_, i) => mask & (1 << i)).join("+");
  const voters = m.members.filter((x) => hasPerm(x.permissions.mask, sq.types.Permission.Vote)).length;
  return [
    `${label} multisig ${multisig.toBase58()}  vault[0] ${vaultPdaOf(multisig).toBase58()}`,
    `  threshold ${m.threshold}-of-${voters} voters, time lock ${m.timeLock}s (${(m.timeLock / 3600).toFixed(1)} h), config authority ${m.configAuthority.equals(PublicKey.default) ? "none (autonomous: changes need a vote)" : m.configAuthority.toBase58()}, transactions ${m.transactionIndex.toString()}`,
    ...m.members.map((x) => `  member ${x.key.toBase58()}  ${perms(x.permissions.mask)}`),
  ];
}

// ── create ────────────────────────────────────────────────────────────────────
export async function createMultisig(conn: Connection, payer: Keypair, c: MultisigConfig, mode: Mode, log: Log): Promise<{ multisig: PublicKey; vault: PublicKey; created: boolean }> {
  const { problems, warnings } = checkMultisigConfig(c);
  for (const w of warnings) log(`  ! ${c.label}: ${w}`);
  if (problems.length) throw new Error(`${c.label} config: ${problems.join("; ")}`);
  const createKey = ensureCreateKey(c.createKeyPath);
  const multisig = multisigPdaOf(createKey.publicKey);
  const vault = vaultPdaOf(multisig);
  const existing = await conn.getAccountInfo(multisig, "confirmed");
  if (existing) {
    const m = await readMultisig(conn, multisig);
    const want = new Map(c.members.map((x) => [x.pubkey, permsOf(x).mask]));
    const same =
      m.threshold === c.threshold &&
      m.timeLock === c.timeLockSecs &&
      m.members.length === want.size &&
      m.members.every((x) => want.get(x.key.toBase58()) === x.permissions.mask) &&
      m.configAuthority.equals(PublicKey.default);
    if (!same) throw new Error(`${c.label}: multisig ${multisig.toBase58()} exists but differs from the config (members / permissions / threshold / time lock / config authority)`);
    log(`  ${c.label}: multisig exists and matches the config (nothing to send)`);
    return { multisig, vault, created: false };
  }
  const programConfig = await sq.accounts.ProgramConfig.fromAccountAddress(conn, sq.getProgramConfigPda({})[0], "confirmed");
  const ix = sq.instructions.multisigCreateV2({
    treasury: programConfig.treasury,
    creator: payer.publicKey,
    multisigPda: multisig,
    configAuthority: null, // autonomous: member/threshold/time-lock changes go through a vote (+ time lock)
    threshold: c.threshold,
    members: c.members.map((x) => ({ key: new PublicKey(x.pubkey), permissions: permsOf(x) })),
    timeLock: c.timeLockSecs,
    createKey: createKey.publicKey,
    rentCollector: null,
    memo: `fumpad ${c.label}`,
  });
  await run(conn, payer, [ix], [createKey], mode, `create ${c.label} multisig ${multisig.toBase58()}`, log);
  return { multisig, vault, created: mode === "send" };
}

// ── FUMPAD handover (current admin / current upgrade authority sign) ─────────
export async function proposeAdminHandover(conn: Connection, admin: Keypair, a: { adminVault: PublicKey; guardianVault: PublicKey; treasury: PublicKey }, mode: Mode, log: Log): Promise<void> {
  const g = await readGlobal(conn);
  if (!g.admin.equals(admin.publicKey)) throw new Error(`the key given is not Global.admin (${g.admin.toBase58()})`);
  if (g.pendingAdminEta !== 0n) {
    const same = g.pendingAdmin.equals(a.adminVault) && g.pendingGuardian.equals(a.guardianVault) && g.pendingTreasury.equals(a.treasury);
    if (same) return log(`  propose_admin already pending with these keys (eta ${new Date(Number(g.pendingAdminEta) * 1000).toISOString()})`);
    throw new Error(`another admin proposal is pending (admin ${g.pendingAdmin.toBase58()}): cancel_admin first`);
  }
  await run(conn, admin, [proposeAdminIx(admin.publicKey, a.adminVault, a.treasury, a.guardianVault)], [], mode, `propose_admin(new_admin ${a.adminVault.toBase58()}, treasury ${a.treasury.toBase58()}, guardian ${a.guardianVault.toBase58()})`, log);
}

/** BPF loader upgradeable SetAuthority (unchecked: a PDA can't co-sign). Accounts: programdata (w), current (s), new (r). */
export function setUpgradeAuthorityIx(current: PublicKey, next: PublicKey, program = FUMPAD_PROGRAM_ID): TransactionInstruction {
  const programData = PublicKey.findProgramAddressSync([program.toBytes()], BPF_LOADER_UPGRADEABLE_ID)[0];
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE_ID,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: current, isSigner: true, isWritable: false },
      { pubkey: next, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([4, 0, 0, 0]),
  });
}

export async function transferUpgradeAuthority(conn: Connection, current: Keypair, adminMultisig: PublicKey, mode: Mode, log: Log): Promise<void> {
  const vault = vaultPdaOf(adminMultisig);
  // The target must be a live Squads multisig's vault: a typo here would brick upgrades forever.
  const m = await readMultisig(conn, adminMultisig);
  if (m.threshold < 1) throw new Error("admin multisig looks invalid");
  const { authority } = await upgradeAuthority(conn);
  if (authority?.equals(vault)) return log(`  upgrade authority is already the admin vault ${vault.toBase58()}`);
  if (!authority?.equals(current.publicKey)) throw new Error(`current upgrade authority is ${authority?.toBase58() ?? "none (immutable)"}, not the key given`);
  await run(conn, current, [setUpgradeAuthorityIx(current.publicKey, vault)], [], mode, `set upgrade authority of ${FUMPAD_PROGRAM_ID.toBase58()} → admin vault ${vault.toBase58()}`, log);
}

// ── actions executed by a vault ───────────────────────────────────────────────
export function upgradeIx(a: { buffer: PublicKey; spill: PublicKey; authority: PublicKey; program?: PublicKey }): TransactionInstruction {
  const program = a.program ?? FUMPAD_PROGRAM_ID;
  const programData = PublicKey.findProgramAddressSync([program.toBytes()], BPF_LOADER_UPGRADEABLE_ID)[0];
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE_ID,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: true },
      { pubkey: a.buffer, isSigner: false, isWritable: true },
      { pubkey: a.spill, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: a.authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([3, 0, 0, 0]),
  });
}

/**
 * Growing the program data for a bigger .so. The loader refuses ExtendProgram(Checked) from a CPI ("not supported
 * by inner instructions", rehearsed), so a vault can't do it. The UNCHECKED ExtendProgram (loader ix 6) is
 * permissionless: any payer, no authority signature, ≥ 10,240 bytes per call (rehearsed). `checked` = loader
 * ix 9 (authority must sign; only usable while the authority is a plain key).
 */
export const MIN_EXTEND_BYTES = 10_240;
export function extendProgramIx(a: { bytes: number; payer: PublicKey; program?: PublicKey; checkedAuthority?: PublicKey }): TransactionInstruction {
  const program = a.program ?? FUMPAD_PROGRAM_ID;
  const programData = PublicKey.findProgramAddressSync([program.toBytes()], BPF_LOADER_UPGRADEABLE_ID)[0];
  const data = Buffer.alloc(8);
  data.writeUInt32LE(a.checkedAuthority ? 9 : 6, 0);
  data.writeUInt32LE(a.bytes, 4);
  return new TransactionInstruction({
    programId: BPF_LOADER_UPGRADEABLE_ID,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: true },
      ...(a.checkedAuthority ? [{ pubkey: a.checkedAuthority, isSigner: true, isWritable: false }] : []),
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: a.payer, isSigner: true, isWritable: true },
    ],
    data,
  });
}

export async function extendProgram(conn: Connection, payer: Keypair, bytes: number, mode: Mode, log: Log): Promise<void> {
  if (!Number.isInteger(bytes) || bytes < MIN_EXTEND_BYTES) throw new Error(`extend by at least ${MIN_EXTEND_BYTES} bytes`);
  const before = await upgradeAuthority(conn);
  await run(conn, payer, [extendProgramIx({ bytes, payer: payer.publicKey })], [], mode, `extend ${FUMPAD_PROGRAM_ID.toBase58()} program data ${before.dataLen} → ${before.dataLen + bytes} bytes (payer ${payer.publicKey.toBase58()})`, log);
}

export type Action =
  | { kind: "accept-admin" }
  | { kind: "set-pause"; bits: number }
  | { kind: "cancel-params" }
  | { kind: "cancel-admin" }
  | { kind: "propose-admin"; newAdmin: PublicKey; treasury: PublicKey; guardian: PublicKey }
  | { kind: "upgrade"; buffer: PublicKey; spill: PublicKey }
  | { kind: "custom"; name: string; ixs: (vault: PublicKey) => TransactionInstruction[] };

export function actionIxs(a: Action, vault: PublicKey): TransactionInstruction[] {
  switch (a.kind) {
    case "accept-admin":
      return [acceptAdminIx(vault)];
    case "set-pause":
      if (!Number.isInteger(a.bits) || a.bits < 0 || (a.bits & ~PAUSE_ALL) !== 0) throw new Error(`pause bits must be within ${PAUSE_ALL}`);
      return [setPauseIx(vault, a.bits)];
    case "cancel-params":
      return [cancelParamsIx(vault)];
    case "cancel-admin":
      return [cancelAdminIx(vault)];
    case "propose-admin":
      return [proposeAdminIx(vault, a.newAdmin, a.treasury, a.guardian)];
    case "upgrade":
      return [upgradeIx({ buffer: a.buffer, spill: a.spill, authority: vault })];
    case "custom":
      return a.ixs(vault);
  }
}
export const actionName = (a: Action) => (a.kind === "custom" ? a.name : a.kind === "set-pause" ? `set_pause(${a.bits})` : a.kind);

// ── vault transactions ────────────────────────────────────────────────────────
/** vault_transaction_create + proposal_create (+ proposal_approve when the creator can vote), one tx. Returns the index. */
export async function proposeVaultTx(conn: Connection, multisig: PublicKey, creator: Keypair, action: Action, mode: Mode, log: Log): Promise<bigint> {
  const m = await readMultisig(conn, multisig);
  const me = m.members.find((x) => x.key.equals(creator.publicKey));
  if (!me || !hasPerm(me.permissions.mask, sq.types.Permission.Initiate)) throw new Error(`${creator.publicKey.toBase58()} is not a member with Initiate permission`);
  const index = BigInt(m.transactionIndex.toString()) + 1n;
  const vault = vaultPdaOf(multisig);
  const message = new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions: actionIxs(action, vault) });
  const ixs = [
    sq.instructions.vaultTransactionCreate({ multisigPda: multisig, transactionIndex: index, creator: creator.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, memo: `fumpad ${actionName(action)}` }),
    sq.instructions.proposalCreate({ multisigPda: multisig, transactionIndex: index, creator: creator.publicKey }),
  ];
  if (hasPerm(me.permissions.mask, sq.types.Permission.Vote)) ixs.push(sq.instructions.proposalApprove({ multisigPda: multisig, transactionIndex: index, member: creator.publicKey }));
  await run(conn, creator, ixs, [], mode, `vault tx #${index} ${actionName(action)} on ${multisig.toBase58()}`, log);
  return index;
}

export async function approveVaultTx(conn: Connection, multisig: PublicKey, index: bigint, member: Keypair, mode: Mode, log: Log): Promise<void> {
  await run(conn, member, [sq.instructions.proposalApprove({ multisigPda: multisig, transactionIndex: index, member: member.publicKey })], [], mode, `approve #${index} by ${member.publicKey.toBase58().slice(0, 8)}…`, log);
}

export interface ProposalState {
  status: string;
  approvals: PublicKey[];
  threshold: number;
  /** unix time from which it can execute (Approved only) */
  executableAt?: number;
}
export async function proposalState(conn: Connection, multisig: PublicKey, index: bigint): Promise<ProposalState> {
  const m = await readMultisig(conn, multisig);
  const p = await sq.accounts.Proposal.fromAccountAddress(conn, sq.getProposalPda({ multisigPda: multisig, transactionIndex: index })[0], "confirmed");
  const st = p.status as { __kind: string; timestamp?: unknown };
  const executableAt = st.__kind === "Approved" ? Number(String(st.timestamp)) + m.timeLock : undefined;
  return { status: st.__kind, approvals: p.approved, threshold: m.threshold, executableAt };
}

export async function executeVaultTx(conn: Connection, multisig: PublicKey, index: bigint, member: Keypair, mode: Mode, log: Log): Promise<string> {
  const st = await proposalState(conn, multisig, index);
  const now = await chainTime(conn);
  if (st.status === "Approved" && st.executableAt !== undefined && now < st.executableAt) log(`  note: #${index} time lock releases in ${st.executableAt - now}s (${new Date(st.executableAt * 1000).toISOString()}); the program will refuse until then`);
  const { instruction, lookupTableAccounts } = await sq.instructions.vaultTransactionExecute({ connection: conn, multisigPda: multisig, transactionIndex: index, member: member.publicKey });
  if (lookupTableAccounts.length) throw new Error("vault transactions with lookup tables are not supported by this script");
  return run(conn, member, [instruction], [], mode, `execute #${index} on ${multisig.toBase58()}`, log, 1_000_000);
}

/** Inner instructions of a vault transaction, for reviewers. */
export async function describeVaultTx(conn: Connection, multisig: PublicKey, index: bigint): Promise<string[]> {
  const tx = await sq.accounts.VaultTransaction.fromAccountAddress(conn, sq.getTransactionPda({ multisigPda: multisig, index })[0], "confirmed");
  const keys = tx.message.accountKeys;
  const st = await proposalState(conn, multisig, index);
  const now = await chainTime(conn);
  const out = [`vault tx #${index} on ${multisig.toBase58()}: ${st.status}, ${st.approvals.length}/${st.threshold} approvals${st.executableAt ? `, executable ${st.executableAt <= now ? "now" : `in ${st.executableAt - now}s`}` : ""}`];
  for (const ix of tx.message.instructions) {
    const program = keys[ix.programIdIndex];
    const name = program.equals(FUMPAD_PROGRAM_ID) ? fumpadIxName(Buffer.from(ix.data)) : program.equals(BPF_LOADER_UPGRADEABLE_ID) ? `bpf-loader ix ${Buffer.from(ix.data).readUInt32LE(0)}` : "?";
    out.push(`  ${program.toBase58()} ${name}: ${Array.from(ix.accountIndexes, (i) => keys[i].toBase58()).join(", ")}`);
  }
  return out;
}

function fumpadIxName(data: Buffer): string {
  for (const name of ["accept_admin", "set_pause", "cancel_params", "cancel_admin", "propose_admin", "queue_params", "execute_params", "set_keepers"]) {
    const d = createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
    if (data.subarray(0, 8).equals(d)) return name;
  }
  return "fumpad ix";
}

/** sha256 of the buffer's program bytes (after the 37-byte header) vs a local .so; padding must be zero. */
export async function bufferHash(conn: Connection, buffer: PublicKey, soPath?: string): Promise<{ authority: PublicKey | null; sha256: string; matches?: boolean }> {
  const a = await conn.getAccountInfo(buffer, "confirmed");
  if (!a || !a.owner.equals(BPF_LOADER_UPGRADEABLE_ID) || a.data.readUInt32LE(0) !== 1) throw new Error(`${buffer.toBase58()} is not an upgradeable-loader buffer`);
  const authority = a.data[4] ? new PublicKey(a.data.subarray(5, 37)) : null;
  const body = a.data.subarray(37);
  if (!soPath) return { authority, sha256: createHash("sha256").update(body).digest("hex") };
  const so = readFileSync(expandHome(soPath));
  const padOk = body.subarray(so.length).every((b) => b === 0);
  const sha256 = createHash("sha256").update(body.subarray(0, so.length)).digest("hex");
  return { authority, sha256, matches: padOk && sha256 === createHash("sha256").update(so).digest("hex") };
}

// ── status ────────────────────────────────────────────────────────────────────
export async function governanceStatus(conn: Connection, ms: { admin?: PublicKey; guardian?: PublicKey }): Promise<string[]> {
  const g = await readGlobal(conn);
  const ua = await upgradeAuthority(conn);
  const now = await chainTime(conn);
  const tag = (k: PublicKey) => (ms.admin && k.equals(vaultPdaOf(ms.admin)) ? " (= admin multisig vault)" : ms.guardian && k.equals(vaultPdaOf(ms.guardian)) ? " (= guardian multisig vault)" : "");
  const out = [
    `program ${FUMPAD_PROGRAM_ID.toBase58()} upgrade authority ${ua.authority?.toBase58() ?? "none (immutable)"}${ua.authority ? tag(ua.authority) : ""}, last deployed slot ${ua.slot}`,
    `Global ${globalPda().toBase58()}: admin ${g.admin.toBase58()}${tag(g.admin)}`,
    `  guardian ${g.guardian.toBase58()}${tag(g.guardian)}  treasury ${g.platformTreasury.toBase58()}  paused ${g.paused}`,
    g.pendingAdminEta === 0n
      ? "  no admin proposal pending"
      : `  PENDING admin ${g.pendingAdmin.toBase58()}${tag(g.pendingAdmin)} guardian ${g.pendingGuardian.toBase58()}${tag(g.pendingGuardian)} treasury ${g.pendingTreasury.toBase58()}, eta ${new Date(Number(g.pendingAdminEta) * 1000).toISOString()} (${Number(g.pendingAdminEta) - now > 0 ? `in ${Number(g.pendingAdminEta) - now}s` : "elapsed: accept_admin can run"})`,
    g.pendingEta === 0n ? "  no params change pending" : `  PENDING params change, eta ${new Date(Number(g.pendingEta) * 1000).toISOString()}`,
  ];
  for (const [label, pda] of Object.entries(ms)) if (pda) out.push(...describeMultisig(label, pda, await readMultisig(conn, pda)));
  return out;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseAction(args: ReturnType<typeof parseArgs>): Action {
  const pk = (n: string) => new PublicKey(args.need(n));
  switch (args.need("action")) {
    case "accept-admin":
      return { kind: "accept-admin" };
    case "set-pause":
      return { kind: "set-pause", bits: Number(args.need("bits")) };
    case "cancel-params":
      return { kind: "cancel-params" };
    case "cancel-admin":
      return { kind: "cancel-admin" };
    case "propose-admin":
      return { kind: "propose-admin", newAdmin: pk("new-admin"), treasury: pk("treasury"), guardian: pk("guardian") };
    case "upgrade":
      return { kind: "upgrade", buffer: pk("buffer"), spill: pk("spill") };
    default:
      throw new Error("unknown --action (accept-admin | set-pause | cancel-params | cancel-admin | propose-admin | upgrade)");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log: Log = (s) => console.log(s);
  const mode: Mode = args.has("yes") ? "send" : "simulate";
  const rpcEnv = args.need("rpc-env");
  const rpcUrl = readEnvValue(rpcEnv, "RPC_URL");
  if (!rpcUrl) throw new Error(`no RPC_URL in ${rpcEnv}`);
  const conn = new Connection(rpcUrl, "confirmed");
  try {
    const cluster = await assertCluster(conn, args.get("cluster"));
    if (cluster === "mainnet" && FUMPAD_CONFIG.programIdSource === "env" && FUMPAD_CONFIG.cluster !== "mainnet") throw new Error("--cluster mainnet with FUMPAD_PROGRAM_ID set needs FUMPAD_CLUSTER=mainnet too (LAUNCH-DAY.md)");
    log(`cluster ${cluster} via ${redactHost(rpcUrl)} · ${mode === "send" ? "SENDING" : "simulate only (add --yes to send)"}`);
    log(`program ${FUMPAD_PROGRAM_ID.toBase58()} (${FUMPAD_CONFIG.programIdSource}) · FUMPAD_CLUSTER ${FUMPAD_CONFIG.cluster} (${FUMPAD_CONFIG.clusterSource})`);
    const msOf = (flag: string) => {
      const cfg = args.get(flag);
      return cfg ? multisigOfConfig(loadMultisigConfig(cfg)).multisig : undefined;
    };
    const target = () => (args.get("multisig") ? new PublicKey(args.need("multisig")) : msOf("config") ?? (() => { throw new Error("pass --config <multisig.json> or --multisig <pda>"); })());
    switch (args.cmd) {
      case "create": {
        const c = loadMultisigConfig(args.need("config"));
        const r = await createMultisig(conn, readKeypair(args.need("payer")), c, mode, log);
        log(`${c.label}: multisig ${r.multisig.toBase58()}  vault ${r.vault.toBase58()}`);
        if (mode === "send" || !r.created) log(describeMultisig(c.label, r.multisig, await readMultisig(conn, r.multisig)).join("\n"));
        break;
      }
      case "status":
        log((await governanceStatus(conn, { admin: msOf("admin-config"), guardian: msOf("guardian-config") })).join("\n"));
        break;
      case "propose-admin": {
        const admin = msOf("admin-config");
        const guardian = msOf("guardian-config");
        if (!admin || !guardian) throw new Error("pass --admin-config and --guardian-config");
        // --treasury defaults to the current Global.platform_treasury (unchanged by the handover)
        const treasury = args.get("treasury") ? new PublicKey(args.need("treasury")) : (await readGlobal(conn)).platformTreasury;
        log(`treasury after the handover: ${treasury.toBase58()}${args.get("treasury") ? "" : " (current, unchanged)"}`);
        await proposeAdminHandover(conn, readKeypair(args.need("admin-key")), { adminVault: vaultPdaOf(admin), guardianVault: vaultPdaOf(guardian), treasury }, mode, log);
        break;
      }
      case "set-upgrade-authority": {
        const admin = msOf("admin-config");
        if (!admin) throw new Error("pass --admin-config");
        await transferUpgradeAuthority(conn, readKeypair(args.need("authority-key")), admin, mode, log);
        break;
      }
      case "propose": {
        const idx = await proposeVaultTx(conn, target(), readKeypair(args.need("member-key")), parseAction(args), mode, log);
        log(`vault transaction index ${idx}${mode === "simulate" ? " (if sent now)" : ""}`);
        break;
      }
      case "approve":
        await approveVaultTx(conn, target(), BigInt(args.need("index")), readKeypair(args.need("member-key")), mode, log);
        break;
      case "execute":
        await executeVaultTx(conn, target(), BigInt(args.need("index")), readKeypair(args.need("member-key")), mode, log);
        break;
      case "show-tx":
        log((await describeVaultTx(conn, target(), BigInt(args.need("index")))).join("\n"));
        break;
      case "buffer-hash": {
        const r = await bufferHash(conn, new PublicKey(args.need("buffer")), args.get("so"));
        log(`buffer authority ${r.authority?.toBase58() ?? "none"} · sha256 ${r.sha256}${r.matches === undefined ? "" : r.matches ? " · MATCHES the local .so" : " · DOES NOT MATCH the local .so"}`);
        if (r.matches === false) process.exitCode = 1;
        break;
      }
      case "extend-program":
        await extendProgram(conn, readKeypair(args.need("payer")), Number(args.need("bytes")), mode, log);
        break;
      default:
        throw new Error("command: create | status | propose-admin | set-upgrade-authority | propose | approve | execute | show-tx | buffer-hash | extend-program");
    }
  } catch (e) {
    const logs = e instanceof TxFailed ? `\n${e.logs.slice(-12).join("\n")}` : "";
    console.error(redactText(`✗ ${(e as Error).message}${logs}`, rpcUrl));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
