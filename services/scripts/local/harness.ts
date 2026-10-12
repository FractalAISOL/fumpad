/**
 * Local stack harness: solana-test-validator with the built FUMPAD programs + the real
 * PumpSwap / pump-fees programs and their account dumps (contracts/tests/fixtures), a
 * fresh Pyth SOL/USD account, and a Postgres (DATABASE_URL, docker compose, or a
 * throwaway `initdb` cluster). Used by scripts/local-e2e.ts and the integration test.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Keypair } from "@solana/web3.js";

import {
  FUMPAD_PROGRAM_ID,
  LP_LOCKER_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  PYTH_SOL_USD_ACCOUNT,
} from "@fumpad/sdk";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVICES = resolve(here, "../..");
export const CONTRACTS = resolve(SERVICES, "../contracts");
export const LOCAL = join(SERVICES, ".local");
export const FIXTURES = join(CONTRACTS, "tests/fixtures");

const SOLANA_BIN = join(homedir(), ".local/share/solana/install/active_release/bin");
const PATH = `${SOLANA_BIN}:/opt/homebrew/bin:${process.env.PATH}`;

export function keypair(name: string): Keypair {
  mkdirSync(LOCAL, { recursive: true });
  const f = join(LOCAL, `${name}.json`);
  if (existsSync(f)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf8"))));
  const k = Keypair.generate();
  writeFileSync(f, JSON.stringify(Array.from(k.secretKey)));
  return k;
}
export const keypairPath = (name: string) => join(LOCAL, `${name}.json`);

/** Pyth PriceUpdateV2 at `usd` with publish_time far in the future (validator sees age 0). */
export function writePythFixture(usd: number): string {
  const v = JSON.parse(readFileSync(join(FIXTURES, "pyth_sol_usd_mainnet.json"), "utf8"));
  const data = Buffer.from(v.account.data[0], "base64");
  const m = 41;
  const price = BigInt(Math.round(usd * 1e8));
  data.writeBigInt64LE(price, m + 32);
  data.writeBigUInt64LE(price / 2000n, m + 40);
  data.writeInt32LE(-8, m + 48);
  const future = 4_102_444_800n; // 2100-01-01
  data.writeBigInt64LE(future, m + 52);
  data.writeBigInt64LE(future - 1n, m + 60);
  v.account.data[0] = data.toString("base64");
  v.account.owner = PYTH_RECEIVER_PROGRAM_ID.toBase58();
  v.account.rentEpoch = 0; // u64::MAX doesn't survive JSON.parse

  v.pubkey = PYTH_SOL_USD_ACCOUNT.toBase58();
  const out = join(LOCAL, "pyth_sol_usd_local.json");
  writeFileSync(out, JSON.stringify(v));
  return out;
}

export interface Validator {
  rpcUrl: string;
  wsUrl: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function startValidator(opts: { rpcPort?: number; upgradeAuthority: Keypair; solUsd?: number }): Promise<Validator> {
  const rpcPort = opts.rpcPort ?? 8899;
  const deploy = join(CONTRACTS, "target/deploy");
  for (const so of ["fumpad.so", "fumpad_lp_locker.so"]) {
    if (!existsSync(join(deploy, so))) throw new Error(`missing ${so}: run \`anchor build\` in contracts/`);
  }
  // The validator's admin socket lives in the ledger dir and unix socket paths are
  // limited to ~104 bytes, so keep the ledger on a short path.
  const ledger = process.env.FUMPAD_LEDGER_DIR ?? join(tmpdir(), `fumpad-ledger-${rpcPort}`);
  rmSync(ledger, { recursive: true, force: true });
  const probe = new Connection(`http://127.0.0.1:${rpcPort}`);
  if (await probe.getSlot().then(() => true, () => false)) {
    throw new Error(`something is already serving RPC on port ${rpcPort} (stop the other validator first)`);
  }
  const pyth = writePythFixture(opts.solUsd ?? 150);
  const authPath = join(LOCAL, "upgrade-authority.json");
  writeFileSync(authPath, JSON.stringify(Array.from(opts.upgradeAuthority.secretKey)));
  const args = [
    "--reset",
    "--quiet",
    "--ledger", ledger,
    "--rpc-port", String(rpcPort),
    "--faucet-port", String(rpcPort + 1001),
    // fumpad: upgradeable (initialize_global checks the upgrade authority)
    "--upgradeable-program", FUMPAD_PROGRAM_ID.toBase58(), join(deploy, "fumpad.so"), authPath,
    // locker: immutable, as on mainnet (D11)
    "--upgradeable-program", LP_LOCKER_PROGRAM_ID.toBase58(), join(deploy, "fumpad_lp_locker.so"), "none",
    "--bpf-program", PUMPSWAP_PROGRAM_ID.toBase58(), join(FIXTURES, "pump_amm.so"),
    "--bpf-program", PUMP_FEES_PROGRAM_ID.toBase58(), join(FIXTURES, "pump_fees.so"),
    "--account", "-", join(FIXTURES, "pump_amm_global_config.json"),
    "--account", "-", join(FIXTURES, "pump_fees_fee_config_amm.json"),
    "--account", "-", pyth,
  ];
  const proc = spawn("solana-test-validator", args, { env: { ...process.env, PATH }, stdio: ["ignore", "ignore", "pipe"], cwd: LOCAL });
  let stderr = "";
  proc.stderr?.on("data", (d) => (stderr += d.toString()));
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const conn = new Connection(rpcUrl, "confirmed");
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`validator exited: ${stderr}`);
    try {
      await conn.getLatestBlockhash();
      const slot = await conn.getSlot();
      if (slot > 2) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > 90_000) throw new Error(`validator did not start: ${stderr}`);
    await sleep(500);
  }
  return {
    rpcUrl,
    wsUrl: `ws://127.0.0.1:${rpcPort + 1}`,
    proc,
    async stop() {
      if (proc.exitCode === null) {
        proc.kill("SIGINT");
        await new Promise((r) => setTimeout(r, 1500));
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    },
  };
}

export interface Postgres {
  url: string;
  stop(): Promise<void>;
}

/**
 * DATABASE_URL if set; otherwise a throwaway cluster in .local/pg via initdb/pg_ctl
 * (no docker needed). `docker compose up -d postgres` + DATABASE_URL also works.
 */
export async function startPostgres(port = 54329): Promise<Postgres> {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, stop: async () => {} };
  const dir = join(LOCAL, `pg-${port}`);
  rmSync(dir, { recursive: true, force: true });
  const env = { ...process.env, PATH };
  execFileSync("initdb", ["-D", dir, "-U", "fumpad", "--auth=trust", "-E", "UTF8"], { env, stdio: "ignore" });
  execFileSync("pg_ctl", ["-D", dir, "-o", `-p ${port} -c unix_socket_directories= -c listen_addresses=127.0.0.1`, "-l", join(dir, "log.txt"), "-w", "start"], { env, stdio: "ignore" });
  execFileSync("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "fumpad", "fumpad"], { env, stdio: "ignore" });
  return {
    url: `postgres://fumpad@127.0.0.1:${port}/fumpad`,
    async stop() {
      try {
        execFileSync("pg_ctl", ["-D", dir, "-m", "fast", "-w", "stop"], { env, stdio: "ignore" });
      } catch {
        /* already stopped */
      }
    },
  };
}

export interface Service {
  name: string;
  proc: ChildProcess;
  logs: string[];
  stop(): Promise<void>;
}

/** Run a service entrypoint (TS source via tsx) as a child process with env. */
export function startService(name: string, entry: string, env: Record<string, string>): Service {
  const logs: string[] = [];
  const proc = spawn(join(SERVICES, "node_modules/.bin/tsx"), [join(SERVICES, entry)], {
    env: { ...process.env, PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: SERVICES,
  });
  const onData = (d: Buffer) => {
    for (const line of d.toString().split("\n")) if (line.trim()) logs.push(line);
    if (logs.length > 5000) logs.splice(0, logs.length - 5000);
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  return {
    name,
    proc,
    logs,
    async stop() {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        for (let i = 0; i < 30 && proc.exitCode === null; i++) await sleep(100);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    },
  };
}

/** `cargo build --release` the D18 vanity grinder (no-op when up to date); returns the binary path. */
export function buildGrinder(): string {
  const env = { ...process.env, PATH: `${join(homedir(), ".cargo/bin")}:${PATH}` };
  execFileSync("cargo", ["build", "--release", "--quiet", "--manifest-path", join(SERVICES, "grinder/Cargo.toml")], { env, stdio: ["ignore", "ignore", "inherit"] });
  return join(SERVICES, "grinder/target/release/fumpad-grinder");
}

/** Run a native binary as a child process (logs captured like `startService`). */
export function startBinary(name: string, bin: string, args: string[], env: Record<string, string>): Service {
  const logs: string[] = [];
  const proc = spawn(bin, args, { env: { ...process.env, PATH, ...env }, stdio: ["ignore", "pipe", "pipe"], cwd: SERVICES });
  const onData = (d: Buffer) => {
    for (const line of d.toString().split("\n")) if (line.trim()) logs.push(line);
    if (logs.length > 5000) logs.splice(0, logs.length - 5000);
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  return {
    name,
    proc,
    logs,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        for (let i = 0; i < 30 && proc.exitCode === null && proc.signalCode === null; i++) await sleep(100);
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
    },
  };
}

/** Run a binary to completion, returning its combined output (throws on non-zero exit). */
export function runBinary(bin: string, args: string[], env: Record<string, string>): string {
  return execFileSync(bin, args, { env: { ...process.env, PATH, ...env }, cwd: SERVICES, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 500): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    await sleep(everyMs);
  }
}
