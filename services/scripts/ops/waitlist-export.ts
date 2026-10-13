/**
 * Waitlist backup: every sign-up as CSV, written owner-only (dir 700, file 600, never overwritten).
 *
 *   # Railway (the waitlist-db's PUBLIC url, piped; nothing is echoed):
 *   railway variables --service waitlist-db --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p' \
 *     | npx tsx scripts/ops/waitlist-export.ts --url-stdin
 *   # or WAITLIST_DATABASE_URL in the environment:
 *   npx tsx scripts/ops/waitlist-export.ts [--out <file.csv>] [--include-ip-hash]
 *
 * Default output: ~/fumpad-keys/waitlist/waitlist-<UTC timestamp>.csv. Columns: id, email, x_handle,
 * created_at (+ ip_hash with --include-ip-hash, only for a full restore). Prints the row count and the
 * path, never a contact or the database URL.
 */
import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWaitlistPool, waitlistCsv } from "@fumpad/api";

export const DEFAULT_EXPORT_DIR = join(homedir(), "fumpad-keys", "waitlist");

/** Writes `csv` to `path` with mode 600 (exclusive create: an existing file is never overwritten). */
export function writeOwnerOnly(path: string, csv: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, csv);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600); // independent of the umask
}

export async function exportWaitlist(url: string, out: string, opts: { includeIpHash?: boolean } = {}): Promise<{ rows: number; path: string }> {
  const db = createWaitlistPool(url);
  try {
    const { csv, rows } = await waitlistCsv(db, opts);
    writeOwnerOnly(out, csv);
    return { rows, path: out };
  } finally {
    await db.end();
  }
}

async function readStdinLine(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.split(/\r?\n/)[0].trim();
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(n);
  const value = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = flag("--url-stdin") ? await readStdinLine() : process.env.WAITLIST_DATABASE_URL?.trim();
  if (!url) throw new Error("no database URL: pipe it with --url-stdin or set WAITLIST_DATABASE_URL");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(value("--out") ?? join(DEFAULT_EXPORT_DIR, `waitlist-${stamp}.csv`));
  const r = await exportWaitlist(url, out, { includeIpHash: flag("--include-ip-hash") });
  console.log(`exported ${r.rows} sign-up(s) → ${r.path} (mode 600)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: Error) => {
    // pg errors can quote the connection string's host; never the password, but keep it short anyway.
    console.error(`waitlist export failed: ${e.message.replace(/postgres(ql)?:\/\/\S+/g, "<redacted-url>")}`);
    process.exit(1);
  });
}
