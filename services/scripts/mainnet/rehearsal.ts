/**
 * `npm run mainnet:rehearsal` — the whole MAINNET launch path (bootstrap-mainnet.ts + MULTISIG.md handover + a smoke
 * scenario through the full service stack) against a LOCAL copy of mainnet. Nothing is sent to mainnet: mainnet is
 * only read (fork.ts, `get*` methods, spaced requests) to copy the programs/accounts and feature set.
 *
 * This entry stays free of @fumpad/sdk imports: it creates the rehearsal's keys (stand-ins for the real mainnet ones,
 * in services/.local/mainnet-rehearsal/keys, wiped each run), builds fumpad.so for the stand-in program id
 * (build-program.ts), sets FUMPAD_PROGRAM_ID, and only then loads rehearsal-core.ts (and with it the SDK).
 *
 * Options: --snapshot <dir>  reuse an earlier mainnet dump (fork.ts snapshot) instead of reading mainnet again
 *          --keep             leave the validator running at the end (Ctrl-C to stop)
 * Env: FUMPAD_RPC_PORT (8899), FUMPAD_API_PORT (18080) as for the other local stacks.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair, PublicKey } from "@solana/web3.js";

import { buildProgram } from "./build-program.js";
import { ensureHotKeys, keyPath, programIdOf } from "./keys.js";

// (not from fork.ts: that module loads the SDK, which must wait until FUMPAD_PROGRAM_ID is set)
const SERVICES = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const argv = process.argv.slice(2);
const get = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ROOT = join(SERVICES, ".local/mainnet-rehearsal");
const KEYS = join(ROOT, "keys");
rmSync(KEYS, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
ensureHotKeys(KEYS);
// stand-ins for what you provide on mainnet: the deployer (hot), the ops key (Squads initiate+execute), the treasury
for (const n of ["deployer", "ops", "treasury"]) writeFileSync(join(KEYS, `${n}.json`), JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
const programId = programIdOf(KEYS)!;
console.log(`rehearsal program id (stand-in for the mainnet keypair): ${programId}  [${keyPath(KEYS, "fumpad-program-keypair")}]`);
const built = buildProgram(new PublicKey(programId));
process.env.FUMPAD_PROGRAM_ID = programId;
const { runRehearsal } = await import("./rehearsal-core.js");
const ok = await runRehearsal({ root: ROOT, keysDir: KEYS, so: built.so, soSha256: built.sha256, snapshotDir: get("--snapshot") ? resolve(get("--snapshot")!) : undefined, keep: argv.includes("--keep") });
process.exit(ok ? 0 : 1);
