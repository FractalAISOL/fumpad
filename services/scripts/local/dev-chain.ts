/**
 * `npm run validator` — a long-running local chain for development: solana-test-validator
 * with the FUMPAD programs + PumpSwap dumps + Pyth, Global initialized with fast local
 * params, a funded keeper, and a Postgres. Writes services/.local/dev.env and prints how to
 * start the services against it. Ctrl-C stops everything.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Connection, Keypair } from "@solana/web3.js";

import { FumpadClient } from "@fumpad/sdk";

import { airdrop, initGlobal, LOCAL_PARAMS } from "./actors.js";
import { keypair, keypairPath, LOCAL, startPostgres, startValidator } from "./harness.js";

const auth = keypair("upgrade-authority");
const keeper = keypair("keeper");
const admin = Keypair.generate();
const treasury = Keypair.generate().publicKey;
// v0.6: LOCAL_PARAMS are outside the on-chain bounds → the Global is seeded into the genesis.
const v = await startValidator({ upgradeAuthority: auth, global: { admin: admin.publicKey, platformTreasury: treasury, keepers: [keeper.publicKey], params: LOCAL_PARAMS } });
const pg = await startPostgres();
const conn = new Connection(v.rpcUrl, "confirmed");
for (const k of [auth, admin, keeper]) await airdrop(conn, k.publicKey, 100);
await initGlobal(new FumpadClient(conn), auth, admin, treasury, keeper.publicKey, LOCAL_PARAMS);

const env = `RPC_URL=${v.rpcUrl}\nWS_URL=${v.wsUrl}\nDATABASE_URL=${pg.url}\nKEEPER_KEYPAIR=${keypairPath("keeper")}\nSOL_USD_FALLBACK=150\n`;
writeFileSync(join(LOCAL, "dev.env"), env);
console.log(`
local chain ready
  rpc       ${v.rpcUrl}   (ws ${v.wsUrl})
  postgres  ${pg.url}
  keeper    ${keeper.publicKey.toBase58()}  (${keypairPath("keeper")})
  env file  ${join(LOCAL, "dev.env")}

start the services (each in its own terminal, from services/):
  set -a; . .local/dev.env; set +a
  PORT=8081 npm run dev -w @fumpad/indexer
  PORT=8080 npm run dev -w @fumpad/api
  PORT=8082 FULL_RATE_SECS=3 HEARTBEAT_SECS=20 npm run dev -w @fumpad/keeper

Ctrl-C to stop the validator and Postgres.`);

const stop = async () => {
  await v.stop();
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
await new Promise(() => {});
