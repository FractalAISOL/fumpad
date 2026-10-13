/**
 * Program errors → one sentence for the toast. Codes and names come from @fumpad/sdk (the v0.7
 * IDL, `contracts/INTERFACE-v0.7.md` §7); the sentences are the app's own, keyed by error name so
 * a renumbered IDL can't attach them to the wrong error. Meteora's own failures (a swap that hit
 * its slippage bound or the curve's end) get a generic line, told apart by the failing program
 * in the logs.
 *
 * No React, no `@/` imports.
 */
import { customErrorCode, DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, errorName, FUMPAD_PROGRAM_ID } from "@fumpad/sdk";

export { customErrorCode };

/** Messages for the errors a user can hit; the rest fall back to the error name. */
export const FUMPAD_ERROR_MESSAGES: Record<string, string> = {
  Paused: "FUMPAD has paused this action for now. Selling on Meteora directly always works.",
  SlippageExceeded: "The price moved past your slippage, so nothing traded. Check the new quote and try again.",
  ZeroAmount: "The amount is too small.",
  WrongCoinStatus: "The coin is between the curve and its Meteora pool. Try again in a minute.",
  ConfigNotAllowed: "This coin wasn't launched on a FUMPAD config.",
  PoolNotFresh: "That launch address was already used. Review the launch again.",
  NothingToClaim: "There's nothing to withdraw yet.",
  TooManyOpenTickets: "You already have the most open tickets allowed on this coin.",
  TicketInChallenge: "This ticket is still in its challenge window. It can be claimed once the window ends.",
  TicketNotOpen: "This ticket isn't open anymore.",
  TicketExpired: "This ticket expired.",
  TriggerNotMet: "The 30-minute median isn't at 10× of your ticket price right now.",
  QueueFull: "The claim queue for this coin is full. Try again after it moves.",
  WalletQueueLimit: "You already have the most claims allowed in this coin's queue.",
  NoEscrow: "This ticket has nothing in escrow.",
  PoolDisabled: "Trading is paused on this pool by Meteora. Nothing traded; try again later.",
};

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
    // 6058 PoolDisabled (INTERFACE-v0.7 §8.10) until the SDK's IDL carries it.
    const name = errorName(code) ?? (code === 6058 ? "PoolDisabled" : undefined);
    if (name) return FUMPAD_ERROR_MESSAGES[name] ?? `The transaction failed (${name}).`;
  }
  return raw || "Transaction failed.";
}
