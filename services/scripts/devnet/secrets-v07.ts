/**
 * Secret plumbing for the v0.7 Railway services (services/DEPLOY-v07.md). Nothing secret is ever printed to a
 * terminal: the commands that output a secret REFUSE to run when stdout is a TTY, so they can only be piped
 * (`… | railway variables … --set-from-stdin VAR`).
 *
 *   npx tsx scripts/devnet/secrets-v07.ts key <name> [--json]   # secret key of <keys-dir>/<name>.json (base58 default)
 *   npx tsx scripts/devnet/secrets-v07.ts pubkey <name>          # public key (safe to print)
 *   npx tsx scripts/devnet/secrets-v07.ts db-sql [--pg-service Postgres]
 *        # writes <keys-dir>/db/roles.sql (mode 600): board DDL + per-attestor roles + RLS (V7-M1);
 *        # role passwords generated once into <keys-dir>/db/passwords.json (600). Prints only the paths.
 *   npx tsx scripts/devnet/secrets-v07.ts db-url <attestor-1|attestor-2|attestor-3> [--pg-service Postgres]
 *        # postgresql://fumpad_attestor_N:<pw>@${{<pg>.RAILWAY_PRIVATE_DOMAIN}}:5432/${{<pg>.PGDATABASE}}
 *        # (same Railway project as the board Postgres)
 *   npx tsx scripts/devnet/secrets-v07.ts db-url <attestor-N> --public <host:port> [--db railway]
 *        # postgresql://fumpad_attestor_N:<pw>@<host:port>/<db>?sslmode=require — for an attestor in ANOTHER Railway
 *        # project / account (DEPLOY-v07.md §1 topology): <host:port> = the board Postgres's TCP proxy
 *   `key operator` = the jobs keeper's key (Global.operators[0]; never an attestor key).
 *
 * --keys-dir <dir> (default ~/fumpad-keys/devnet/v07).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { ATTEST_BOARD_DDL, ATTEST_BOARD_RLS } from "../../keeper/src/attest/board.js";

export const ATTESTORS = ["attestor-1", "attestor-2", "attestor-3"] as const;
export const dbRole = (attestor: string) => `fumpad_${attestor.replace("-", "_")}`;

const argv = process.argv.slice(2);
const opt = (f: string, d: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : d;
};
const keysDir = opt("--keys-dir", join(homedir(), "fumpad-keys/devnet/v07"));
const pgService = opt("--pg-service", "Postgres");
const dbDir = join(keysDir, "db");

const readKey = (name: string) => {
  const f = join(keysDir, `${name}.json`);
  if (!existsSync(f)) throw new Error(`missing ${f} (bootstrap-v07.ts --step keys)`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf8")) as number[]));
};

function pipeOnly(value: string) {
  if (process.stdout.isTTY) throw new Error("refusing to print a secret to a terminal: pipe it (… | railway variables --service <svc> --set-from-stdin <VAR>)");
  process.stdout.write(value);
}

function passwords(): Record<string, string> {
  mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  const f = join(dbDir, "passwords.json");
  const cur: Record<string, string> = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  let changed = false;
  for (const a of ATTESTORS) {
    if (!cur[a]) {
      cur[a] = randomBytes(24).toString("hex");
      changed = true;
    }
  }
  if (changed) writeFileSync(f, JSON.stringify(cur, null, 2), { mode: 0o600 });
  chmodSync(f, 0o600);
  return cur;
}

const [cmd, arg] = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
try {
  if (cmd === "key") {
    const k = readKey(arg);
    pipeOnly(argv.includes("--json") ? JSON.stringify(Array.from(k.secretKey)) : bs58.encode(k.secretKey));
  } else if (cmd === "pubkey") {
    console.log(readKey(arg).publicKey.toBase58());
  } else if (cmd === "db-sql") {
    const pw = passwords();
    const sql = [
      "-- FUMPAD v0.7 attestor signature board: tables, per-attestor roles, row-level security (V7-M1).",
      "-- Run once as the database OWNER (railway connect <pg>, then \\i this file). Idempotent.",
      "BEGIN;",
      ATTEST_BOARD_DDL.trim(),
      ATTEST_BOARD_RLS.trim(),
      ...ATTESTORS.flatMap((a) => {
        const role = dbRole(a);
        return [
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD '${pw[a]}'; ELSE ALTER ROLE ${role} LOGIN PASSWORD '${pw[a]}'; END IF; END $$;`,
          `GRANT USAGE ON SCHEMA public TO ${role};`,
          `GRANT SELECT, INSERT, UPDATE, DELETE ON attest_signatures, attest_hints TO ${role};`,
          `GRANT SELECT ON attest_keeper_roles TO ${role};`,
          `INSERT INTO attest_keeper_roles (db_role, keeper) VALUES ('${role}', '${readKey(a).publicKey.toBase58()}') ON CONFLICT (db_role) DO UPDATE SET keeper = EXCLUDED.keeper;`,
        ];
      }),
      "COMMIT;",
      "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('attest_signatures', 'attest_hints');",
      "SELECT * FROM attest_keeper_roles ORDER BY db_role;",
      "",
    ]
      .join("\n");
    const out = join(dbDir, "roles.sql");
    writeFileSync(out, sql, { mode: 0o600 });
    chmodSync(out, 0o600);
    console.log(`wrote ${out} (600; contains role passwords: never commit or paste it)`);
    console.log(`roles: ${ATTESTORS.map(dbRole).join(", ")} → attest_keeper_roles maps each to its attestor pubkey`);
    console.log(`run it as the owner: railway connect ${pgService}   then   \\i ${out}`);
  } else if (cmd === "db-url") {
    if (!ATTESTORS.includes(arg as (typeof ATTESTORS)[number])) throw new Error("db-url attestor-1|attestor-2|attestor-3");
    const pw = passwords()[arg];
    const pub = argv.indexOf("--public");
    if (pub >= 0) {
      // an attestor in another project can't use the private network or ${{…}} references: literal TCP proxy, TLS
      const host = argv[pub + 1];
      if (!host || !/^[a-z0-9.-]+:\d+$/i.test(host)) throw new Error("--public <host:port> (the board Postgres's TCP proxy)");
      pipeOnly(`postgresql://${dbRole(arg)}:${pw}@${host}/${opt("--db", "railway")}?sslmode=require`);
    } else {
      pipeOnly(`postgresql://${dbRole(arg)}:${pw}@\${{${pgService}.RAILWAY_PRIVATE_DOMAIN}}:5432/\${{${pgService}.PGDATABASE}}`);
    }
  } else {
    console.error("usage: secrets-v07.ts key <name> [--json] | pubkey <name> | db-sql | db-url <attestor-N> [--public host:port [--db railway]]  [--keys-dir d] [--pg-service Postgres]");
    process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
