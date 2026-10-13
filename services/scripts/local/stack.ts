/**
 * The whole v0.7 off-chain stack on solana-test-validator, as one call (used by the e2e scenario and by
 * `npm run local:app`, the long-running stack the app runs against):
 *
 *   Postgres → indexer (fumpad + Meteora sources) → API (REST + WS + launch prepare)
 *   grinder (…fmbL mints) · keeper jobs · 3 attestors (separate keys, shared signature board) · watcher
 *
 * on a chain with the built fumpad v0.7 program, the MAINNET Meteora DBC 0.2.1 + DAMM v2 0.2.4 binaries,
 * a pre-seeded Global (local windows, 3 keepers, the FUMPAD DBC config allow-listed) and that config created.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

import { DBC_POOL_AUTHORITY } from "@fumpad/sdk";
import { createPool, migrate } from "@fumpad/indexer";

import { airdrop, createFumpadConfig, LOCAL_PARAMS, transferSol } from "./actors.js";
import { buildGrinder, keypair, keypairPath, LOCAL, type Postgres, type Service, startBinary, startPostgres, startService, startValidator, type Validator, waitFor } from "./harness.js";

export interface StackOpts {
  rpcPort?: number;
  apiPort?: number;
  grinderThreads?: number;
  /** Mints the grinder keeps ready (the e2e needs 1; the app stack a few). */
  poolTarget?: number;
  log?: (s: string) => void;
}

export interface Stack {
  v: Validator;
  pg: Postgres;
  conn: Connection;
  services: Service[];
  admin: Keypair;
  treasury: Keypair;
  keepers: Keypair[];
  config: Keypair;
  api: string;
  ports: { api: number; indexer: number; keeper: number; watcher: number };
  ssrSecret: string;
  /** GET with the SSR secret (bypasses the API's public rate limit). */
  get<T>(path: string, base?: string): Promise<T>;
  /** Write every service's logs to .local/<dir> and print their recent errors. */
  dumpLogs(dir: string, log?: (s: string) => void): string;
  stop(): Promise<void>;
}

const SOL = BigInt(LAMPORTS_PER_SOL);

export async function startStack(opts: StackOpts = {}): Promise<Stack> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const rpcPort = opts.rpcPort ?? 8899;
  const apiPort = opts.apiPort ?? 18080;
  const ports = { api: apiPort, indexer: apiPort + 1, keeper: apiPort + 2, watcher: apiPort + 3 };
  const api = `http://127.0.0.1:${apiPort}`;
  const ssrSecret = randomBytes(24).toString("hex");
  const services: Service[] = [];
  let v: Validator | undefined;
  let pg: Postgres | undefined;
  const stop = async () => {
    for (const s of [...services].reverse()) await s.stop();
    await v?.stop();
    await pg?.stop();
  };
  try {
    log("▶ starting Postgres + solana-test-validator (fumpad v0.7 + mainnet DBC/DAMM v2)");
    pg = await startPostgres();
    const mdb = createPool(pg.url, 2);
    await migrate(mdb);
    await mdb.end();
    const mintPoolKey = randomBytes(32).toString("hex");
    services.push(
      startBinary("grinder", buildGrinder(), [], {
        DATABASE_URL: pg.url,
        MINT_POOL_KEY: mintPoolKey,
        POOL_TARGET: String(opts.poolTarget ?? 1),
        POOL_POLL_SECS: "2",
        GRINDER_THREADS: String(opts.grinderThreads ?? 6),
      }),
    );

    const auth = keypair("upgrade-authority");
    const admin = Keypair.generate();
    const treasury = Keypair.generate();
    const keepers = [keypair("keeper"), keypair("keeper2"), keypair("keeper3")];
    const config = Keypair.generate();
    v = await startValidator({ rpcPort, upgradeAuthority: auth, global: { admin: admin.publicKey, platformTreasury: treasury.publicKey, keepers: keepers.map((k) => k.publicKey), params: LOCAL_PARAMS, configs: [config.publicKey] } });
    const conn = new Connection(v.rpcUrl, "confirmed");
    for (const k of [auth, admin, ...keepers]) await airdrop(conn, k.publicKey, 20);
    // DBC's pool authority fronts the migration's flash rent (mainnet: Meteora keeps it funded).
    await transferSol(conn, admin, DBC_POOL_AUTHORITY, 10n * SOL);
    await createFumpadConfig(conn, admin, config);
    log("✓ chain ready: Global seeded (local windows, 3 keepers, FUMPAD DBC config allow-listed), config created");

    const common = { DATABASE_URL: pg.url, RPC_URL: v.rpcUrl, LOG_LEVEL: "info" };
    services.push(
      startService("indexer", "indexer/src/main.ts", {
        ...common,
        WS_URL: v.wsUrl,
        PORT: String(ports.indexer),
        POLL_INTERVAL_MS: "1000",
        METEORA_POLL_INTERVAL_MS: "1000",
        FINALIZE_INTERVAL_MS: "5000",
        METEORA_FINALIZE_INTERVAL_MS: "5000",
        DERIVE_INTERVAL_MS: "3000",
        RECONCILE_INTERVAL_MS: "15000",
        FETCH_METADATA: "false",
      }),
    );
    await waitFor("indexer health", async () => (await fetch(`http://127.0.0.1:${ports.indexer}/health`)).status > 0, 60_000);
    services.push(startService("api", "api/src/main.ts", { ...common, PORT: String(apiPort), SOL_USD_FALLBACK: "150", API_SSR_SECRET: ssrSecret, RATE_LIMIT_PER_MIN: "100000", LAUNCH_POOL_RESERVE: "0", MINT_POOL_KEY: mintPoolKey, LAUNCH_SWEEP_SECS: "5" }));
    await waitFor("api health", async () => (await fetch(`${api}/health`)).ok, 60_000);
    services.push(
      startService("keeper", "keeper/src/main.ts", {
        RPC_URL: v.rpcUrl,
        KEEPER_KEYPAIR: keypairPath("keeper"),
        PORT: String(ports.keeper),
        LOG_LEVEL: "info",
        LOOP_MS: "1000",
        FULL_RATE_SECS: "3",
        HEARTBEAT_SECS: "20",
        SCAN_INTERVAL_SECS: "2",
        TICKET_SCAN_INTERVAL_SECS: "2",
        BUYBACK_MIN_LAMPORTS: "100000",
        BUYBACK_INTERVAL_SECS: "4",
        FEES_MIN_LAMPORTS: "100000",
        FEES_INTERVAL_SECS: "5",
        LP_FEES_INTERVAL_SECS: "10",
        MIGRATE_GRACE_SECS: "0",
        QUEUE_INTERVAL_SECS: "3",
        AUTOCLAIM_INTERVAL_SECS: "3",
        CLOSE_INTERVAL_SECS: "5",
        PLATFORM_FEES_MIN_LAMPORTS: "1000000",
        PRIORITY_MIN_MICROLAMPORTS: "1000",
        MIN_KEEPER_LAMPORTS: "1000000000",
      }),
    );
    for (let i = 0; i < 3; i++) {
      services.push(
        startService(`attestor${i + 1}`, "keeper/src/main.ts", {
          KEEPER_MODE: "attestor",
          RPC_URL: v.rpcUrl,
          DATABASE_URL: pg.url,
          KEEPER_KEYPAIR: keypairPath(i === 0 ? "keeper" : `keeper${i + 1}`),
          PYTH_SOURCE: "constant",
          PYTH_CONSTANT_USD: "150",
          ATTEST_LOOP_MS: "2000",
          ATTEST_FALLBACK_SUBMIT_SECS: "10",
          LOG_LEVEL: "info",
        }),
      );
    }
    services.push(startService("watcher", "keeper/src/main.ts", { KEEPER_MODE: "watcher", RPC_URL: v.rpcUrl, PORT: String(ports.watcher), PYTH_SOURCE: "constant", PYTH_CONSTANT_USD: "150", WATCH_LOOP_MS: "3000", WATCH_GRACE_SECS: "120", LOG_LEVEL: "info" }));
    await waitFor("keeper health", async () => (await fetch(`http://127.0.0.1:${ports.keeper}/health`)).status > 0, 60_000);
    await waitFor("watcher health", async () => (await fetch(`http://127.0.0.1:${ports.watcher}/health`)).ok, 60_000);
    log("✓ indexer, api, grinder, keeper, 3 attestors, watcher running");

    const get = async <T>(path: string, base = api): Promise<T> => {
      const r = await fetch(base + path, { headers: { "x-fumpad-ssr": ssrSecret } });
      if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
      return (await r.json()) as T;
    };
    const dumpLogs = (name: string, out = log) => {
      const dir = join(LOCAL, name);
      mkdirSync(dir, { recursive: true });
      for (const s of services) {
        writeFileSync(join(dir, `${s.name}.log`), s.logs.join("\n"));
        const tail = s.logs.filter((l) => /error|warn|fail|"level":(40|50)/i.test(l)).slice(-6);
        if (tail.length) out(`── ${s.name} ──\n${tail.map((l) => l.slice(0, 500)).join("\n")}`);
      }
      return dir;
    };
    return { v, pg, conn, services, admin, treasury, keepers, config, api, ports, ssrSecret, get, dumpLogs, stop };
  } catch (e) {
    const dir = join(LOCAL, "stack-logs");
    mkdirSync(dir, { recursive: true });
    for (const s of services) writeFileSync(join(dir, `${s.name}.log`), s.logs.join("\n"));
    await stop();
    throw e;
  }
}
