/**
 * Remove ONE coin (by mint) and everything indexed for it from the backend database. Dry-run by default.
 *
 *   # Railway (the Postgres PUBLIC url, piped; nothing is echoed):
 *   railway variables --service Postgres --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p' \
 *     | npx tsx scripts/ops/purge-coin.ts <mint> --url-stdin            # dry run: prints the rows
 *   ... | npx tsx scripts/ops/purge-coin.ts <mint> --url-stdin --yes    # deletes them (one transaction)
 *   # or DATABASE_URL in the environment instead of --url-stdin.
 *
 * Why it exists: after the v0.7 schema reset, the still-running v0.6 indexer (restarted by Railway on the
 * empty schema) re-created its tables and backfilled the OLD program (ASVE6…), so the v0.6 coin
 * SM5k4…fmbL came back as a coins row with its trades / positions / events. The v0.7 indexer now refuses
 * another program's database (meta `fumpad_program_id`), stops polling foreign cursors and logs coins it
 * never registered (`dbc_pool IS NULL`); this script removes the leftovers.
 *
 * What it deletes, scoped to the mint (every statement has `= <mint>` or a signature set derived from it):
 *  - rows of every table with a `mint` column (trades, positions, tickets, claims, feed_events, cursors, …);
 *    `meteora_pools` / `meteora_trades` by `base_mint`; `cursors` / `meteora_cursors` whose address is the
 *    mint or one of its pools; `coin_hourly` / `coin_holders`; finally the `coins` row;
 *  - `transactions` (and their remaining child rows) / `meteora_transactions` whose rows ALL belong to this
 *    mint. A transaction that also touched another coin is kept.
 * Not touched: `vanity_mints` (the keypair stays used), `users` (wallets), `user_stats` (recomputed by the
 * indexer's derive job), `meta`.
 *
 * The dry run executes the same DELETE … RETURNING statements inside a transaction and rolls it back, so
 * the printed rows are exactly what `--yes` deletes. A coin registered by the current program (`dbc_pool`
 * set) is refused unless `--allow-registered`.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPool, type Db, type Tx } from "@fumpad/indexer";

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export interface PurgeReport {
  mint: string;
  applied: boolean;
  coin: { symbol: string; name: string; dbcPool: string | null } | null;
  /** table → primary-key values of each deleted row (rendered `col=value, …`). */
  deleted: { table: string; rows: string[] }[];
  notes: string[];
}

async function pkColumns(c: Tx, table: string): Promise<string[]> {
  const r = await c.query<{ attname: string }>(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
    [q(table)],
  );
  return r.rows.map((x) => x.attname);
}

async function columnsOf(c: Tx, column: string): Promise<string[]> {
  const r = await c.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE c.table_schema = current_schema() AND c.column_name = $1 AND t.table_type = 'BASE TABLE' ORDER BY c.table_name`,
    [column],
  );
  return r.rows.map((x) => x.table_name);
}

/** `DELETE FROM table WHERE <where> RETURNING <pk>`; records the deleted keys. */
async function del(c: Tx, report: PurgeReport, table: string, where: string, params: unknown[]) {
  const pk = await pkColumns(c, table);
  const ret = pk.length ? pk.map(q).join(", ") : "ctid::text AS ctid";
  const r = await c.query<Record<string, unknown>>(`DELETE FROM ${q(table)} WHERE ${where} RETURNING ${ret}`, params);
  if (!r.rowCount) return;
  const rows = r.rows.map((row) => Object.entries(row).map(([k, v]) => `${k}=${String(v)}`).join(", "));
  const prev = report.deleted.find((d) => d.table === table);
  if (prev) prev.rows.push(...rows);
  else report.deleted.push({ table, rows });
}

export async function purgeCoin(db: Db, mint: string, opts: { apply?: boolean; allowRegistered?: boolean } = {}): Promise<PurgeReport> {
  if (!MINT.test(mint)) throw new Error(`not a base58 mint: ${JSON.stringify(mint)}`);
  const report: PurgeReport = { mint, applied: false, coin: null, deleted: [], notes: [] };
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const coin = await c.query<{ symbol: string; name: string; dbc_pool: string | null }>("SELECT symbol, name, dbc_pool FROM coins WHERE mint = $1", [mint]);
    report.coin = coin.rows[0] ? { symbol: coin.rows[0].symbol, name: coin.rows[0].name, dbcPool: coin.rows[0].dbc_pool } : null;
    if (report.coin?.dbcPool && !opts.allowRegistered)
      throw new Error(`${mint} ($${report.coin.symbol}) was registered by the current program (dbc_pool set): refusing without --allow-registered`);

    const withMint = await columnsOf(c, "mint");
    const withSig = new Set(await columnsOf(c, "signature"));
    // Signatures this mint's rows hang off, and those that ALSO carry another mint's rows (kept).
    const sigTables = withMint.filter((t) => withSig.has(t) && t !== "cursors");
    const sigs = new Set<string>();
    const shared = new Set<string>();
    for (const t of sigTables) {
      const r = await c.query<{ signature: string }>(`SELECT DISTINCT signature FROM ${q(t)} WHERE mint = $1 AND signature IS NOT NULL`, [mint]);
      for (const row of r.rows) sigs.add(row.signature);
    }
    // Shared = ANY table has another mint's row for that signature.
    for (const t of sigTables) {
      if (!sigs.size) break;
      const r = await c.query<{ signature: string }>(`SELECT DISTINCT signature FROM ${q(t)} WHERE signature = ANY($1) AND mint IS NOT NULL AND mint <> $2`, [[...sigs], mint]);
      for (const row of r.rows) shared.add(row.signature);
    }
    const exclusive = [...sigs].filter((s) => !shared.has(s));
    if (shared.size) report.notes.push(`${shared.size} transaction(s) also touch other coins: kept (only this mint's rows deleted)`);

    const pools = (await c.query<{ pool: string }>("SELECT pool FROM meteora_pools WHERE base_mint = $1", [mint])).rows.map((r) => r.pool);
    const meteoraSigs = (
      await c.query<{ signature: string }>(
        `SELECT DISTINCT t.signature FROM meteora_trades t WHERE t.base_mint = $1
           AND NOT EXISTS (SELECT 1 FROM meteora_trades o WHERE o.signature = t.signature AND o.base_mint <> $1)
           AND NOT EXISTS (SELECT 1 FROM meteora_pools p WHERE p.created_sig = t.signature AND p.base_mint <> $1)`,
        [mint],
      )
    ).rows.map((r) => r.signature);

    // 1. Every mint-scoped row (rollup tables and the coin itself last).
    const last = new Set(["coins", "coin_hourly", "coin_holders"]);
    for (const t of withMint) if (!last.has(t)) await del(c, report, t, "mint = $1", [mint]);
    await del(c, report, "cursors", "address = $1", [mint]);
    // 2. Meteora pipeline rows of the mint's pools.
    await del(c, report, "meteora_trades", "base_mint = $1", [mint]);
    if (meteoraSigs.length) {
      await del(c, report, "meteora_parse_issues", "signature = ANY($1)", [meteoraSigs]);
      await del(c, report, "meteora_transactions", "signature = ANY($1)", [meteoraSigs]);
    }
    await del(c, report, "meteora_cursors", "address = ANY($1)", [[mint, ...pools]]);
    await del(c, report, "meteora_pools", "base_mint = $1", [mint]);
    // 3. Transactions only this coin used, with any child rows left (events without a mint, …).
    if (exclusive.length) {
      for (const t of [...withSig].filter((t) => t !== "transactions" && !t.startsWith("meteora_") && !withMint.includes(t) && t !== "wallet_funding"))
        await del(c, report, t, "signature = ANY($1)", [exclusive]);
      for (const t of sigTables) await del(c, report, t, "signature = ANY($1)", [exclusive]);
      await del(c, report, "transactions", "signature = ANY($1)", [exclusive]);
    }
    // 4. Rollups (the delete triggers above already decremented them) and the coin row.
    await del(c, report, "coin_hourly", "mint = $1", [mint]);
    await del(c, report, "coin_holders", "mint = $1", [mint]);
    await del(c, report, "coins", "mint = $1", [mint]);

    const vanity = await c.query<{ status: string }>("SELECT status FROM vanity_mints WHERE pubkey = $1", [mint]);
    if (vanity.rows[0]) report.notes.push(`vanity_mints row kept (status ${vanity.rows[0].status}); it is never handed out again once the mint exists on chain`);
    report.notes.push("users / user_stats not touched (wallet rows; stats are recomputed by the indexer's derive job)");

    if (opts.apply) {
      await c.query("COMMIT");
      report.applied = true;
    } else await c.query("ROLLBACK");
    return report;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export function formatReport(r: PurgeReport): string {
  const lines = [
    `${r.applied ? "DELETED" : "DRY RUN: would delete"} for mint ${r.mint}${r.coin ? ` ($${r.coin.symbol} "${r.coin.name}", dbc_pool ${r.coin.dbcPool ?? "none: not registered by this program"})` : " (no coins row)"}`,
  ];
  let total = 0;
  for (const d of r.deleted) {
    total += d.rows.length;
    lines.push(`  ${d.table}: ${d.rows.length} row(s)`);
    for (const row of d.rows) lines.push(`    ${row}`);
  }
  if (!r.deleted.length) lines.push("  nothing");
  lines.push(`  total: ${total} row(s)`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  if (!r.applied && total) lines.push("Re-run with --yes to delete exactly these rows (one transaction).");
  return lines.join("\n");
}

async function readStdinLine(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.split(/\r?\n/)[0].trim();
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(n);
  const mint = args.find((a) => !a.startsWith("--"));
  if (!mint) throw new Error("usage: purge-coin.ts <mint> [--url-stdin] [--yes] [--allow-registered]");
  const url = flag("--url-stdin") ? await readStdinLine() : process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("no database URL: pipe it with --url-stdin or set DATABASE_URL");
  const db = createPool(url, 1);
  try {
    console.log(formatReport(await purgeCoin(db, mint, { apply: flag("--yes"), allowRegistered: flag("--allow-registered") })));
  } finally {
    await db.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: Error) => {
    console.error(`purge-coin failed: ${e.message.replace(/postgres(ql)?:\/\/\S+/g, "<redacted-url>")}`);
    process.exit(1);
  });
}
