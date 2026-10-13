import { requireFumpadDeployment } from "@fumpad/sdk";

import { loadIndexerConfig } from "./config.js";
import { Indexer } from "./indexer.js";

const cfg = loadIndexerConfig();
// FUMPAD_PROGRAM_ID / FUMPAD_CLUSTER must match the chain behind RPC_URL (program + Global.cluster_tag), else exit 1.
await requireFumpadDeployment("indexer", cfg.rpcUrl);
const idx = new Indexer(cfg);
await idx.start();
const shutdown = async (sig: string) => {
  idx.log.info({ sig }, "shutting down");
  await idx.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
