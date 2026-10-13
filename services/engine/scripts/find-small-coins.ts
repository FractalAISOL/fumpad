// Read-only mainnet: find recently graduated DBC → DAMM v2 coins with a small history (golden fixtures).
//   FUMPAD_RPC_ENV_FILE=~/fumpad-keys/devnet/rpc.env npx tsx engine/scripts/find-small-coins.ts [maxSigs]
import { MeteoraRpc, parsePoolFacts } from "@fumpad/meteora";

// @ts-expect-error untyped .mjs helper
import { mainnetRpcUrl } from "../../meteora/scripts/rpc-url.mjs";

const MIGRATION_CONFIG = process.env.DAMM_CONFIG ?? "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck";
const maxSigs = Number(process.argv[2] ?? 250);
const minSigs = Number(process.argv[3] ?? 0);
const skipPages = Number(process.argv[4] ?? 0);
const rpc = new MeteoraRpc(mainnetRpcUrl() as string, { minGapMs: 120 });

let before: string | undefined;
let found = 0;
for (let page = 0; page < skipPages + 6 && found < 8; page++) {
  const sigs = await rpc.getSignaturesForAddress(MIGRATION_CONFIG, { limit: 200, before, commitment: "finalized" });
  if (!sigs.length) break;
  before = sigs[sigs.length - 1].signature;
  if (page < skipPages) continue;
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc.getTransaction(s.signature, "finalized");
    if (!tx) continue;
    for (const m of parsePoolFacts(tx).migrations) {
      const ms = await rpc.getSignaturesForAddress(m.baseMint, { limit: 1000, commitment: "finalized" });
      if (ms.length <= maxSigs && ms.length >= minSigs) {
        found++;
        console.log(JSON.stringify({ mint: m.baseMint, dbcPool: m.dbcPool, dammPool: m.dammPool, config: m.config, mintSigs: ms.length, migration: s.signature }));
      }
    }
  }
}
