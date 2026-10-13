/**
 * `npm run local` — run the whole v0.7 stack against solana-test-validator (fumpad v0.7 + mainnet Meteora
 * DBC/DAMM v2 binaries) and verify it end to end (scripts/local/e2e.ts). Everything it starts is stopped on
 * exit. Needs: `anchor build -p fumpad` in contracts/ (program keypair in contracts/target/deploy),
 * solana-test-validator, cargo (grinder), and DATABASE_URL or local `initdb`/`pg_ctl`.
 */
import { runE2E } from "./local/e2e.js";

// FUMPAD_RPC_PORT / FUMPAD_API_PORT (+ FUMPAD_GOSSIP_PORT, FUMPAD_PG_PORT): a second stack on other ports.
const r = await runE2E({ rpcPort: process.env.FUMPAD_RPC_PORT ? Number(process.env.FUMPAD_RPC_PORT) : undefined, apiPort: process.env.FUMPAD_API_PORT ? Number(process.env.FUMPAD_API_PORT) : undefined });
console.log("\n── row counts ──");
for (const [k, n] of Object.entries(r.counts)) console.log(`  ${k.padEnd(18)} ${n}`);
console.log(`\nWS feed events received live: ${r.wsEvents.join(", ")}`);
console.log(`\n${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks passed in ${r.durationSec}s — ${r.ok ? "E2E OK" : "E2E FAILED"}`);
process.exit(r.ok ? 0 : 1);
