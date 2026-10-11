import { loadKeeperConfig } from "./config.js";
import { Keeper } from "./keeper.js";

const k = new Keeper(loadKeeperConfig());
await k.start();
const shutdown = async (sig: string) => {
  k.log.info({ sig }, "shutting down");
  await k.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
