/**
 * Read-only: run the attestor's derivation (deriveCoin + verifyCoin, exactly as attestor / watcher do) for one or
 * every registered coin against `RPC_URL`, finalized. No keys, no transactions. Prints tickets / candidates per
 * coin. `--capture <dir>` also saves the coin's fumpad-event txs (trimmed) + its program accounts as fixtures.
 *
 *   set -a; . ~/fumpad-keys/devnet/rpc.env; set +a
 *   PYTH_SOURCE=onchain PYTH_RPC_URL=<mainnet> npx tsx scripts/devnet/derive-coin.ts [<mint>|all] [--capture dir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Connection, PublicKey } from "@solana/web3.js";

import { MeteoraRpc } from "@fumpad/meteora";
import { coinPda, decodeFumpadEvents, FUMPAD_PROGRAM_ID, type TxLike } from "@fumpad/sdk";

import { candidates } from "../../keeper/src/attest/records.js";
import { RpcChainView } from "../../keeper/src/attest/chain.js";
import { deriveCoin, lifecycleEvents, newCaches } from "../../keeper/src/attest/derive.js";
import { guardHistory } from "../../keeper/src/attest/history-check.js";
import { checkPythSource, pythSourceFromEnv } from "../../keeper/src/attest/run.js";
import { verifyCoin } from "../../keeper/src/watch/verify.js";

const args = process.argv.slice(2);
const which = args[0] && !args[0].startsWith("--") ? args[0] : "all";
const capIdx = args.indexOf("--capture");
const captureDir = capIdx >= 0 ? args[capIdx + 1] : undefined;

const url = process.env.RPC_URL;
if (!url) throw new Error("RPC_URL missing");
const rpc = new MeteoraRpc(url, { minGapMs: 20 });
const conn = new Connection(url, "finalized");
const chain = new RpcChainView(conn, "finalized");
const pyth = pythSourceFromEnv(process.env);
await checkPythSource(pyth);
const caches = newCaches();
const derive = guardHistory(rpc, (coin, g) => deriveCoin({ rpc, fetchPrice: (t, d) => pyth.priceAt(t, d), caches, priceCache: new Map() }, coin, g));

const g = await chain.global();
const coins = which === "all" ? await chain.coins() : [await chain.coin(new PublicKey(which))].filter((c) => c !== null);
if (!coins.length) throw new Error(`no Coin account for ${which}`);
const now = Math.floor(Date.now() / 1000);
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
let failed = 0;
for (const coin of coins) {
  const mint = coin.mint.toBase58();
  try {
    const der = await derive(coin, g);
    const life = lifecycleEvents(mint, der.history);
    const v = verifyCoin(mint, der.output, der.history, now);
    const cands = candidates(mint, der.output, { clusterTag: g.clusterTag, now, maxAttestAgeSecs: Number(g.params.maxAttestAgeSecs) });
    console.log(
      JSON.stringify(
        {
          mint,
          txs: der.txCount,
          sells: der.output.sells.map((s) => ({ trader: s.trader, sig: s.signature, ixKey: s.ixKey, base: s.baseAmount, reason: s.ticket ? "ticket" : s.reason })),
          rebuys: der.output.rebuys.length,
          issues: der.output.issues,
          onChainTickets: life.filter((e) => e.kind === "ticket_attested").map((e) => ({ ticket: (e as { ticket: string }).ticket, owner: (e as { owner?: string }).owner })),
          ticketStatus: life.filter((e) => e.kind === "ticket_status").map((e) => (e as { status: string }).status),
          verdicts: v.verdicts.map((x) => ({ v: `${x.kind}:${x.ticket}:${x.verdict}`, diffs: x.diffs })),
          missing: v.missing.length,
          candidates: cands.length,
        },
        big,
        1,
      ),
    );
    if (captureDir) {
      const dir = join(captureDir, mint);
      mkdirSync(dir, { recursive: true });
      // Trimmed: only the txs that carry fumpad events, only the fields event decoding / lifecycle reads.
      const txs = der.history
        .filter((h) => decodeFumpadEvents(h.tx as unknown as TxLike).length > 0)
        .map(({ tx, txIndex }) => ({
          txIndex,
          tx: {
            slot: tx.slot,
            blockTime: tx.blockTime,
            transaction: { signatures: tx.transaction.signatures, message: { accountKeys: (tx.transaction.message as { accountKeys: unknown }).accountKeys, instructions: [] } },
            meta: { err: tx.meta?.err ?? null, innerInstructions: tx.meta?.innerInstructions, loadedAddresses: tx.meta?.loadedAddresses ?? null },
          },
        }));
      writeFileSync(join(dir, "event-txs.json"), JSON.stringify(txs, null, 1));
      const keys = [coinPda(coin.mint), ...life.filter((e) => e.kind === "ticket_attested").map((e) => new PublicKey((e as { ticket: string }).ticket))];
      const infos = await conn.getMultipleAccountsInfo(keys, "finalized");
      const accounts = Object.fromEntries(keys.map((k, i) => [k.toBase58(), infos[i] && infos[i]!.owner.equals(FUMPAD_PROGRAM_ID) ? infos[i]!.data.toString("base64") : null]));
      writeFileSync(join(dir, "accounts.json"), JSON.stringify(accounts, null, 1));
      console.log(`captured ${txs.length} event txs + ${keys.length} accounts → ${dir}`);
    }
  } catch (e) {
    failed++;
    console.log(JSON.stringify({ mint, error: String(e), stack: (e as Error).stack?.split("\n").slice(0, 8) }, null, 1));
  }
}
console.log(`${coins.length} coin(s), ${failed} failed`);
process.exit(failed ? 1 : 0);
