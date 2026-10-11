/** `npm run migrate -w @fumpad/indexer` — apply SQL migrations; `replay <mint>` rebuilds one mint. */
import { Connection } from "@solana/web3.js";

import { loadIndexerConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { loadParams } from "./params.js";
import { replayMint } from "./replay.js";

const cfg = loadIndexerConfig();
const db = createPool(cfg.databaseUrl, 2);
const applied = await migrate(db, console.log);
console.log(applied.length ? `applied ${applied.length} migration(s)` : "schema up to date");
if (process.argv[2] === "replay" && process.argv[3]) {
  const { params } = await loadParams(new Connection(cfg.rpcUrl), db);
  console.log(`replayed ${await replayMint(db, process.argv[3], params)} events for ${process.argv[3]}`);
}
await db.end();
