/** Transaction plumbing shared by the keeper / scripts / app: built-tx shape, confirmation, ticket offsets. */
import type { Commitment, Connection, Signer, TransactionInstruction } from "@solana/web3.js";

import { BPS_DENOM } from "./constants.js";
import { fits } from "./math/claims.js";

export interface BuiltTx {
  instructions: TransactionInstruction[];
  /** Extra signers besides the fee payer (e.g. a fresh mint / NFT-mint keypair). */
  signers?: Signer[];
}

/** Ticket.status byte: 8 disc + bump 1 + owner 32 + mint 32 + seq 8 + tokens 8 + original 8 + price 16 + usd 8 + sell_ts 8. */
export const TICKET_STATUS_OFFSET = 129;
/** Ticket status bytes. */
export const TICKET_STATUS = { open: 0, queued: 1, claimed: 2, expired: 3, voided: 4, escrowed: 5 } as const;
/** Coin.status byte: 8 disc + bump 1. */
export const COIN_STATUS_OFFSET = 9;
export const COIN_STATUS = { curve: 0, complete: 1, graduated: 2 } as const;
/** Entries one process_queue fits: 5 in a legacy tx (13 need a v0 tx + ALT). */
export const MAX_QUEUE_ENTRIES_PER_LEGACY_TX = 5;

export class TxFailedError extends Error {
  constructor(readonly signature: string, readonly err: unknown, readonly logs?: string[] | null) {
    super(`tx ${signature} failed: ${JSON.stringify(err)}`);
  }
}

const RANK: Record<string, number> = { processed: 0, confirmed: 1, finalized: 2 };

/** Poll until the signature reaches `commitment`; throws on failure or blockhash expiry. */
export async function confirmSignature(connection: Connection, signature: string, lastValidBlockHeight: number, commitment: Commitment = "confirmed", rebroadcast?: Uint8Array, timeoutMs = 90_000): Promise<void> {
  const want = RANK[commitment] ?? 1;
  const t0 = Date.now();
  let lastSend = Date.now();
  for (;;) {
    const st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: false })).value[0];
    if (st?.err) {
      const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 as 0, commitment: "confirmed" }).catch(() => null);
      throw new TxFailedError(signature, st.err, tx?.meta?.logMessages);
    }
    if (st && RANK[st.confirmationStatus ?? "processed"] >= want) return;
    if (rebroadcast && Date.now() - lastSend > 2_000) {
      lastSend = Date.now();
      connection.sendRawTransaction(rebroadcast, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    if (Date.now() - t0 > timeoutMs || (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      const again = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (again && !again.err && RANK[again.confirmationStatus ?? "processed"] >= want) return;
      throw new Error(`tx ${signature} expired or timed out before ${commitment}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * The program's process_queue skip-ahead walk (D4): in queue order, pay every entry that fits the current
 * pool (≤ max_claim_pool_bps of it), skip the rest. Returns the entries a crank will pay.
 */
export function planQueuePayments<E extends { amount: bigint }>(entries: E[], pool: bigint, maxClaimPoolBps: number | bigint, maxPayments = MAX_QUEUE_ENTRIES_PER_LEGACY_TX): { pay: E[]; poolAfter: bigint } {
  const pay: E[] = [];
  let p = pool;
  for (const e of entries) {
    if (pay.length >= maxPayments) break;
    if (!fits(e.amount, p, maxClaimPoolBps)) continue;
    pay.push(e);
    p -= e.amount;
  }
  return { pay, poolAfter: p };
}

/** Smallest pool balance at which `amount` fits (amount ≤ pool × bps / 10_000). */
export function poolNeededFor(amount: bigint, maxClaimPoolBps: number | bigint): bigint {
  const bps = BigInt(maxClaimPoolBps);
  if (bps === 0n) return amount === 0n ? 0n : -1n;
  const need = (amount * BPS_DENOM + bps - 1n) / bps;
  return need > amount ? need : amount;
}
