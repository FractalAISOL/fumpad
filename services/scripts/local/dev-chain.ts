/**
 * `npm run validator` — a long-running local v0.7 chain for development: solana-test-validator with the
 * fumpad v0.7 program + mainnet DBC/DAMM v2 binaries + migration config + Pyth, a pre-seeded Global (local
 * windows, the keeper registered, a FUMPAD DBC config allow-listed and created), funded keeper, Postgres.
 * Writes services/.local/dev.env and prints how to start the services. Ctrl-C stops everything.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Connection, Keypair } from "@solana/web3.js";

import { DBC_POOL_AUTHORITY } from "@fumpad/sdk";

import { airdrop, createFumpadConfig, LOCAL_PARAMS, transferSol } from "./actors.js";
import { keypair, keypairPath, LOCAL, startPostgres, startValidator } from "./harness.js";

const auth = keypair("upgrade-authority");
const keepers = [keypair("keeper"), keypair("keeper2"), keypair("keeper3")];
const admin = Keypair.generate();
const treasury = Keypair.generate().publicKey;
const config = Keypair.generate();
const v = await startValidator({ upgradeAuthority: auth, global: { admin: admin.publicKey, platformTreasury: treasury, keepers: keepers.map((k) => k.publicKey), params: LOCAL_PARAMS, configs: [config.publicKey] } });
const pg = await startPostgres();
const conn = new Connection(v.rpcUrl, "confirmed");
for (const k of [auth, admin, ...keepers]) await airdrop(conn, k.publicKey, 100);
await transferSol(conn, admin, DBC_POOL_AUTHORITY, 10_000_000_000n);
await createFumpadConfig(conn, admin, config);

const env = `RPC_URL=${v.rpcUrl}\nWS_URL=${v.wsUrl}\nDATABASE_URL=${pg.url}\nKEEPER_KEYPAIR=${keypairPath("keeper")}\nSOL_USD_FALLBACK=150\nPYTH_SOURCE=constant\n`;
writeFileSync(join(LOCAL, "dev.env"), env);
console.log(`
local v0.7 chain ready
  rpc       ${v.rpcUrl}   (ws ${v.wsUrl})
  postgres  ${pg.url}
  keepers   ${keepers.map((k) => k.publicKey.toBase58()).join(", ")}
  config    ${config.publicKey.toBase58()} (FUMPAD DBC config, devnet curve: 0.85 SOL raise)
  env file  ${join(LOCAL, "dev.env")}

start the services (each in its own terminal, from services/):
  set -a; . .local/dev.env; set +a
  PORT=8081 npm run dev -w @fumpad/indexer
  PORT=8080 npm run dev -w @fumpad/api
  PORT=8082 FULL_RATE_SECS=3 HEARTBEAT_SECS=20 npm run dev -w @fumpad/keeper
  KEEPER_MODE=attestor KEEPER_KEYPAIR=.local/keeper2.json npm run dev -w @fumpad/keeper   (×3 keys)
  KEEPER_MODE=watcher PORT=8790 npm run dev -w @fumpad/keeper

Ctrl-C to stop the validator and Postgres.`);

const stop = async () => {
  await v.stop();
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
await new Promise(() => {});
