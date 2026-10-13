/**
 * Keeper process. Modes (KEEPER_MODE or `--mode`):
 *   jobs      (default) fee claims, graduation, buybacks, samples, auto-claim, queue, ticket closing
 *   attestor  D31 ticket attestations (run ×3: separate keys, RPC providers, machines)
 *   watcher   independent re-derivation of every attestation + public verification feed
 */
import { runAttestor } from "./attest/run.js";
import { runWatcher } from "./watch/run.js";

const argMode = (() => {
  const i = process.argv.indexOf("--mode");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const mode = argMode ?? process.env.KEEPER_MODE ?? "jobs";

let stop: () => Promise<void>;
if (mode === "attestor") {
  stop = (await runAttestor()).stop;
} else if (mode === "watcher") {
  stop = (await runWatcher()).stop;
} else if (mode === "jobs") {
  const { loadKeeperConfig } = await import("./config.js");
  const { Keeper } = await import("./keeper.js");
  const k = new Keeper(loadKeeperConfig());
  await k.start();
  stop = () => k.stop();
} else {
  throw new Error(`unknown keeper mode ${mode}`);
}

const shutdown = async (sig: string) => {
  console.error(`shutting down (${sig})`);
  await stop();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
