/**
 * S-8 / L-1 (external audit 2026-10-17): the attestor's board self-check accepts only a role that row-level
 * security actually binds — RLS enabled AND FORCEd, the role is neither the tables' owner (nor a member of it), nor
 * a superuser, nor BYPASSRLS, and the per-keeper policies exist. Real Postgres (trust auth, local only).
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ATTEST_BOARD_RLS, PgBoard } from "../../keeper/src/attest/board.js";
import { boardRlsRequired } from "../../keeper/src/attest/run.js";
import { type Postgres, startPostgres } from "../../scripts/local/harness.js";

let db: Postgres;
let owner: pg.Pool;
const pools: pg.Pool[] = [];
const as = (role: string) => {
  const u = new URL(db.url);
  u.username = role;
  const p = new pg.Pool({ connectionString: u.toString(), max: 1 });
  pools.push(p);
  return new PgBoard(p);
};

beforeAll(async () => {
  db = await startPostgres(54336);
  owner = new pg.Pool({ connectionString: db.url, max: 1 });
  // the database owner (here also a superuser) creates the tables, then a non-superuser owner role owns them
  await owner.query("CREATE ROLE board_owner LOGIN NOSUPERUSER");
  await owner.query("GRANT CREATE ON SCHEMA public TO board_owner");
  await as("board_owner").init();
}, 120_000);

afterAll(async () => {
  for (const p of pools) await p.end().catch(() => {});
  await owner?.end().catch(() => {});
  await db?.stop();
});

describe("board RLS self-check (S-8 / L-1)", () => {
  it("no RLS yet: every role is refused with the reasons", async () => {
    const p = await as("board_owner").rlsProblems();
    expect(p.join("\n")).toMatch(/row-level security disabled/);
    expect(p.join("\n")).toMatch(/owns it/);
    expect(p.join("\n")).toMatch(/not FORCEd/);
    expect(p.join("\n")).toMatch(/policy missing/);
    expect((await as("fumpad").rlsProblems()).join("\n")).toMatch(/superuser/);
  });

  it("after ATTEST_BOARD_RLS: a per-keeper role passes; the owner, a member of the owner role and a BYPASSRLS role don't", async () => {
    const o = new pg.Pool({ connectionString: (() => {
      const u = new URL(db.url);
      u.username = "board_owner";
      return u.toString();
    })(), max: 1 });
    pools.push(o);
    await o.query(ATTEST_BOARD_RLS);
    await o.query("GRANT SELECT, INSERT, UPDATE, DELETE ON attest_signatures, attest_hints TO PUBLIC");
    await o.query("GRANT SELECT ON attest_keeper_roles TO PUBLIC");
    await owner.query("CREATE ROLE keeper_a LOGIN NOSUPERUSER");
    await owner.query("CREATE ROLE keeper_member LOGIN NOSUPERUSER IN ROLE board_owner");
    await owner.query("CREATE ROLE keeper_bypass LOGIN NOSUPERUSER BYPASSRLS");
    expect(await as("keeper_a").rlsProblems()).toEqual([]);
    expect(await as("keeper_a").rowSecurity()).toBe(true);
    expect((await as("board_owner").rlsProblems()).join("\n")).toMatch(/owns it/);
    expect((await as("keeper_member").rlsProblems()).join("\n")).toMatch(/owns it/);
    expect((await as("keeper_bypass").rlsProblems()).join("\n")).toMatch(/BYPASSRLS/);
    // RLS enabled but not FORCEd (a board set up before this check): refused until ATTEST_BOARD_RLS is re-run
    await o.query("ALTER TABLE attest_hints NO FORCE ROW LEVEL SECURITY");
    expect((await as("keeper_a").rlsProblems()).join("\n")).toMatch(/attest_hints: RLS not FORCEd/);
    await o.query(ATTEST_BOARD_RLS); // idempotent
    expect(await as("keeper_a").rlsProblems()).toEqual([]);
  });

  it("ATTEST_BOARD_REQUIRE_RLS defaults to ON in production, off elsewhere, explicit values win", () => {
    expect(boardRlsRequired({ NODE_ENV: "production" })).toBe(true);
    expect(boardRlsRequired({ NODE_ENV: "production", ATTEST_BOARD_REQUIRE_RLS: "0" })).toBe(false);
    expect(boardRlsRequired({})).toBe(false);
    expect(boardRlsRequired({ ATTEST_BOARD_REQUIRE_RLS: "1" })).toBe(true);
  });
});
