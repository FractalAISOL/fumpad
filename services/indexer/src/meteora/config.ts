/**
 * Meteora trade indexing (DBC + DAMM v2, any app). OFF unless METEORA_INDEXER_ENABLED=true.
 *
 *   METEORA_INDEXER_ENABLED=true
 *   METEORA_DBC_CONFIGS=<config>,<config>   DBC config keys whose pools are FUMPAD pools (the future
 *                                           FUMPAD config key); each is also a signature cursor
 *   METEORA_MINTS=<mint>,…                  extra FUMPAD mints (any DBC pool of the mint + the DAMM v2
 *                                           pool it migrates into); each is a cursor
 *   METEORA_RPC_URL                         default RPC_URL; must serve version-1 transactions
 *   METEORA_BACKFILL_FROM_SLOT              first slot on an empty cursor (default 0 = full history)
 *   METEORA_POLL_INTERVAL_MS / METEORA_PAGE_SIZE / METEORA_RECONCILE_DEPTH
 */
export interface MeteoraIndexerConfig {
  enabled: boolean;
  dbcConfigs: string[];
  mints: string[];
  rpcUrl?: string;
  backfillFromSlot: number;
  pollIntervalMs: number;
  pageSize: number;
  reconcileDepth: number;
  reconcileIntervalMs: number;
  finalizeIntervalMs: number;
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

export function loadMeteoraConfig(env: NodeJS.ProcessEnv = process.env): MeteoraIndexerConfig {
  const enabled = env.METEORA_INDEXER_ENABLED === "true";
  const dbcConfigs = list(env.METEORA_DBC_CONFIGS);
  const mints = list(env.METEORA_MINTS);
  for (const a of [...dbcConfigs, ...mints]) {
    if (!a || !B58.test(a)) throw new Error(`indexer: invalid address in METEORA_* env: ${JSON.stringify(a)}`);
  }
  if (enabled && !dbcConfigs.length && !mints.length) {
    throw new Error("indexer: METEORA_INDEXER_ENABLED=true needs METEORA_DBC_CONFIGS and/or METEORA_MINTS");
  }
  return {
    enabled,
    dbcConfigs,
    mints,
    rpcUrl: env.METEORA_RPC_URL || undefined,
    backfillFromSlot: num(env.METEORA_BACKFILL_FROM_SLOT, 0),
    pollIntervalMs: num(env.METEORA_POLL_INTERVAL_MS, 2_000),
    pageSize: num(env.METEORA_PAGE_SIZE, 1_000),
    reconcileDepth: num(env.METEORA_RECONCILE_DEPTH, 200),
    reconcileIntervalMs: num(env.METEORA_RECONCILE_INTERVAL_MS, 60_000),
    finalizeIntervalMs: num(env.METEORA_FINALIZE_INTERVAL_MS, 15_000),
  };
}
