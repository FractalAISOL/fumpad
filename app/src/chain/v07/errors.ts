/**
 * ADAPTER (until @fumpad/sdk v0.7): program errors → one sentence for the toast. FUMPAD codes
 * are `contracts/INTERFACE-v0.7.md` §7 (6000 + index); Meteora's own failures (a swap that hit
 * its slippage bound or the curve's end) get a generic line, told apart by the failing program
 * in the logs.
 *
 * No React, no `@/` imports.
 */
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, FUMPAD_PROGRAM_ID } from "./ids";

/** Messages for the codes a user can hit; the rest fall back to the error name. */
const FUMPAD_ERRORS: Record<number, string> = {
  6002: "FUMPAD has paused this action for now. Selling on Meteora directly always works.",
  6004: "The price moved past your slippage, so nothing traded. Check the new quote and try again.",
  6005: "The amount is too small.",
  6007: "The coin is between the curve and its Meteora pool. Try again in a minute.",
  6009: "This coin wasn't launched on a FUMPAD config.",
  6017: "That launch address was already used. Review the launch again.",
  6021: "There's nothing to withdraw yet.",
  6041: "You already have the most open tickets allowed on this coin.",
  6044: "This ticket is still in its challenge window. It can be claimed once the window ends.",
  6045: "This ticket isn't open anymore.",
  6046: "This ticket expired.",
  6047: "The 30-minute median isn't at 10× of your ticket price right now.",
  6048: "The claim queue for this coin is full. Try again after it moves.",
  6049: "You already have the most claims allowed in this coin's queue.",
  6051: "This ticket has nothing in escrow.",
};
const FUMPAD_ERROR_NAMES = [
  "Unauthorized",
  "InvalidParams",
  "Paused",
  "MathOverflow",
  "SlippageExceeded",
  "ZeroAmount",
  "InvalidAccount",
  "WrongCoinStatus",
  "WrongVenue",
  "ConfigNotAllowed",
  "InvalidConfig",
  "ConfigListFull",
  "NoPendingParams",
  "NoPendingConfig",
  "NoPendingAdmin",
  "TimelockNotElapsed",
  "UnsupportedGlobalLayout",
  "PoolNotFresh",
  "NotMigrated",
  "InvalidMigratedPool",
  "LaunchWindowActive",
  "NothingToClaim",
  "LaunchFeesUnsettled",
  "NothingToBuyBack",
  "PriceDeviation",
  "StaleSample",
  "InsufficientSamples",
  "SampleTooSoon",
  "SampleTxNotIsolated",
  "WouldCompleteCurve",
  "MissingAttestation",
  "InvalidAttestation",
  "NotEnoughKeeperSignatures",
  "AttestationExpired",
  "WrongCluster",
  "PoolNotOfCoin",
  "CreatorSell",
  "BelowMinimumUsd",
  "InvalidTicketAmount",
  "StalePythPrice",
  "AttestRateLimited",
  "TooManyOpenTickets",
  "AlreadyConsumed",
  "ChallengeWindowOver",
  "TicketInChallenge",
  "TicketNotOpen",
  "TicketExpired",
  "TriggerNotMet",
  "QueueFull",
  "WalletQueueLimit",
  "QueueAccountRequired",
  "NoEscrow",
  "AutoClaimDisabled",
  "TicketNotClosable",
  "ConsumedNotClosable",
  "PositionNotEmpty",
  "LamportInvariant",
  "RebuyOutOfWindow",
];

/** The custom error code in an RPC error or log blob (`"Custom":6004`, `custom program error: 0x1774`). */
export function customErrorCode(err: unknown): number | null {
  const s = typeof err === "string" ? err : JSON.stringify(err ?? null);
  const m = /"?Custom"?\s*[:(]\s*(\d+)/.exec(s) ?? /custom program error: 0x([0-9a-f]+)/i.exec(s);
  if (!m) return null;
  return m[0].includes("0x") ? parseInt(m[1], 16) : Number(m[1]);
}

/** The program whose instruction failed, from `Program <id> failed: …` in the logs. */
function failingProgram(logs: string[]): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = /^Program (\w+) failed/.exec(logs[i]);
    if (m) return m[1];
  }
  return null;
}

/** One sentence for a failed transaction (preflight or confirmation). */
export function txErrorMessage(raw: string, logs?: string[]): string {
  const code = customErrorCode(raw + (logs ? JSON.stringify(logs) : ""));
  const prog = logs ? failingProgram(logs) : null;
  if (code !== null && (prog === DBC_PROGRAM_ID.toBase58() || prog === DAMM_V2_PROGRAM_ID.toBase58()))
    return "Meteora rejected the swap, usually because the price moved or the curve just completed. Nothing traded; check the quote and try again.";
  if (code !== null && (!prog || prog === FUMPAD_PROGRAM_ID.toBase58())) {
    if (FUMPAD_ERRORS[code]) return FUMPAD_ERRORS[code];
    const name = FUMPAD_ERROR_NAMES[code - 6000];
    if (name) return `The transaction failed (${name}).`;
  }
  return raw || "Transaction failed.";
}
