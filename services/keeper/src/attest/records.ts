/**
 * Engine output → exact attestation messages (INTERFACE §4). A keeper signs only what it derived itself,
 * only finalized data, only while the chain would accept it (age), and never past an engine issue.
 */
import { PublicKey } from "@solana/web3.js";

import { compareKeys, type EngineOutput, type RebuyDebit, type SellDecision } from "@fumpad/engine";
import { encodeRebuyMessage, encodeSellMessage, FUMPAD_PROGRAM_ID, messageId, type RebuyRecord, type SellRecord, sellRecord, signatureBytes } from "@fumpad/sdk";

export type AttestKind = "sell" | "rebuy";

export interface Candidate {
  kind: AttestKind;
  id: string;
  message: Uint8Array;
  mint: string;
  slot: number;
  blockTime: number;
  /** sell: trader; rebuy: ticket owner */
  wallet: string;
  /** sell */
  sell?: SellRecord;
  /** rebuy */
  rebuy?: RebuyRecord;
  /** tx signature (base58) + ixKey of the trade / acquisition */
  signature: string;
  ixKey: number;
}

export interface CandidateOptions {
  clusterTag: number;
  programId?: PublicKey;
  now: number;
  maxAttestAgeSecs: number;
  /** Don't start an attestation that would expire before it can land. */
  ageMarginSecs?: number;
}

/** Earliest engine issue (signature/slot) — nothing at or after it is signed. */
function issueCutoff(o: EngineOutput): number {
  return o.issues.length ? Math.min(...o.issues.map((i) => i.slot)) : Number.POSITIVE_INFINITY;
}

export function sellCandidate(mint: string, s: SellDecision, o: CandidateOptions): Candidate | null {
  if (!s.ticket || !s.trader) return null;
  const rec = sellRecord({
    mint,
    pool: s.pool,
    venue: s.venue,
    routed: s.routed,
    signature: s.signature,
    ixKey: s.ixKey,
    trader: s.trader,
    baseAmount: s.baseAmount,
    quoteGross: s.quoteGross,
    ticketTokens: s.ticket.ticketTokens,
    ticketPriceQ64: s.ticket.ticketPriceQ64,
    usdCents: s.ticket.usdCents,
    pythPublishTime: s.ticket.pythPublishTime,
    slot: s.slot,
    blockTime: s.blockTime,
    clusterTag: o.clusterTag,
    programId: o.programId ?? FUMPAD_PROGRAM_ID,
  });
  const message = encodeSellMessage(rec);
  return { kind: "sell", id: messageId(message), message, mint, slot: s.slot, blockTime: s.blockTime, wallet: s.trader, sell: rec, signature: s.signature, ixKey: s.ixKey };
}

export function rebuyCandidate(mint: string, r: RebuyDebit, o: CandidateOptions): Candidate | null {
  if (!r.ticketAddress) return null; // the sell isn't attested yet: its ticket doesn't exist on chain
  const rec: RebuyRecord = {
    programId: o.programId ?? FUMPAD_PROGRAM_ID,
    clusterTag: o.clusterTag,
    mint: new PublicKey(mint),
    ticket: new PublicKey(r.ticketAddress),
    owner: new PublicKey(r.wallet),
    signature: signatureBytes(r.signature),
    ixKey: r.ixKey,
    debitTokens: r.debit,
    slot: BigInt(r.slot),
    blockTime: BigInt(r.blockTime),
  };
  const message = encodeRebuyMessage(rec);
  return { kind: "rebuy", id: messageId(message), message, mint, slot: r.slot, blockTime: r.blockTime, wallet: r.wallet, rebuy: rec, signature: r.signature, ixKey: r.ixKey };
}

/** Everything this keeper may sign now for one coin, sells first, chain order. */
export function candidates(mint: string, o: EngineOutput, opts: CandidateOptions): Candidate[] {
  const cutoff = issueCutoff(o);
  const margin = opts.ageMarginSecs ?? 300;
  const fresh = (blockTime: number, slot: number) => slot < cutoff && opts.now - blockTime <= opts.maxAttestAgeSecs - margin && blockTime <= opts.now + 60;
  const sells = o.sells
    .filter((s) => s.ticket && fresh(s.blockTime, s.slot))
    .sort((a, b) => compareKeys({ slot: a.slot, txIndex: a.txIndex, phase: 2, ixKey: a.ixKey }, { slot: b.slot, txIndex: b.txIndex, phase: 2, ixKey: b.ixKey }))
    .map((s) => sellCandidate(mint, s, opts))
    .filter((c): c is Candidate => !!c);
  const rebuys = o.rebuys
    .filter((r) => fresh(r.blockTime, r.slot))
    .map((r) => rebuyCandidate(mint, r, opts))
    .filter((c): c is Candidate => !!c);
  return [...sells, ...rebuys];
}
