/**
 * `npm run multisig:rehearsal` — the mainnet governance handover (services/MULTISIG.md) end to end on a LOCAL
 * solana-test-validator: FUMPAD v0.7 (contracts/target/deploy/fumpad.so, upgradeable, authority = the
 * "deployer") + the Squads v4 program and its ProgramConfig dumped read-only from mainnet
 * (contracts/tests/fixtures/squads_v4_*), generated member keys, the real `initialize_global`.
 *
 *   A. create admin (3-of-5 voters + an initiate/execute ops key, 6 h Squads time lock) and guardian (2-of-3,
 *      no time lock) multisigs from JSON configs (2nd create = no-op) · propose_admin(admin vault, treasury,
 *      guardian vault) by the current admin · accept_admin vault tx approved by 3 · negatives: executing
 *      early (Squads time lock), 2 approvals aren't enough, guardian multisig has no power yet
 *   ── warp 1 (> 6 h) ──
 *   B. accept_admin executed THROUGH the admin multisig · old admin locked out · upgrade authority → admin
 *      vault (old authority locked out) · upgrade buffer written, handed to the vault, hash checked · admin vault
 *      txs: upgrade, extend (checked), queue_params, propose_admin(rotation) approved · guardian set_pause on/off (2-of-3,
 *      immediate) · negatives: 1 guardian approval, non-member approval, early upgrade
 *   ── warp 2 (> 6 h) ──
 *   C. upgrade executed by the admin vault · checked extend refused from a CPI, unchecked (permissionless) extend OK · queue_params → guardian cancel_params · propose_admin
 *      rotation → guardian cancel_admin · final status
 *
 * Clock: the validator is started with a 4M-slot epoch and restarted with `--warp-slot` (harness
 * `Validator.warp`), which moves Clock.unix_timestamp ≈ 0.3 s per warped slot. Keys: services/.local/multisig
 * (wiped first). Nothing here talks to devnet or mainnet.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getTransactionPda } from "@sqds/multisig";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";

import { CLUSTER_TAG, initializeGlobalIx, PAUSE_ALL, queueParamsIx, setPauseIx } from "@fumpad/sdk";

import { bootstrapParams } from "../devnet/bootstrap-v07.js";
import {
  ADMIN_TIMELOCK_SECS,
  approveVaultTx,
  bufferHash,
  chainTime,
  createMultisig,
  executeVaultTx,
  extendProgram,
  extendProgramIx,
  governanceStatus,
  loadMultisigConfig,
  MIN_EXTEND_BYTES,
  type Log,
  type MultisigConfig,
  proposalState,
  proposeAdminHandover,
  proposeVaultTx,
  readGlobal,
  run,
  setUpgradeAuthorityIx,
  SQUADS_PROGRAM_ID,
  transferUpgradeAuthority,
  TxFailed,
  upgradeAuthority,
  vaultPdaOf,
} from "../ops/multisig.js";
import { airdrop } from "./actors.js";
import { CONTRACTS, FIXTURES, keypair, keypairPath, LOCAL, runBinary, startValidator } from "./harness.js";

const rpcPort = Number(process.env.FUMPAD_RPC_PORT ?? 8899);
const DIR = join(LOCAL, "multisig");
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const deployer = keypair("upgrade-authority");
const v = await startValidator({
  rpcPort,
  upgradeAuthority: deployer,
  slotsPerEpoch: 4_000_000,
  extraArgs: ["--bpf-program", SQUADS_PROGRAM_ID.toBase58(), join(FIXTURES, "squads_v4_mainnet.so"), "--account", "-", join(FIXTURES, "squads_v4_program_config_mainnet.json")],
});
const conn = new Connection(v.rpcUrl, "confirmed");
const log: Log = (s) => console.log(s);
let failed = 0;
const check = (what: string, ok: boolean) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failed++;
};
/** Expect `fn` to fail with `needle` in the error/logs (simulation or chain). */
const refuses = async (what: string, needle: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
    check(`${what} → refused`, false);
  } catch (e) {
    const ok = e instanceof TxFailed ? e.mentions(needle) : String((e as Error).message).includes(needle);
    check(`${what} → refused (${needle})`, ok);
    if (!ok) console.log(`   got: ${(e as Error).message}\n${e instanceof TxFailed ? e.logs.slice(-6).join("\n") : ""}`);
  }
};
const hours = (s: number) => `${(s / 3600).toFixed(1)} h`;
const nextSlots = async (n: number) => {
  const s0 = await conn.getSlot();
  while ((await conn.getSlot()) < s0 + n) await new Promise((r) => setTimeout(r, 200));
};

async function warpPast(unix: number, label: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const now = await chainTime(conn);
    if (now >= unix) break;
    const slot = await conn.getSlot();
    const target = slot + Math.ceil((unix - now + 900) / 0.3);
    console.log(`… ${label}: warping slot ${slot} → ${target} (chain time is ${hours(unix - now)} short)`);
    await v.warp(target);
  }
  const now = await chainTime(conn);
  check(`${label}: chain clock now ${new Date(now * 1000).toISOString()} ≥ target ${new Date(unix * 1000).toISOString()}`, now >= unix);
}

try {
  // ── keys + configs ──────────────────────────────────────────────────────────
  const gen = (name: string) => keypair(`multisig/${name}`);
  const admins = [1, 2, 3, 4, 5].map((i) => gen(`admin-member-${i}`));
  const ops = gen("admin-ops");
  const guardians = [1, 2, 3].map((i) => gen(`guardian-member-${i}`));
  const outsider = gen("outsider");
  const treasury = gen("treasury");
  const rotation = gen("rotation-admin");
  const adminCfg: MultisigConfig = {
    label: "admin",
    threshold: 3,
    timeLockSecs: ADMIN_TIMELOCK_SECS,
    members: [...admins.map((k, i) => ({ pubkey: k.publicKey.toBase58(), permissions: "all" as const, label: `admin-${i + 1}` })), { pubkey: ops.publicKey.toBase58(), permissions: ["initiate", "execute"], label: "ops (hot, no vote)" }],
    createKeyPath: "admin-create-key.json",
  };
  const guardianCfg: MultisigConfig = {
    label: "guardian",
    threshold: 2,
    timeLockSecs: 0,
    members: [...guardians.map((k, i) => ({ pubkey: k.publicKey.toBase58(), permissions: "all" as const, label: `guardian-${i + 1}` })), { pubkey: ops.publicKey.toBase58(), permissions: ["initiate", "execute"], label: "ops (hot, no vote)" }],
    createKeyPath: "guardian-create-key.json",
  };
  writeFileSync(join(DIR, "admin.json"), JSON.stringify(adminCfg, null, 2));
  writeFileSync(join(DIR, "guardian.json"), JSON.stringify(guardianCfg, null, 2));
  const adminConfig = loadMultisigConfig(join(DIR, "admin.json"));
  const guardianConfig = loadMultisigConfig(join(DIR, "guardian.json"));

  await airdrop(conn, deployer.publicKey, 40);
  for (const k of [...admins, ops, ...guardians, outsider]) await airdrop(conn, k.publicKey, 1);

  // ── the starting point = mainnet after bootstrap: deployer is upgrade authority, admin and guardian ──
  await run(
    conn,
    deployer,
    [initializeGlobalIx({ payer: deployer.publicKey, admin: deployer.publicKey, platformTreasury: deployer.publicKey, clusterTag: CLUSTER_TAG.localnet, params: bootstrapParams(Keypair.generate().publicKey), keepers: [1, 2, 3].map(() => Keypair.generate().publicKey) })],
    [],
    "send",
    "initialize_global (admin = guardian = deployer)",
    log,
  );

  console.log("\n── A. multisigs + propose_admin ──");
  const a = await createMultisig(conn, deployer, adminConfig, "send", log);
  const g = await createMultisig(conn, deployer, guardianConfig, "send", log);
  const again = await createMultisig(conn, deployer, adminConfig, "send", log);
  check("create is idempotent (second run sends nothing)", !again.created && again.multisig.equals(a.multisig));
  const adminVault = vaultPdaOf(a.multisig);
  const guardianVault = vaultPdaOf(g.multisig);
  await proposeAdminHandover(conn, deployer, { adminVault, guardianVault, treasury: treasury.publicKey }, "simulate", log);
  await proposeAdminHandover(conn, deployer, { adminVault, guardianVault, treasury: treasury.publicKey }, "send", log);
  const g1 = await readGlobal(conn);
  const t1 = await chainTime(conn);
  check("Global.pending_admin = admin vault, pending_guardian = guardian vault, pending_treasury, eta = now + 6 h", g1.pendingAdmin.equals(adminVault) && g1.pendingGuardian.equals(guardianVault) && g1.pendingTreasury.equals(treasury.publicKey) && Math.abs(Number(g1.pendingAdminEta) - (t1 + ADMIN_TIMELOCK_SECS)) < 120);

  const accept = await proposeVaultTx(conn, a.multisig, ops, { kind: "accept-admin" }, "send", log);
  await approveVaultTx(conn, a.multisig, accept, admins[0], "send", log);
  await approveVaultTx(conn, a.multisig, accept, admins[1], "send", log);
  check("2 of 3 approvals: proposal still Active", (await proposalState(conn, a.multisig, accept)).status === "Active");
  await refuses("ops key (no Vote permission) approving", "Unauthorized", () => approveVaultTx(conn, a.multisig, accept, ops, "send", log));
  await approveVaultTx(conn, a.multisig, accept, admins[2], "send", log);
  const st = await proposalState(conn, a.multisig, accept);
  check(`3 of 3 approvals: Approved, executable in ${hours((st.executableAt ?? 0) - (await chainTime(conn)))} (Squads time lock)`, st.status === "Approved" && (st.executableAt ?? 0) > (await chainTime(conn)) + ADMIN_TIMELOCK_SECS - 300);
  await refuses("accept_admin executed before the Squads time lock", "TimeLockNotReleased", () => executeVaultTx(conn, a.multisig, accept, ops, "send", log));
  const early = await proposeVaultTx(conn, g.multisig, guardians[0], { kind: "set-pause", bits: PAUSE_ALL }, "send", log);
  await approveVaultTx(conn, g.multisig, early, guardians[1], "send", log);
  await refuses("guardian multisig set_pause before the handover", "Unauthorized", () => executeVaultTx(conn, g.multisig, early, guardians[0], "send", log));

  await warpPast(Math.max(Number(g1.pendingAdminEta), st.executableAt ?? 0) + 60, "warp 1 (6 h admin timelock + 6 h Squads time lock)");

  console.log("\n── B. accept_admin through the admin multisig; upgrade authority; guardian powers ──");
  await executeVaultTx(conn, a.multisig, accept, ops, "send", log);
  const g2 = await readGlobal(conn);
  check("Global.admin = admin vault, guardian = guardian vault, treasury set, nothing pending", g2.admin.equals(adminVault) && g2.guardian.equals(guardianVault) && g2.platformTreasury.equals(treasury.publicKey) && g2.pendingAdminEta === 0n);
  await refuses("old admin key set_pause", "Unauthorized", () => run(conn, deployer, [setPauseIx(deployer.publicKey, 1)], [], "send", "set_pause by old admin", log));

  await transferUpgradeAuthority(conn, deployer, a.multisig, "simulate", log);
  await transferUpgradeAuthority(conn, deployer, a.multisig, "send", log);
  const ua1 = await upgradeAuthority(conn);
  check("program upgrade authority = admin vault", !!ua1.authority?.equals(adminVault));
  await refuses("old upgrade authority taking it back", "IncorrectAuthority", () => run(conn, deployer, [setUpgradeAuthorityIx(deployer.publicKey, deployer.publicKey)], [], "send", "set authority back", log));

  const so = join(CONTRACTS, "target/deploy/fumpad.so");
  const solana = (...args: string[]) => runBinary("solana", [...args, "--url", v.rpcUrl, "--keypair", keypairPath("upgrade-authority"), "--commitment", "confirmed"], {});
  const buffer = new PublicKey(/Buffer:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(solana("program", "write-buffer", so))![1]);
  solana("program", "set-buffer-authority", buffer.toBase58(), "--new-buffer-authority", adminVault.toBase58());
  const bh = await bufferHash(conn, buffer, so);
  check("upgrade buffer: authority = admin vault, bytes match the local .so (what approvers check)", !!bh.authority?.equals(adminVault) && bh.matches === true);
  await run(conn, deployer, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: adminVault, lamports: LAMPORTS_PER_SOL / 10 })], [], "send", "fund admin vault 0.1 SOL (rent for the checked-extend attempt)", log);

  const upgrade = await proposeVaultTx(conn, a.multisig, ops, { kind: "upgrade", buffer, spill: deployer.publicKey }, "send", log);
  const extendChecked = await proposeVaultTx(conn, a.multisig, ops, { kind: "custom", name: "extend_program_checked", ixs: (vault) => [extendProgramIx({ bytes: MIN_EXTEND_BYTES, payer: vault, checkedAuthority: vault })] }, "send", log);
  const newParams = { ...g2.params, minSellUsdCents: g2.params.minSellUsdCents + 100n };
  const queue = await proposeVaultTx(conn, a.multisig, ops, { kind: "custom", name: "queue_params", ixs: (vault) => [queueParamsIx(vault, newParams)] }, "send", log);
  const rotate = await proposeVaultTx(conn, a.multisig, ops, { kind: "propose-admin", newAdmin: rotation.publicKey, treasury: treasury.publicKey, guardian: guardianVault }, "send", log);
  for (const idx of [upgrade, extendChecked, queue, rotate]) for (const m of admins.slice(2, 5)) await approveVaultTx(conn, a.multisig, idx, m, "send", log);
  await refuses("upgrade executed before the Squads time lock", "TimeLockNotReleased", () => executeVaultTx(conn, a.multisig, upgrade, ops, "send", log));

  const pause = await proposeVaultTx(conn, g.multisig, guardians[2], { kind: "set-pause", bits: PAUSE_ALL }, "send", log);
  await refuses("guardian set_pause with 1 of 2 approvals", "InvalidProposalStatus", () => executeVaultTx(conn, g.multisig, pause, guardians[2], "send", log));
  await refuses("outsider approving a guardian proposal", "NotAMember", () => approveVaultTx(conn, g.multisig, pause, outsider, "send", log));
  await approveVaultTx(conn, g.multisig, pause, guardians[0], "send", log);
  await executeVaultTx(conn, g.multisig, pause, guardians[0], "send", log);
  check(`guardian multisig set_pause(${PAUSE_ALL}) immediately (2-of-3, no time lock)`, (await readGlobal(conn)).paused === PAUSE_ALL);
  const unpause = await proposeVaultTx(conn, g.multisig, guardians[1], { kind: "set-pause", bits: 0 }, "send", log);
  await approveVaultTx(conn, g.multisig, unpause, guardians[2], "send", log);
  await executeVaultTx(conn, g.multisig, unpause, guardians[1], "send", log);
  check("guardian multisig set_pause(0)", (await readGlobal(conn)).paused === 0);

  const up = await proposalState(conn, a.multisig, upgrade);
  await warpPast((up.executableAt ?? 0) + 60, "warp 2 (6 h Squads time lock on the upgrade)");

  console.log("\n── C. upgrade through the admin vault; extend; guardian cancels ──");
  const before = await upgradeAuthority(conn);
  await executeVaultTx(conn, a.multisig, upgrade, ops, "send", log);
  const after = await upgradeAuthority(conn);
  check(`program upgraded by the admin vault (deployed slot ${before.slot} → ${after.slot}), authority still the vault`, after.slot > before.slot && !!after.authority?.equals(adminVault));
  check("buffer closed into the spill account", (await conn.getAccountInfo(buffer)) === null);
  await nextSlots(2); // an upgraded program is callable from the next slot
  await refuses("ExtendProgramChecked through the vault", "not supported by inner instructions", () => executeVaultTx(conn, a.multisig, extendChecked, ops, "send", log));
  await extendProgram(conn, outsider, MIN_EXTEND_BYTES, "send", log);
  check(`unchecked ExtendProgram by a non-authority payer (${after.dataLen} → ${(await upgradeAuthority(conn)).dataLen} bytes): how a multisig-owned program grows`, (await upgradeAuthority(conn)).dataLen === after.dataLen + MIN_EXTEND_BYTES);
  await nextSlots(2); // extending redeploys too

  await executeVaultTx(conn, a.multisig, queue, ops, "send", log);
  check("admin multisig queue_params → change pending", (await readGlobal(conn)).pendingEta !== 0n);
  const cp = await proposeVaultTx(conn, g.multisig, guardians[0], { kind: "cancel-params" }, "send", log);
  await approveVaultTx(conn, g.multisig, cp, guardians[1], "send", log);
  await executeVaultTx(conn, g.multisig, cp, guardians[1], "send", log);
  check("guardian multisig cancel_params → nothing pending", (await readGlobal(conn)).pendingEta === 0n);

  await executeVaultTx(conn, a.multisig, rotate, ops, "send", log);
  check("admin multisig propose_admin(rotation) → pending", (await readGlobal(conn)).pendingAdmin.equals(rotation.publicKey));
  const ca = await proposeVaultTx(conn, g.multisig, ops, { kind: "cancel-admin" }, "send", log);
  await approveVaultTx(conn, g.multisig, ca, guardians[0], "send", log);
  await approveVaultTx(conn, g.multisig, ca, guardians[2], "send", log);
  await executeVaultTx(conn, g.multisig, ca, ops, "send", log);
  const g3 = await readGlobal(conn);
  check("guardian multisig cancel_admin → no pending admin, admin unchanged", g3.pendingAdminEta === 0n && g3.pendingAdmin.equals(PublicKey.default) && g3.admin.equals(adminVault));

  console.log("\n── D. the CLI (what the runbook runs) ──");
  const rpcEnv = join(DIR, "rpc.env");
  writeFileSync(rpcEnv, `RPC_URL=${v.rpcUrl}\n`, { mode: 0o600 });
  const cli = (...args: string[]) => {
    try {
      return { ok: true, out: runBinary("npx", ["tsx", "scripts/ops/multisig.ts", ...args, "--rpc-env", rpcEnv], {}) };
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string };
      return { ok: false, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
    }
  };
  const wrong = cli("status", "--cluster", "mainnet");
  check("CLI refuses a --cluster that doesn't match the RPC's genesis", !wrong.ok && wrong.out.includes("refusing"));
  const status = cli("status", "--cluster", "local", "--admin-config", join(DIR, "admin.json"), "--guardian-config", join(DIR, "guardian.json"));
  check("CLI status: admin + upgrade authority = admin vault, guardian = guardian vault", status.ok && status.out.includes("upgrade authority " + adminVault.toBase58() + " (= admin multisig vault)") && status.out.includes(`guardian ${guardianVault.toBase58()} (= guardian multisig vault)`));
  const show = cli("show-tx", "--cluster", "local", "--config", join(DIR, "admin.json"), "--index", "1");
  check("CLI show-tx #1: accept_admin, Executed", show.ok && show.out.includes("accept_admin") && show.out.includes("Executed"));
  const sim = cli("propose", "--cluster", "local", "--config", join(DIR, "guardian.json"), "--member-key", keypairPath("multisig/guardian-member-1"), "--action", "set-pause", "--bits", "1");
  check("CLI propose without --yes only simulates (nothing created)", sim.ok && sim.out.includes("simulated OK") && (await proposalState(conn, g.multisig, 5n)).status === "Executed" && (await conn.getAccountInfo(getTransactionPda({ multisigPda: g.multisig, index: 6n })[0])) === null);
  const again2 = cli("create", "--cluster", "local", "--config", join(DIR, "guardian.json"), "--payer", keypairPath("upgrade-authority"), "--yes");
  check("CLI create on an existing multisig: matches, sends nothing", again2.ok && again2.out.includes("exists and matches"));
  check("CLI output never contains the RPC URL", ![wrong, status, show, sim, again2].some((r) => r.out.includes(v.rpcUrl)));

  console.log(`\n${(await governanceStatus(conn, { admin: a.multisig, guardian: g.multisig })).join("\n")}`);
} catch (e) {
  failed++;
  console.error(`✗ rehearsal aborted: ${(e as Error).message}${e instanceof TxFailed ? `\n${e.logs.slice(-12).join("\n")}` : ""}`);
} finally {
  await v.stop();
}
console.log(failed ? `\n✗ multisig rehearsal FAILED (${failed})` : "\n✓ multisig rehearsal passed");
process.exit(failed ? 1 : 0);
