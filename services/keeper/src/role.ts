/**
 * Key separation (pre-audit, INTERFACE §8 2026-10-13 d): the jobs keeper runs with an OPERATOR key
 * (`Global.operators`: samples, claim_for, pre-graduation buybacks) and never with an attestor key; an attestor
 * (`Global.keepers`) never runs with an operator key. One compromised box then holds either an attestation key or
 * the jobs key, never both. The program enforces the same split (an operator can't attest, an attestor can't do
 * jobs, `set_operators` / `set_keepers` refuse an overlap); these checks make a misconfigured deployment fail at
 * startup instead of failing every transaction.
 */
import type { Connection, PublicKey } from "@solana/web3.js";

import { decodeGlobal, type GlobalAccount, globalPda, keyRole } from "@fumpad/sdk";

export type KeyedMode = "jobs" | "attestor";

/** Why `key` must not run in `mode` given Global's roles, or null when it may. */
export function roleProblem(mode: KeyedMode, g: Pick<GlobalAccount, "keepers" | "operators">, key: PublicKey): string | null {
  const role = keyRole(g, key);
  if (mode === "jobs") {
    if (role === "operator") return null;
    if (role === "both")
      return "is both an attestor (Global.keepers) and an operator (Global.operators) — the transitional state after migrate_global: set_operators to a separate jobs key, then run the jobs keeper with that key";
    if (role === "attestor") return "is an attestor key (Global.keepers): the jobs keeper must run with an operator key (Global.operators), never with an attestation key";
    return "is not an operator (Global.operators): the admin must set_operators first (samples, claim_for and pre-graduation buybacks would all fail)";
  }
  if (role === "operator" || role === "both") return "is an operator (jobs) key: an attestor must never share its key with the jobs keeper (use a separate attestor key)";
  // Not (yet) in Global.keepers: the attestor idles and reports `not_active_keeper` until the admin adds it.
  return null;
}

/** Read Global and throw when `key` must not run in `mode`. */
export async function requireKeyRole(mode: KeyedMode, conn: Connection, key: PublicKey): Promise<GlobalAccount> {
  const info = await conn.getAccountInfo(globalPda());
  if (!info) throw new Error("Global not initialized");
  const g = decodeGlobal(info.data);
  const problem = roleProblem(mode, g, key);
  if (problem) throw new Error(`keeper(${mode}): refusing to start — ${key.toBase58()} ${problem}`);
  return g;
}
