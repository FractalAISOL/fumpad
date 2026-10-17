/**
 * The bootstrap's `alt` step (devnet bootstrap-v07.ts and mainnet bootstrap-core.ts share it): create the FUMPAD launch
 * address lookup table, extend it with exactly @fumpad/sdk `launchAltAddresses()` and FREEZE it, in one transaction.
 *
 * Why frozen (not an admin-vault authority): a launch's lookup indexes point into the table, and every reader (API,
 * app) refuses unless its contents are exactly the expected list. An authority could only ever append (breaking that
 * check = launches stop), deactivate + close it (launches stop) — i.e. a key that can DoS launches and can't fix
 * anything a new table can't. Frozen, the table is immutable and nobody holds a key to it; who created it doesn't
 * matter. Changing the list = a new table + LAUNCH_ALT / NEXT_PUBLIC_LAUNCH_ALT rotation.
 *
 * The address derives from (authority, recent slot), so it is only known once sent: it is recorded in
 * `<keys dir>/launch-alt.json` (address, signature, cluster, program) and the step is idempotent on that record
 * (a recorded table is re-verified on chain, never silently replaced).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AddressLookupTableAccount, type Connection, type Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";

import { FUMPAD_PROGRAM_ID, launchAltAddresses, launchAltCreateIxs, launchAltProblems, loadLaunchAlt } from "@fumpad/sdk";

export interface AltRecord {
  address: string;
  signature?: string;
  cluster: string;
  program: string;
  createdAt: string;
}

export const altRecordPath = (dir: string) => join(dir, "launch-alt.json");

export function readAltRecord(dir: string): AltRecord | null {
  const p = altRecordPath(dir);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as AltRecord) : null;
}

/**
 * A `recent_slot` CreateLookupTable accepts: in the executing bank's SlotHashes, i.e. a slot WITH a block (a rooted one:
 * never skipped) that is strictly older than the bank and less than ~512 slots old. A provider's "finalized" can be as
 * fresh as its "confirmed" (load-balanced RPCs; seen on devnet), so wait until the chain is a few slots past it.
 */
export async function recentAltSlot(conn: Connection): Promise<number> {
  const slot = await conn.getSlot("finalized");
  for (let i = 0; i < 60 && (await conn.getSlot("confirmed")) < slot + 8; i++) await new Promise((r) => setTimeout(r, 250));
  return slot;
}

type Exec =(name: string, ixs: TransactionInstruction[], accounts: PublicKey[]) => Promise<{ ok: boolean; accounts: ({ owner: PublicKey; data: Uint8Array } | null)[]; sig?: string }>;

/**
 * Run the `alt` step. `exec` builds + plans / simulates / sends one transaction (the bootstrap's own, deployer = fee
 * payer); `beforeSend` is the mainnet typed confirmation. Returns the table's address when known (recorded or just
 * created), else null.
 */
export async function launchAltStep(a: {
  conn: Connection;
  dir: string;
  cluster: string;
  authority: Keypair;
  mode: "plan" | "simulate" | "send";
  exec: Exec;
  say: (s: string) => void;
  failures: string[];
  beforeSend?: (summary: string[]) => Promise<void>;
}): Promise<PublicKey | null> {
  const want = launchAltAddresses();
  a.say(`\n▶ alt (the launch lookup table: create + extend with the ${want.length} static launch accounts + FREEZE, one transaction)`);
  for (const k of want) a.say(`    ${k.toBase58()}`);
  const rec = readAltRecord(a.dir);
  if (rec) {
    if (rec.program !== FUMPAD_PROGRAM_ID.toBase58()) {
      a.failures.push(`alt: ${altRecordPath(a.dir)} is for program ${rec.program}, not ${FUMPAD_PROGRAM_ID.toBase58()}`);
      return null;
    }
    const address = new PublicKey(rec.address);
    try {
      await loadLaunchAlt(a.conn, address);
      a.say(`  ${address.toBase58()} recorded, on chain, frozen, exact contents (skip) → LAUNCH_ALT / NEXT_PUBLIC_LAUNCH_ALT`);
    } catch (e) {
      a.failures.push(`alt: recorded table ${address.toBase58()} fails verification: ${(e as Error).message} (investigate; never replaced silently)`);
    }
    return address;
  }
  const recentSlot = await recentAltSlot(a.conn);
  const { address, ixs } = launchAltCreateIxs({ authority: a.authority.publicKey, payer: a.authority.publicKey, recentSlot, programId: FUMPAD_PROGRAM_ID });
  a.say(`  authority (until the freeze in the same tx) = payer = deployer ${a.authority.publicKey.toBase58()} · recent slot ${recentSlot} → table ${address.toBase58()}${a.mode === "send" ? "" : " (the address changes with the slot at send time)"}`);
  const rent = await a.conn.getMinimumBalanceForRentExemption(56 + 32 * want.length);
  a.say(`  rent ${(rent / 1e9).toFixed(6)} SOL (locked for good: a frozen table can't be closed)`);
  if (a.mode === "send") await a.beforeSend?.([`create + extend (${want.length} accounts) + freeze launch lookup table ${address.toBase58()}`, "IRREVERSIBLE: the table can never be changed or closed; a different list needs a new table + LAUNCH_ALT rotation"]);
  const r = await a.exec("create + extend + freeze launch ALT", ixs, [address]);
  if (a.mode === "simulate" && r.ok) {
    const acc = r.accounts[0];
    let table: AddressLookupTableAccount | null = null;
    try {
      if (acc) table = new AddressLookupTableAccount({ key: address, state: AddressLookupTableAccount.deserialize(acc.data) });
    } catch {
      table = null;
    }
    const p = launchAltProblems(table, address);
    a.say(p.length ? `  simulated table FAILS: ${p.join("; ")}` : "  simulated table: frozen, active, exact contents (what the API and the app verify)");
    if (p.length) a.failures.push(`simulated alt: ${p.join("; ")}`);
  }
  if (a.mode !== "send" || !r.ok) return null;
  // usable from the slot after its last extension
  const landed = await a.conn.getSlot("confirmed");
  for (let i = 0; i < 100 && (await a.conn.getSlot("confirmed")) <= landed; i++) await new Promise((res) => setTimeout(res, 300));
  try {
    await loadLaunchAlt(a.conn, address);
  } catch (e) {
    a.failures.push(`alt: created table ${address.toBase58()} fails verification: ${(e as Error).message}`);
  }
  const record: AltRecord = { address: address.toBase58(), signature: r.sig, cluster: a.cluster, program: FUMPAD_PROGRAM_ID.toBase58(), createdAt: new Date().toISOString() };
  writeFileSync(altRecordPath(a.dir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  a.say(`  ✓ launch ALT ${address.toBase58()} (recorded in ${altRecordPath(a.dir)}) → set LAUNCH_ALT (api) and NEXT_PUBLIC_LAUNCH_ALT (app)`);
  return address;
}

/** verify-step check: the recorded launch ALT exists, frozen, exact contents. */
export async function launchAltCheck(conn: Connection, dir: string): Promise<[string, boolean, string?]> {
  const rec = readAltRecord(dir);
  if (!rec) return ["launch ALT created (--step alt)", false, "no launch-alt.json"];
  try {
    await loadLaunchAlt(conn, new PublicKey(rec.address));
    return [`launch ALT ${rec.address} frozen, exact ${launchAltAddresses().length} launch accounts (LAUNCH_ALT / NEXT_PUBLIC_LAUNCH_ALT)`, true];
  } catch (e) {
    return [`launch ALT ${rec.address} verifies`, false, (e as Error).message];
  }
}
