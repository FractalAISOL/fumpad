/**
 * `npm run local` — run the whole stack against solana-test-validator and verify it end to
 * end (see scripts/local/e2e.ts). Everything it starts (validator, Postgres, indexer, API,
 * keeper) is stopped on exit. Needs: `anchor build` in contracts/, solana-test-validator,
 * and either DATABASE_URL or local `initdb`/`pg_ctl` (Homebrew postgres).
 */
import { runE2E } from "./local/e2e.js";

const r = await runE2E({ extraCoins: Number(process.env.EXTRA_COINS ?? 5) });
console.log("\n── row counts ──");
for (const [k, n] of Object.entries(r.counts)) console.log(`  ${k.padEnd(16)} ${n}`);
console.log(`\nWS feed events received live: ${r.wsEvents.join(", ")}`);
console.log(`keeper health: ${JSON.stringify(r.keeperHealth).slice(0, 600)}`);
console.log(`\n${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks passed in ${r.durationSec}s — ${r.ok ? "E2E OK" : "E2E FAILED"}`);
process.exit(r.ok ? 0 : 1);
