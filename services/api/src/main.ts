import { requireFumpadDeployment } from "@fumpad/sdk";

import { loadApiConfig } from "./config.js";
import { buildServer } from "./server.js";

const cfg = loadApiConfig();
// FUMPAD_PROGRAM_ID / FUMPAD_CLUSTER must match the chain behind RPC_URL (program + Global.cluster_tag), else exit 1.
await requireFumpadDeployment("api", cfg.rpcUrl);
const { app, deps } = await buildServer(cfg);
await deps.live.start();
await app.listen({ port: cfg.port, host: cfg.host });
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
