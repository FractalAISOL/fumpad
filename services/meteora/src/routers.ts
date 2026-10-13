/**
 * Best-effort app / router label for a swap. NOT used for any security decision (a trade is a trade
 * whichever app sent it); only for analytics and the feed.
 *
 * Order: (1) the outermost known router/aggregator program in the swap's CPI ancestor chain,
 * (2) any known router program anywhere at top level, (3) a known fee wallet that received lamports
 * in the transaction (trading bots that call the AMM directly and charge a SOL fee), else "direct"
 * (no router program in the chain) or "unknown_program" (an unlabelled program CPI'd into the AMM).
 */
import type { NormalizedTx } from "./tx.js";

export interface AppLabel {
  /** Short app id, e.g. "jupiter", "axiom", "direct", "unknown_program". */
  app: string;
  /** What the label is based on. */
  via: "program" | "top_level_program" | "fee_wallet" | "none";
  /** The program id or fee wallet the label came from (null for "direct"). */
  evidence: string | null;
}

/**
 * Router / aggregator programs. `source`: "brief" = id given in the FUMPAD Meteora brief;
 * "observed" = seen CPI-ing into DBC/DAMM v2 in the mainnet fixtures (test/fixtures) and attributed
 * by its program logs / public explorer label; marked in ATTESTATION.md where UNVERIFIED.
 */
export const ROUTER_PROGRAMS: Record<string, { app: string; source: "brief" | "observed" }> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: { app: "jupiter", source: "observed" },
  FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9: { app: "axiom", source: "brief" },
  proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u: { app: "okx", source: "brief" },
  DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH: { app: "dflow", source: "brief" },
  term9YPb9mzAsABaqN71A4xdbxHmpBNZavpBiQKZzN3: { app: "padre", source: "brief" },
};

/** SOL fee wallets of apps that call the AMM directly. Empty unless verified (see ATTESTATION.md). */
export const FEE_WALLETS: Record<string, { app: string; source: "observed" }> = {};

const IGNORE = new Set([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

export function appLabel(tx: NormalizedTx, outerPrograms: string[], routers = ROUTER_PROGRAMS, feeWallets = FEE_WALLETS): AppLabel {
  for (const p of outerPrograms) if (routers[p]) return { app: routers[p].app, via: "program", evidence: p };
  for (const ix of tx.flat) if (ix.stackHeight === 1 && routers[ix.programId]) return { app: routers[ix.programId].app, via: "top_level_program", evidence: ix.programId };
  for (const [wallet, d] of tx.lamportDeltas) if (d > 0n && feeWallets[wallet]) return { app: feeWallets[wallet].app, via: "fee_wallet", evidence: wallet };
  const unknown = outerPrograms.find((p) => !IGNORE.has(p));
  if (unknown) return { app: "unknown_program", via: "program", evidence: unknown };
  return { app: "direct", via: "none", evidence: null };
}
