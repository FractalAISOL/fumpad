/**
 * FUMPAD MAINNET bootstrap CLI (services/LAUNCH-DAY.md; library: bootstrap-core.ts; rehearsal:
 * `npm run mainnet:rehearsal` runs this exact path against a local fork of mainnet).
 *
 *   B="npx tsx scripts/mainnet/bootstrap-mainnet.ts --config ~/fumpad-keys/mainnet/bootstrap.json"
 *   $B --cluster mainnet --step keys                       # generate the hot keys + program keypair (offline step)
 *   $B --cluster mainnet --step all                        # PLAN (default): reads the chain, builds, prints, sends nothing
 *   $B --cluster mainnet --step all --simulate             # simulateTransaction only
 *   $B --cluster mainnet --step program --send --i-understand-this-spends-real-sol   # + typed confirmation
 *   $B --cluster mainnet --step verify
 *
 * Steps: keys | program | config | init | fund | propose-admin | accept-admin | upgrade-authority | verify, a comma
 * list, `all` (= keys, program, config, init, fund, propose-admin, verify: day 0) or `handover` (= accept-admin,
 * upgrade-authority, verify: day 2+).
 * SENDING: `--send` only. On `--cluster mainnet` it also needs `--i-understand-this-spends-real-sol` AND an interactive
 * terminal: before each sending step the summary is printed and you must type the step's phrase (e.g.
 * `init 7xKX9a`); anything else aborts that step. `--cluster local-fork` (the rehearsal's local validator) accepts
 * `--yes` instead of typing. The RPC's genesis must match `--cluster` (mainnet ↔ mainnet-beta genesis; local-fork ↔
 * none of the public clusters), so a wrong env file can't hit the wrong chain.
 * RPC: `--rpc-env <file>` (RPC_URL=…; default ~/fumpad-keys/mainnet/rpc.env), never printed; local-fork default
 * http://127.0.0.1:8899. The program id is the pubkey of `<config dir>/fumpad-program-keypair.json`: this entry sets
 * `FUMPAD_PROGRAM_ID` before loading the SDK (refuses a conflicting value already in the environment).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { readEnvValue, redactText } from "../ops/common.js";
import { ensureHotKeys, expandHome, HOT_KEYS, keyPath, programIdOf } from "./keys.js";

const STEP_NAMES = ["keys", "program", "config", "init", "fund", "propose-admin", "accept-admin", "upgrade-authority", "verify"];
const SPEND_FLAG = "--i-understand-this-spends-real-sol";

export interface CliArgs {
  cluster: "mainnet" | "local-fork";
  steps: string[];
  mode: "plan" | "simulate" | "send";
  autoYes: boolean;
  configPath: string;
  rpcUrl: string;
  soPath?: string;
}

export function parseCli(argv: string[]): CliArgs {
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const known = new Set(["--cluster", "--step", "--config", "--rpc-env", "--so", "--simulate", "--send", "--yes", SPEND_FLAG]);
  for (const a of argv) if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown flag ${a}`);
  const cluster = get("--cluster");
  if (cluster !== "mainnet" && cluster !== "local-fork") throw new Error("--cluster mainnet|local-fork is required");
  const stepArg = get("--step") ?? "verify";
  const steps = stepArg === "all" ? ["keys", "program", "config", "init", "fund", "propose-admin", "verify"] : stepArg === "handover" ? ["accept-admin", "upgrade-authority", "verify"] : stepArg.split(",").map((s) => s.trim());
  for (const s of steps) if (!STEP_NAMES.includes(s)) throw new Error(`unknown step ${s} (${STEP_NAMES.join("|")}|all|handover)`);
  const simulate = argv.includes("--simulate");
  const send = argv.includes("--send");
  if (simulate && send) throw new Error("--simulate and --send are exclusive");
  if (argv.includes("--yes") && !send) throw new Error("--yes only makes sense with --send");
  if (send && cluster === "mainnet") {
    if (!argv.includes(SPEND_FLAG)) throw new Error(`refusing to send on mainnet without ${SPEND_FLAG}`);
    if (argv.includes("--yes")) throw new Error("refusing --yes on mainnet: every step needs a typed confirmation");
    if (!process.stdin.isTTY) throw new Error("refusing to send on mainnet without an interactive terminal (typed confirmation per step)");
  }
  const configPath = resolve(expandHome(get("--config") ?? join(homedir(), "fumpad-keys/mainnet/bootstrap.json")));
  let rpcUrl: string;
  const rpcEnv = get("--rpc-env");
  if (cluster === "mainnet") {
    const f = expandHome(rpcEnv ?? join(homedir(), "fumpad-keys/mainnet/rpc.env"));
    const v = existsSync(f) ? readEnvValue(f, "RPC_URL") : undefined;
    if (!v) throw new Error(`no RPC_URL in ${f}`);
    rpcUrl = v;
  } else rpcUrl = rpcEnv ? (readEnvValue(expandHome(rpcEnv), "RPC_URL") ?? "") : (process.env.RPC_URL ?? "http://127.0.0.1:8899");
  return { cluster, steps, mode: send ? "send" : simulate ? "simulate" : "plan", autoYes: argv.includes("--yes"), configPath, rpcUrl, soPath: get("--so") ? resolve(expandHome(get("--so")!)) : undefined };
}

/** Typed confirmation on the terminal. */
async function typedConfirm(step: string, summary: string[], phrase: string): Promise<boolean> {
  console.log(`\n┌─ ${step}: about to SEND ─────────────────────────────`);
  for (const l of summary) console.log(`│ ${l}`);
  console.log("└───────────────────────────────────────────────────");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`type "${phrase}" to send (anything else skips): `)).trim();
    return answer === phrase;
  } finally {
    rl.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let secret = "";
  try {
    const a = parseCli(process.argv.slice(2));
    secret = a.rpcUrl;
    const dir = dirname(a.configPath);
    if (a.steps.includes("keys")) {
      const created = ensureHotKeys(dir);
      console.log(`keys: ${dir} (700, files 600) · created: ${created.length ? created.join(", ") : "none (all present)"}`);
    }
    for (const n of HOT_KEYS) if (!existsSync(keyPath(dir, n))) throw new Error(`missing ${keyPath(dir, n)}: run --step keys first`);
    const id = programIdOf(dir)!;
    if (process.env.FUMPAD_PROGRAM_ID && process.env.FUMPAD_PROGRAM_ID !== id) throw new Error(`FUMPAD_PROGRAM_ID=${process.env.FUMPAD_PROGRAM_ID} in the environment ≠ the program keypair ${id}`);
    process.env.FUMPAD_PROGRAM_ID = id;
    const { runMainnetBootstrap } = await import("./bootstrap-core.js");
    const r = await runMainnetBootstrap({
      cluster: a.cluster,
      mode: a.mode,
      steps: a.steps as never,
      rpcUrl: a.rpcUrl,
      configPath: a.configPath,
      soPath: a.soPath,
      confirm: async (step, summary, phrase) => (a.autoYes && a.cluster === "local-fork" ? true : typedConfirm(step, summary, phrase)),
    });
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`✗ ${secret ? redactText(msg, secret) : msg}`);
    process.exit(1);
  }
}
