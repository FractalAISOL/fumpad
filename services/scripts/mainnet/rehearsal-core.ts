/**
 * The mainnet rehearsal (entry: rehearsal.ts, which set FUMPAD_PROGRAM_ID before this module loaded the SDK).
 *
 *   0. mainnet, READ-ONLY: dump DBC, DAMM v2, Squads v4, Token-2022, Pyth receiver (ProgramData payloads), the DAMM v2
 *      migration config, Squads ProgramConfig, Pyth SOL/USD, WSOL mint, DBC/DAMM pool authorities, rent + priority
 *      fees, and which feature gates are NOT active on mainnet → a local solana-test-validator with exactly those
 *      programs/accounts and mainnet's feature set (the Pyth account's publish time is moved to the far future so
 *      the frozen price stays fresh). fumpad is NOT in the genesis: it is deployed by the bootstrap.
 *   1. stand-in governance: admin (3-of-5 + ops key, 48 h time lock) and guardian (2-of-3 + ops key) Squads multisigs
 *      with generated voter keys, created through scripts/ops/multisig.ts on the forked Squads program
 *   2. bootstrap-mainnet (library, cluster local-fork, cluster_tag 0, mainnet params): plan → program deploy (solana
 *      CLI) → simulate config/init/fund (nothing lands) → send config, init, fund → propose-admin through the CLI
 *      itself with a typed confirmation (a wrong phrase sends nothing) → verify → a 2nd run sends nothing.
 *      CLI safety: --cluster mainnet against this RPC, --send without the spend flag, mainnet --send without a TTY.
 *   3. smoke through the real service stack (indexer, API, grinder, jobs keeper = the operator key, attestors 1–3,
 *      watcher) with the bootstrap's keys, on mainnet params: API launch (…fmbL mint, launch co-signer) → buys →
 *      600 s hold → sells ≥ $50 → tickets attested 2-of-3 → a 90 SOL PartialFill buy completes the 85 SOL curve →
 *      keeper migrates + graduates (observations + claim queue) → watcher re-derives every attestation.
 *      (Smoke runs inside the 48 h window: after the clock warp the chain is ~2 days ahead of the services' wall
 *      clock, which mainnet never is.)
 *   4. handover: accept_admin vault tx (bootstrap, ops key) → 3 approvals → upgrade-authority refused (handover not
 *      done) → warp past 48 h → accept-admin executes → upgrade-authority → verify (handover complete) → old admin
 *      refused, guardian multisig pause drill, a post-handover trade.
 *   Results: services/.local/mainnet-rehearsal/report.json; on success the dumped manifest is written to
 *   scripts/mainnet/tested-programs.json (what LAUNCH-DAY.md compares mainnet against).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";

import {
  type CoinRefs,
  coinPda,
  confirmSignature,
  DBC_PROGRAM_ID,
  decodeCoin,
  decodeTicket,
  decodeTokenAccount,
  FUMPAD_PROGRAM_ID,
  globalPda,
  inspectLaunchTx,
  isFumpadVanityMint,
  PAUSE_ALL,
  rewardVault,
  setPauseIx,
  SNIPE_PERIODS,
  ticketPda,
  WSOL_MINT,
} from "@fumpad/sdk";
import { signLaunchAuth } from "@fumpad/api";

import { airdrop, directDammBuy, directDbcBuy, directDbcSell, routedBuy, routedSell, tokenBalance } from "../local/actors.js";
import { keypair as localKeypair, readKeypairFile, runBinary, sleep, startValidator, type Validator, waitFor } from "../local/harness.js";
import { startStack, type Stack } from "../local/stack.js";
import { ADMIN_TIMELOCK_SECS, approveVaultTx, chainTime, createMultisig, executeVaultTx, loadMultisigConfig, type MultisigConfig, proposalState, proposeVaultTx, readGlobal, run, TxFailed, upgradeAuthority, vaultPdaOf } from "../ops/multisig.js";
import { type MainnetBootstrapResult, runMainnetBootstrap, type Step } from "./bootstrap-core.js";
import { describeManifest, inactiveOnMainnet, mainnetRpcUrl, type Manifest, ReadOnlyRpc, SERVICES, snapshotMainnet, TESTED_MANIFEST } from "./fork.js";
import { keyPath, type MainnetConfig } from "./keys.js";

const SOL = BigInt(LAMPORTS_PER_SOL);
const sol = (l: bigint | number) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);

export async function runRehearsal(o: { root: string; keysDir: string; so: string; soSha256: string; snapshotDir?: string; keep?: boolean }): Promise<boolean> {
  const t0 = Date.now();
  const rpcPort = Number(process.env.FUMPAD_RPC_PORT ?? 8899);
  const apiPort = Number(process.env.FUMPAD_API_PORT ?? 18080);
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  };
  const costs: Record<string, string> = {};
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };
  const K = o.keysDir;
  const kp = (n: string) => readKeypairFile(join(K, `${n}.json`));
  let v: Validator | undefined;
  let stack: Stack | undefined;
  let manifest: Manifest | undefined;

  try {
    // ── 0. mainnet snapshot (read-only) + fork ─────────────────────────────────
    console.log("\n══ 0. local fork of mainnet (read-only dump) ══");
    const snapDir = o.snapshotDir ?? join(o.root, "snapshot");
    const genesisOf = (m: Manifest) => [
      ...m.programs.flatMap((p) => ["--bpf-program", p.id, p.file]),
      ...m.accounts.flatMap((a) => ["--account", "-", a.name === "pyth_sol_usd" ? join(snapDir, "accounts/pyth_sol_usd_fresh.json") : a.file]),
    ];
    if (o.snapshotDir && existsSync(join(o.snapshotDir, "manifest.json"))) {
      manifest = JSON.parse(readFileSync(join(o.snapshotDir, "manifest.json"), "utf8")) as Manifest;
      console.log(`reusing the mainnet dump of ${manifest.takenAt} (slot ${manifest.slot})`);
    } else manifest = await snapshotMainnet({ outDir: snapDir });
    if (!manifest.features) {
      // feature ids this validator knows: start once with every feature, list them, then ask mainnet which are off
      const probe = await startValidator({ rpcPort, upgradeAuthority: localKeypair("upgrade-authority"), genesis: genesisOf(manifest) });
      const st = JSON.parse(runBinary("solana", ["feature", "status", "--url", probe.rpcUrl, "--output", "json"], {})) as { features: { id: string }[] };
      await probe.stop();
      const ids = st.features.map((f) => f.id);
      manifest = { ...manifest, features: { checked: ids.length, inactiveOnMainnet: await inactiveOnMainnet(new ReadOnlyRpc(mainnetRpcUrl()), ids) } };
      writeFileSync(join(snapDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    for (const l of describeManifest(manifest)) console.log(l);
    for (const p of manifest.programs.filter((x) => x.fixture)) check(`mainnet ${p.name} = the binary the test suites ran (${p.fixture})`, !!p.matchesFixture, `deployed slot ${p.lastDeployedSlot}`);
    v = await startValidator({ rpcPort, upgradeAuthority: localKeypair("upgrade-authority"), slotsPerEpoch: 4_000_000, genesis: genesisOf(manifest), extraArgs: manifest.features!.inactiveOnMainnet.flatMap((f) => ["--deactivate-feature", f]) });
    const conn = new Connection(v.rpcUrl, "confirmed");
    const fs = JSON.parse(runBinary("solana", ["feature", "status", "--url", v.rpcUrl, "--output", "json"], {})) as { features: { id: string; status: string }[] };
    const off = new Set(manifest.features!.inactiveOnMainnet);
    check("fork feature set = mainnet's (every gate inactive on mainnet is inactive here, all others active)", fs.features.every((f) => (f.status === "active") === !off.has(f.id)), `${fs.features.filter((f) => f.status === "active").length} active / ${off.size} off`);
    check("fumpad is not in the fork's genesis (the bootstrap deploys it)", (await conn.getAccountInfo(FUMPAD_PROGRAM_ID)) === null);
    const localRent0 = await conn.getMinimumBalanceForRentExemption(0);
    costs["rent (lamports per byte incl. 128 B overhead)"] = `mainnet ${manifest.rentLinear.perByteTwoYears}, this validator ${localRent0 / 128} (local amounts below are at the local rate)`;

    // ── 1. stand-in governance ────────────────────────────────────────────────
    console.log("\n══ 1. Squads multisigs (stand-in voters) ══");
    const deployer = kp("deployer");
    const ops = kp("ops");
    await airdrop(conn, deployer.publicKey, 40);
    await airdrop(conn, ops.publicKey, 1);
    const gen = (n: string) => {
      const k = Keypair.generate();
      writeFileSync(join(K, `${n}.json`), JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
      return k;
    };
    const voters = [1, 2, 3, 4, 5].map((i) => gen(`admin-voter-${i}`));
    const guardians = [1, 2, 3].map((i) => gen(`guardian-voter-${i}`));
    for (const k of [...voters, ...guardians]) await airdrop(conn, k.publicKey, 1);
    const msCfg = (label: string, threshold: number, timeLockSecs: number, members: Keypair[]): MultisigConfig => ({
      label,
      threshold,
      timeLockSecs,
      createKeyPath: join(K, `${label}-create-key.json`),
      members: [...members.map((k, i) => ({ pubkey: k.publicKey.toBase58(), permissions: "all" as const, label: `${label}-${i + 1}` })), { pubkey: ops.publicKey.toBase58(), permissions: ["initiate", "execute"] as ("initiate" | "execute")[], label: "ops" }],
    });
    writeFileSync(join(K, "admin-multisig.json"), JSON.stringify(msCfg("admin", 3, ADMIN_TIMELOCK_SECS, voters)));
    writeFileSync(join(K, "guardian-multisig.json"), JSON.stringify(msCfg("guardian", 2, 0, guardians)));
    const before = BigInt(await conn.getBalance(deployer.publicKey));
    const a = await createMultisig(conn, deployer, loadMultisigConfig(join(K, "admin-multisig.json")), "send", log);
    const g = await createMultisig(conn, deployer, loadMultisigConfig(join(K, "guardian-multisig.json")), "send", log);
    costs["Squads: create 2 multisigs (deployer outflow, incl. Squads creation fee)"] = `${sol(before - BigInt(await conn.getBalance(deployer.publicKey)))} SOL (local rent)`;
    const adminVault = vaultPdaOf(a.multisig);
    const guardianVault = vaultPdaOf(g.multisig);
    const treasury = kp("treasury").publicKey;
    const cfg: MainnetConfig = {
      deployerKeypair: "deployer.json",
      admin: { kind: "squads", multisig: a.multisig.toBase58(), address: adminVault.toBase58() },
      guardian: { kind: "squads", multisig: g.multisig.toBase58(), address: guardianVault.toBase58() },
      treasury: treasury.toBase58(),
      opsKeypair: "ops.json",
      computeUnitPriceMicroLamports: 20_000,
      budgetSol: 20, // local rent is ~37% above mainnet's: the mainnet budget doesn't fit here
    };
    const configPath = join(K, "bootstrap.json");
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });

    // ── 2. bootstrap ──────────────────────────────────────────────────────────
    console.log("\n══ 2. bootstrap-mainnet (cluster local-fork, cluster_tag 0, mainnet params) ══");
    const confirms: string[] = [];
    const boot = (mode: "plan" | "simulate" | "send", steps: Step[]) =>
      runMainnetBootstrap({ cluster: "local-fork", mode, steps, rpcUrl: v!.rpcUrl, configPath, soPath: o.so, log, confirm: async (step, _s, phrase) => (confirms.push(`${step}:${phrase}`), true) });
    const nPlan = lines.length;
    const plan = await boot("plan", ["keys", "program", "config", "init", "fund", "propose-admin", "verify"]);
    check("plan: nothing sent, verify lists what is missing", !lines.slice(nPlan).some((l) => l.includes("SENT")) && plan.next.length > 0 && (await conn.getAccountInfo(FUMPAD_PROGRAM_ID)) === null);
    const deployerBefore = BigInt(await conn.getBalance(deployer.publicKey));
    const dep = await boot("send", ["program"]);
    const prog = await upgradeAuthority(conn);
    check("program deployed by `solana program deploy` (typed-confirmed step), upgrade authority = deployer", dep.ok && !!prog.authority?.equals(deployer.publicKey) && confirms.some((c) => c.startsWith("program:")), `${prog.dataLen} B program data`);
    costs["program deploy (deployer net outflow: program data + program account rent, write-tx fees, buffer refunded)"] = `${sol(dep.spent.program ?? 0n)} SOL (local rent) for a ${readFileSync(o.so).length} B .so`;
    // a freshly deployed program is callable from a later slot; on mainnet the next command comes minutes later
    const s0 = await conn.getSlot("finalized");
    await waitFor("deploy finalized + a few slots", async () => ((await conn.getSlot("finalized")) > s0 + 4 ? true : null), 60_000, 400);
    const sim = await boot("simulate", ["config", "init", "fund"]);
    check("simulate: create_config (§5.4 in the simulated post-state), create_config+initialize_global bundled, funding all OK", sim.ok && lines.some((l) => l.includes("simulated config passes every §5.4 check")));
    check("simulate: nothing landed (no config, no Global)", (await conn.getAccountInfo(new PublicKey(sim.pubkeys["dbc-config"]))) === null && (await conn.getAccountInfo(globalPda())) === null);
    const sent = await boot("send", ["config", "init", "fund"]);
    check("send: config + initialize_global + fund, each behind its confirmation", sent.ok && ["config:", "init:", "fund:"].every((p) => confirms.some((c) => c.startsWith(p))));
    costs["config + initialize_global + fees (deployer)"] = `${sol((sent.spent.config ?? 0n) + (sent.spent.init ?? 0n))} SOL (local rent)`;
    costs["fund (attestor working balances)"] = `${sol(sent.spent.fund ?? 0n)} SOL`;

    // the CLI itself: refusals, then propose-admin with a typed phrase
    const rpcEnv = join(K, "local-rpc.env");
    writeFileSync(rpcEnv, `RPC_URL=${v.rpcUrl}\n`, { mode: 0o600 });
    const cli = (args: string[], input = "") => {
      try {
        return { ok: true, out: execFileSync("npx", ["tsx", "scripts/mainnet/bootstrap-mainnet.ts", "--config", configPath, "--so", o.so, ...args], { cwd: SERVICES, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FUMPAD_PROGRAM_ID: "", FUMPAD_CLUSTER: "" } }) };
      } catch (e) {
        const x = e as { stdout?: string; stderr?: string };
        return { ok: false, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
      }
    };
    const r1 = cli(["--cluster", "mainnet", "--step", "verify", "--rpc-env", rpcEnv]);
    check("CLI --cluster mainnet against a non-mainnet RPC → refused (genesis)", !r1.ok && r1.out.includes("genesis hash mismatch"));
    const r2 = cli(["--cluster", "mainnet", "--step", "config", "--send", "--rpc-env", rpcEnv]);
    check("CLI mainnet --send without --i-understand-this-spends-real-sol → refused", !r2.ok && r2.out.includes("--i-understand-this-spends-real-sol"));
    const r3 = cli(["--cluster", "mainnet", "--step", "config", "--send", "--i-understand-this-spends-real-sol", "--rpc-env", rpcEnv]);
    check("CLI mainnet --send without an interactive terminal → refused (typed confirmation needed)", !r3.ok && r3.out.includes("interactive terminal"));
    const r4 = cli(["--cluster", "mainnet", "--step", "config", "--send", "--i-understand-this-spends-real-sol", "--yes", "--rpc-env", rpcEnv]);
    check("CLI mainnet --yes → refused", !r4.ok && r4.out.includes("refusing --yes on mainnet"));
    const phrase = `propose-admin ${FUMPAD_PROGRAM_ID.toBase58().slice(0, 6)}`;
    const r5 = cli(["--cluster", "local-fork", "--step", "propose-admin", "--send", "--rpc-env", rpcEnv], "nope\n");
    check("CLI local-fork --send with a wrong typed phrase → nothing sent", !r5.ok && r5.out.includes("not confirmed") && (await readGlobal(conn)).pendingAdminEta === 0n);
    const r6 = cli(["--cluster", "local-fork", "--step", "propose-admin", "--send", "--rpc-env", rpcEnv], `${phrase}\n`);
    const g1 = await readGlobal(conn);
    check("CLI local-fork propose-admin with the typed phrase → propose_admin(admin vault, treasury, guardian vault), eta = now + 48 h", r6.ok && g1.pendingAdmin.equals(adminVault) && g1.pendingGuardian.equals(guardianVault) && g1.pendingTreasury.equals(treasury) && Math.abs(Number(g1.pendingAdminEta) - ((await chainTime(conn)) + ADMIN_TIMELOCK_SECS)) < 300);
    check("CLI output never contains the RPC URL", ![r1, r2, r3, r4, r5, r6].some((r) => r.out.includes(v!.rpcUrl)));
    const ver = await boot("plan", ["verify"]);
    check("verify (day 0): program, config §5.4 + vector bytes, Global (cluster_tag 0, mainnet params, keepers, configs), handover pending, keepers funded", ver.ok, ver.next.join(" · "));
    const n0 = lines.length;
    const again = await boot("send", ["keys", "program", "config", "init", "fund", "propose-admin"]);
    check("second send run of every day-0 step sends nothing (idempotent)", again.ok && !lines.slice(n0).some((l) => l.includes("SENT") || l.startsWith("  solana:")));
    costs["deployer total so far (deploy + config + init + fund + propose + multisigs)"] = `${sol(deployerBefore - BigInt(await conn.getBalance(deployer.publicKey)) + (before - deployerBefore))} SOL (local rent)`;

    // the indexer / attestors / watcher page through these histories
    const hist: string[] = [];
    for (const [n, addr] of [["DBC program", DBC_PROGRAM_ID], ["fumpad program", FUMPAD_PROGRAM_ID], ["DBC config", kp("dbc-config").publicKey], ["Global", globalPda()], ["WSOL mint", WSOL_MINT]] as const) {
      try {
        hist.push(`${n} ${(await conn.getSignaturesForAddress(addr, { limit: 1000 }, "confirmed")).length}`);
      } catch (e) {
        hist.push(`${n} ERROR ${String((e as Error).message).slice(0, 160)}`);
      }
    }
    check("getSignaturesForAddress serves every history the services page through", !hist.some((h) => h.includes("ERROR")), hist.join(" · "));
    if (process.env.FUMPAD_REHEARSAL_STOP === "bootstrap") throw new Error("stopped after the bootstrap (FUMPAD_REHEARSAL_STOP)");

    // ── 3. smoke through the service stack ────────────────────────────────────
    console.log("\n══ 3. smoke: launch → trades → 600 s hold → attested sells → 85 SOL graduation ══");
    const solUsd = Math.round(manifest.pyth.priceUsd * 100) / 100;
    stack = await startStack({
      rpcPort,
      apiPort,
      log,
      chain: { v, keeperKeyPaths: [keyPath(K, "attestor-1"), keyPath(K, "attestor-2"), keyPath(K, "attestor-3")], operatorKeyPath: keyPath(K, "operator"), launchKey: kp("launch-signer"), config: kp("dbc-config").publicKey, solUsd, cluster: "mainnet" },
    });
    const { api, get } = stack;
    const [creator, alice, bob, whale] = Array.from({ length: 4 }, () => Keypair.generate());
    for (const k of [creator, alice, bob]) await airdrop(conn, k.publicKey, 10);
    await airdrop(conn, whale.publicKey, 100);
    await waitFor("grinder: a …fmbL mint", async () => {
      const h = await get<{ vanityPool: { available: number; reserved: number } | null }>("/health");
      return h.vanityPool && h.vanityPool.available + h.vanityPool.reserved > 0;
    }, 600_000, 2_000);
    const prep = await fetch(`${api}/v1/launch/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creator: creator.publicKey.toBase58(), name: "Rehearsal", symbol: "REHR", uri: "https://fumpad.fun/m/rehr.json", initialBuyLamports: String(SOL / 2n), auth: signLaunchAuth(creator.secretKey, { creator: creator.publicKey.toBase58(), symbol: "REHR" }) }),
    });
    if (!prep.ok) throw new Error(`prepare → ${prep.status} ${await prep.text()}`);
    const prepared = (await prep.json()) as { mint: string; transaction: string; lastValidBlockHeight: number };
    const launchTx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
    const info = inspectLaunchTx(launchTx);
    launchTx.sign([creator]);
    const raw = launchTx.serialize();
    const launchSig = await conn.sendRawTransaction(raw, { maxRetries: 0 });
    await confirmSignature(conn, launchSig, prepared.lastValidBlockHeight, "confirmed", raw);
    const mint = new PublicKey(prepared.mint);
    const coinAcc = decodeCoin(new Uint8Array((await conn.getAccountInfo(coinPda(mint)))!.data));
    check("API launch: …fmbL mint, co-signed by the bootstrap's launch-signer, registered on the mainnet DBC config", isFumpadVanityMint(mint) && info.dbcConfig === kp("dbc-config").publicKey.toBase58() && coinAcc.status === "curve" && [...info.signed].includes(kp("launch-signer").publicKey.toBase58()), prepared.mint);
    const coin: CoinRefs = { mint, dbcConfig: kp("dbc-config").publicKey, dbcPool: coinAcc.dbcPool };
    const launchSlot = (await conn.getTransaction(launchSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))!.slot;
    await waitFor("launch window over", async () => ((await conn.getSlot("confirmed")) > launchSlot + SNIPE_PERIODS + 2 ? true : null), 30_000);
    await directDbcBuy(conn, alice, coin, SOL);
    await routedBuy(conn, bob, coin, "dbc", SOL);
    const tBuy = Date.now();
    log(`✓ alice (direct DBC) and bob (FUMPAD router) bought 1 SOL each (≈ $${solUsd.toFixed(0)}); mainnet min hold is 600 s: waiting`);
    await sleep(Math.max(0, 615_000 - (Date.now() - tBuy)));
    const aliceBal = await tokenBalance(conn, alice.publicKey, mint);
    const bobBal = await tokenBalance(conn, bob.publicKey, mint);
    const attBefore = await Promise.all([1, 2, 3].map((i) => conn.getBalance(kp(`attestor-${i}`).publicKey)));
    await directDbcSell(conn, alice, coin, aliceBal);
    await routedSell(conn, bob, coin, "dbc", bobBal);
    log("✓ alice and bob sold everything (> $50 each) after the 600 s hold");
    const tA = await waitFor("alice's ticket attested 2-of-3", async () => {
      const x = await conn.getAccountInfo(ticketPda(mint, alice.publicKey, 0n));
      return x ? decodeTicket(new Uint8Array(x.data)) : null;
    }, 300_000, 3_000);
    const tB = await waitFor("bob's ticket attested", async () => {
      const x = await conn.getAccountInfo(ticketPda(mint, bob.publicKey, 0n));
      return x ? decodeTicket(new Uint8Array(x.data)) : null;
    }, 300_000, 3_000);
    check("mainnet params: matured ≥ $50 sells → tickets attested by 2 of the 3 bootstrap keepers (outside + router)", tA.source === "outside" && tB.source === "router" && tA.tokens > 0n && tB.tokens > 0n);
    await sleep(15_000);
    const attAfter = await Promise.all([1, 2, 3].map((i) => conn.getBalance(kp(`attestor-${i}`).publicKey)));
    costs["attestation: keepers' outflow for 2 attested sells (Position + Ticket + Consumed rent + fees; rent refunded on close)"] = `${sol(attBefore.reduce((s, x) => s + x, 0) - attAfter.reduce((s, x) => s + x, 0))} SOL total (local rent)`;

    const k1Before = BigInt(await conn.getBalance(kp("operator").publicKey));
    await routedBuy(conn, whale, coin, "dbc", 90n * SOL, 1);
    log("✓ whale's 90 SOL PartialFill router buy completes the 85 SOL curve");
    const grad = await waitFor("keeper migrates + graduates", async () => {
      const c = decodeCoin(new Uint8Array((await conn.getAccountInfo(coinPda(mint)))!.data));
      return c.status === "graduated" ? c : null;
    }, 300_000, 3_000);
    const vault = decodeTokenAccount(new Uint8Array((await conn.getAccountInfo(rewardVault(mint)))!.data)).amount;
    check("graduated on the mainnet DBC config: DAMM v2 pool via the mainnet migration config, 8% leftover in the reward vault", !grad.dammPool.equals(PublicKey.default) && vault >= 80_000_000_000_000n && vault < 90_000_000_000_000n, `${vault} base units`);
    await waitFor("observations + claim queue initialized", async () => {
      const [obs, q] = await Promise.all([conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("observations"), mint.toBytes()], FUMPAD_PROGRAM_ID)[0]), conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("claim_queue"), mint.toBytes()], FUMPAD_PROGRAM_ID)[0])]);
      return obs && q && q.data.length >= 81_976 ? true : null;
    }, 180_000, 3_000);
    await sleep(10_000);
    const k1After = BigInt(await conn.getBalance(kp("operator").publicKey));
    costs["graduation: jobs keeper (operator key) net outflow for migrate + graduate + init_observations + 9× init_claim_queue (+ concurrent samples)"] = `${sol(k1Before - k1After)} SOL (local rent; graduate refunds the migrator and pre-funds both PDAs from the 0.85 SOL migration fee)`;
    check("graduation setup paid from the migration fee: the jobs keeper's net outflow < 0.05 SOL", k1Before - k1After < SOL / 20n, `${sol(k1Before - k1After)} SOL`);
    const feed = await waitFor("watcher verified both attestations", async () => {
      const f = await get<{ coins: { mint: string; verdicts: { verdict: string; kind: string }[] }[] }>(`/v1/verification?mint=${mint.toBase58()}`, `http://127.0.0.1:${stack!.ports.watcher}`);
      const c = f.coins[0];
      return c && c.verdicts.filter((x) => x.kind === "sell").length >= 2 ? c : null;
    }, 180_000, 3_000);
    check("watcher: every TicketAttested matches its independent re-derivation", feed.verdicts.every((x) => x.verdict === "match"), `${feed.verdicts.length} verdicts`);
    const detail = await waitFor("API shows the graduated coin", async () => {
      const c = await get<{ status: string; dammPool?: string }>(`/v1/coins/by-mint/${mint.toBase58()}`);
      return c.status === "graduated" ? c : null;
    }, 60_000, 2_000);
    check("indexer + API: graduated coin with its DAMM v2 pool", detail.dammPool === grad.dammPool.toBase58());
    stack.dumpLogs("mainnet-rehearsal-logs", () => {});
    await stack.stop();
    stack = undefined;

    // ── 4. handover ───────────────────────────────────────────────────────────
    console.log("\n══ 4. governance handover (accept_admin via the admin multisig, 48 h, upgrade authority) ══");
    const h1 = await boot("send", ["accept-admin"]);
    const st0 = await proposalState(conn, a.multisig, 1n);
    check("bootstrap accept-admin: ops key created the accept_admin vault tx (no approval), voters are next", h1.ok && st0.status === "Active" && st0.approvals.length === 0 && h1.next.some((n) => n.includes("approve")));
    for (const m of voters.slice(0, 3)) await approveVaultTx(conn, a.multisig, 1n, m, "send", log);
    const st1 = await proposalState(conn, a.multisig, 1n);
    check("3 voter approvals → Approved; Squads 48 h time lock running", st1.status === "Approved" && (st1.executableAt ?? 0) > (await chainTime(conn)) + ADMIN_TIMELOCK_SECS - 600);
    const h2 = await boot("send", ["accept-admin"]);
    check("accept-admin before 48 h: nothing executed, reports when it can", h2.ok && (await readGlobal(conn)).admin.equals(deployer.publicKey) && h2.next.some((n) => n.startsWith("execute")));
    const ua0 = await boot("send", ["upgrade-authority"]);
    check("upgrade-authority before the handover → refused, authority still the deployer", !ua0.ok && !!(await upgradeAuthority(conn)).authority?.equals(deployer.publicKey));
    const target = Math.max(Number(g1.pendingAdminEta), st1.executableAt ?? 0) + 120;
    for (let i = 0; i < 4 && (await chainTime(conn)) < target; i++) {
      const slot = await conn.getSlot();
      const tgt = slot + Math.ceil((target - (await chainTime(conn)) + 900) / 0.3);
      log(`… warping slot ${slot} → ${tgt} (48 h FUMPAD eta + Squads time lock)`);
      await v.warp(tgt);
    }
    check("chain clock past the 48 h eta and the Squads time lock", (await chainTime(conn)) >= target);
    const h3 = await boot("send", ["accept-admin"]);
    const g2 = await readGlobal(conn);
    check("accept-admin executed through the admin multisig: admin = admin vault, guardian = guardian vault, treasury set", h3.ok && g2.admin.equals(adminVault) && g2.guardian.equals(guardianVault) && g2.platformTreasury.equals(treasury) && g2.pendingAdminEta === 0n);
    const ua = await boot("send", ["upgrade-authority"]);
    check("upgrade authority → admin vault", ua.ok && !!(await upgradeAuthority(conn)).authority?.equals(adminVault));
    const fin: MainnetBootstrapResult = await boot("plan", ["verify"]);
    check("verify after the handover: every check green, handover complete", fin.ok && lines.some((l) => l.includes("governance handover complete")));
    try {
      await run(conn, deployer, [setPauseIx(deployer.publicKey, PAUSE_ALL)], [], "send", "set_pause by the old admin", () => {});
      check("old admin (deployer) can no longer pause", false);
    } catch (e) {
      check("old admin (deployer) can no longer pause (Unauthorized)", e instanceof TxFailed && e.mentions("Unauthorized"));
    }
    const p = await proposeVaultTx(conn, g.multisig, ops, { kind: "set-pause", bits: 0 }, "send", log);
    await approveVaultTx(conn, g.multisig, p, guardians[0], "send", log);
    await approveVaultTx(conn, g.multisig, p, guardians[1], "send", log);
    await executeVaultTx(conn, g.multisig, p, ops, "send", log);
    check("guardian multisig drill: set_pause(0) proposed by ops, 2 approvals, executed at once", (await readGlobal(conn)).paused === 0 && (await proposalState(conn, g.multisig, p)).status === "Executed");
    const eve = Keypair.generate();
    await airdrop(conn, eve.publicKey, 2);
    await directDammBuy(conn, eve, { ...coin, dammPool: grad.dammPool }, grad.dammPool, SOL / 10n);
    check("post-handover trade on the graduated coin's DAMM v2 pool", (await tokenBalance(conn, eve.publicKey, mint)) > 0n);
  } catch (e) {
    check(`rehearsal aborted: ${String((e as Error).message).slice(0, 500)}`, false);
    if (e instanceof TxFailed) console.log(e.logs.slice(-12).join("\n"));
    if (stack) console.log(`service logs: ${stack.dumpLogs("mainnet-rehearsal-logs")}`);
  } finally {
    await stack?.stop();
    if (o.keep && v) {
      console.log(`validator left running at ${v.rpcUrl} (Ctrl-C to stop)`);
      await new Promise<void>((r) => process.on("SIGINT", () => r()));
    }
    await v?.stop();
  }
  const ok = checks.every((c) => c.ok);
  const report = { ok, at: new Date().toISOString(), durationSec: Math.round((Date.now() - t0) / 1000), programId: FUMPAD_PROGRAM_ID.toBase58(), soSha256: o.soSha256, mainnetSlot: manifest?.slot, checks, costs };
  writeFileSync(join(o.root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (ok && manifest) {
    const strip = { ...manifest, programs: manifest.programs.map(({ file: _f, ...p }) => p), accounts: manifest.accounts.map(({ file: _f, ...x }) => x) };
    writeFileSync(TESTED_MANIFEST, `${JSON.stringify(strip, null, 2)}\n`);
  }
  console.log("\n── measured costs (local validator) ──");
  for (const [k, c] of Object.entries(costs)) console.log(`  ${k}: ${c}`);
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks in ${report.durationSec}s — ${ok ? "✓ mainnet rehearsal passed" : "✗ mainnet rehearsal FAILED"}${ok ? ` (tested manifest → ${TESTED_MANIFEST})` : ""}`);
  return ok;
}
