import { loadIndexerConfig } from "./config.js";
import { Indexer } from "./indexer.js";

const idx = new Indexer(loadIndexerConfig());
await idx.start();
const shutdown = async (sig: string) => {
  idx.log.info({ sig }, "shutting down");
  await idx.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
