/**
 * `npm run bootstrap:rehearsal` — runs services/scripts/devnet/bootstrap-v07.ts end to end against a local
 * solana-test-validator (fumpad v0.7 deployed upgradeable, MAINNET DBC/DAMM v2 binaries, NO pre-seeded Global), i.e.
 * the real `initialize_global` bootstrap path the devnet deploy uses:
 *   1. keys · 2. --simulate of the configs (standard + first-coin) and funding (nothing lands; initialize_global needs
 *      both configs on chain to simulate: two create_config + init exceed 1,232 bytes)
 *   3. --yes of every step, verify checklist must pass · 4. a second --yes run must send nothing (idempotent) ·
 *   5. the devnet operators upgrade path: operators cleared (= a pre-operators Global) → `--step operators --yes`
 *      sends migrate_global + set_operators in one tx → verify passes again · 6. `--step first-coin-done --yes` queues
 *      the first-coin config's removal (the timelock isn't waited for here; LiteSVM tests cover execute).
 * Keys go to services/.local/bootstrap-v07 (wiped first); the deployer is the harness upgrade authority.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

import { Connection, PublicKey } from "@solana/web3.js";

import { DBC_POOL_AUTHORITY, decodeGlobal, globalPda, setOperatorsIx } from "@fumpad/sdk";

import { ALL_STEPS, type BootstrapOpts, runBootstrap } from "../devnet/bootstrap-v07.js";
import { airdrop, send } from "./actors.js";
import { keypair, keypairPath, LOCAL, readKeypairFile, startValidator } from "./harness.js";

const rpcPort = Number(process.env.FUMPAD_RPC_PORT ?? 8899);
const auth = keypair("upgrade-authority");
const v = await startValidator({ rpcPort, upgradeAuthority: auth });
let failed = false;
try {
  const conn = new Connection(v.rpcUrl, "confirmed");
  await airdrop(conn, auth.publicKey, 20);
  await airdrop(conn, DBC_POOL_AUTHORITY, 1);
  const keysDir = join(LOCAL, "bootstrap-v07");
  rmSync(keysDir, { recursive: true, force: true });
  const base: Omit<BootstrapOpts, "mode" | "steps"> = { cluster: "local", rpcUrl: v.rpcUrl, keysDir, deployerPath: keypairPath("upgrade-authority"), budgetLamports: 20n * 1_000_000_000n }; // local rent per byte is higher than devnet's: the 10 SOL devnet budget doesn't apply
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };
  const check = (what: string, ok: boolean) => {
    console.log(`${ok ? "✓" : "✗"} REHEARSAL ${what}`);
    if (!ok) failed = true;
  };

  await runBootstrap({ ...base, mode: "plan", steps: ["keys"], log });
  const sim = await runBootstrap({ ...base, mode: "simulate", steps: ["config", "init", "fund"], log });
  check("simulate: both configs and funding simulate OK (init waits for the configs on chain)", sim.ok);
  check("simulate: both configs pass §5.4 in the simulated post-state", lines.filter((l) => l.includes("simulated config passes every §5.4 check")).length === 2);
  check("simulate: nothing landed", (await conn.getAccountInfo(new PublicKey(sim.pubkeys["dbc-config"]))) === null && (await conn.getAccountInfo(new PublicKey(sim.pubkeys["dbc-config-first-coin"]))) === null);
  const sent = await runBootstrap({ ...base, mode: "send", steps: ALL_STEPS, log });
  check("send: every step + verify checklist (Global 1,491 B, standard + first-coin configs with their policies)", sent.ok);
  const before = lines.length;
  const again = await runBootstrap({ ...base, mode: "send", steps: ALL_STEPS, log });
  check("second run is a no-op (nothing sent) and still verifies", again.ok && !lines.slice(before).some((l) => l.includes("SENT")));
  // The devnet upgrade path: a Global from before operators existed reads all-default operators (the bytes were
  // `reserved`). Clearing them reproduces that state; the operators step must migrate + set in ONE transaction.
  await send(conn, auth, [setOperatorsIx(auth.publicKey, [])]);
  const g0 = decodeGlobal(new Uint8Array((await conn.getAccountInfo(globalPda()))!.data));
  check("operators cleared (pre-operators state)", g0.operators.every((k) => k.equals(PublicKey.default)));
  const n1 = lines.length;
  const op = await runBootstrap({ ...base, mode: "send", steps: ["operators", "verify"], log });
  const g1 = decodeGlobal(new Uint8Array((await conn.getAccountInfo(globalPda()))!.data));
  const opKey = readKeypairFile(join(keysDir, "operator.json")).publicKey;
  check("operators step: migrate_global + set_operators in one tx → operators = [operator], disjoint, verify green", op.ok && lines.slice(n1).some((l) => l.includes("SENT") && l.includes("migrate_global + set_operators")) && g1.operators[0].equals(opKey) && !g1.keepers.some((k) => k.equals(opKey)));
  // After the first coin: queue the first-coin config's removal (executes after the config timelock).
  const n2 = lines.length;
  const done = await runBootstrap({ ...base, mode: "send", steps: ["first-coin-done"], log });
  const g2 = decodeGlobal(new Uint8Array((await conn.getAccountInfo(globalPda()))!.data));
  check("first-coin-done: queue_config(first-coin config, remove) sent, pending", done.ok && lines.slice(n2).some((l) => l.includes("SENT") && l.includes("queue_config (remove")) && g2.pendingConfigEta > 0n && g2.pendingConfigAdd === 0 && g2.pendingConfig.equals(new PublicKey(sent.pubkeys["dbc-config-first-coin"])));
} finally {
  await v.stop();
}
console.log(failed ? "\n✗ bootstrap rehearsal FAILED" : "\n✓ bootstrap rehearsal passed");
process.exit(failed ? 1 : 0);
