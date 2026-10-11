/**
 * Event decoding.
 *
 * fumpad emits every event with `emit_cpi!`: a self-CPI whose data is
 * EVENT_IX_TAG ‖ event discriminator ‖ borsh(event), signed by the program's
 * `__event_authority` PDA. These live in the transaction's INNER instructions and,
 * unlike logs, can't be truncated or spoofed (only fumpad can sign as its event
 * authority, and Anchor's handler rejects the tag otherwise).
 *
 * fumpad_lp_locker uses plain `emit!` (log line `Program data: <base64>`); those are
 * attributed to the locker by tracking the invoke stack in the logs.
 */
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { normalize } from "./borsh.js";
import { fumpadCoder, lockerCoder } from "./coder.js";
import { EVENT_IX_TAG, FUMPAD_PROGRAM_ID, LP_LOCKER_PROGRAM_ID } from "./constants.js";
import { eventAuthorityPda } from "./pda.js";

// ── Event payloads (normalized: camelCase, bigint, PublicKey) ───────────────

export interface CoinCreatedEvent { mint: PublicKey; creator: PublicKey; name: string; symbol: string; uri: string; ts: bigint }
export interface TradeEvent {
  mint: PublicKey; user: PublicKey; isBuy: boolean; onAmm: boolean; tokenAmount: bigint; solAmount: bigint;
  feePool: bigint; feePlatform: bigint; feeCreator: bigint; poolTokensBought: bigint; priceQ64: bigint;
  virtualSolReserves: bigint; virtualTokenReserves: bigint; ts: bigint;
}
export interface CurveCompletedEvent { mint: PublicKey; ts: bigint }
export interface GraduatedEvent { mint: PublicKey; pool: PublicKey; solDeposited: bigint; tokensDeposited: bigint; lpLocked: bigint; ts: bigint }
export interface LpFeesSettledEvent { mint: PublicKey; lamports: bigint; platform: bigint; creator: bigint; ts: bigint }
export interface TicketCreatedEvent { mint: PublicKey; owner: PublicKey; ticket: PublicKey; tokens: bigint; sellPriceQ64: bigint; sellUsdCents: bigint; ts: bigint }
export interface TicketDebitedEvent { ticket: PublicKey; debited: bigint; remaining: bigint; voided: boolean; ts: bigint }
export interface ClaimQueuedEvent { mint: PublicKey; ticket: PublicKey; owner: PublicKey; amount: bigint; queueLen: number; ts: bigint }
export interface ClaimPaidEvent { mint: PublicKey; ticket: PublicKey; owner: PublicKey; amount: bigint; fromQueue: boolean; medianPriceQ64: bigint; ts: bigint }
export interface TicketClosedEvent { ticket: PublicKey; owner: PublicKey; finalStatus: number; ts: bigint }
export interface SampleRecordedEvent { mint: PublicKey; priceQ64: bigint; fallback: boolean; ts: bigint }
export interface BuybackExecutedEvent { mint: PublicKey; lamportsIn: bigint; tokensOut: bigint; ts: bigint }
export interface FeesWithdrawnEvent { mint: PublicKey; recipient: PublicKey; lamports: bigint; creator: boolean; ts: bigint }
export interface HoldingsRegisteredEvent { mint: PublicKey; wallet: PublicKey; added: bigint; ts: bigint }
// locker
export interface LockedEvent { pool: PublicKey; mint: PublicKey; lpLocked: bigint; lpSupply: bigint; sqrtK: bigint }
export interface SkimmedEvent { pool: PublicKey; mint: PublicKey; lpWithdrawn: bigint; baseOut: bigint; quoteOut: bigint; lpHeld: bigint }

export interface EventMap {
  CoinCreated: CoinCreatedEvent;
  Trade: TradeEvent;
  CurveCompleted: CurveCompletedEvent;
  Graduated: GraduatedEvent;
  LpFeesSettled: LpFeesSettledEvent;
  TicketCreated: TicketCreatedEvent;
  TicketDebited: TicketDebitedEvent;
  ClaimQueued: ClaimQueuedEvent;
  ClaimPaid: ClaimPaidEvent;
  TicketClosed: TicketClosedEvent;
  SampleRecorded: SampleRecordedEvent;
  BuybackExecuted: BuybackExecutedEvent;
  FeesWithdrawn: FeesWithdrawnEvent;
  HoldingsRegistered: HoldingsRegisteredEvent;
  Locked: LockedEvent;
  Skimmed: SkimmedEvent;
}
export type EventName = keyof EventMap;
export type FumpadEvent = { [K in EventName]: { name: K; data: EventMap[K]; program: "fumpad" | "locker"; index: number; topIx: number } }[EventName];

/** `TicketClosed.final_status` / TicketStatus enum order. */
export const TICKET_STATUS_NAMES = ["open", "queued", "claimed", "expired", "voided"] as const;

// ── Transaction shape (RPC `getTransaction` JSON, web3.js object, or Helius raw webhook) ──

interface CompiledIx {
  programIdIndex: number;
  accounts?: number[];
  accountKeyIndexes?: number[];
  data: string | Uint8Array;
}
export interface TxLike {
  slot: number;
  blockTime?: number | null;
  transaction: {
    signatures: string[];
    message: unknown;
  };
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    innerInstructions?: { index: number; instructions: CompiledIx[] }[] | null;
    loadedAddresses?: { writable: (string | PublicKey)[]; readonly: (string | PublicKey)[] } | null;
  } | null;
}

const toB58 = (k: string | PublicKey | { toBase58(): string }) => (typeof k === "string" ? k : k.toBase58());

/** Full account-key list (static + ALT-loaded writable + readonly) as base58 strings. */
export function accountKeys(tx: TxLike): string[] {
  const m = tx.transaction.message as Record<string, unknown>;
  const stat = ((m.staticAccountKeys ?? m.accountKeys) as (string | PublicKey | { pubkey: string })[]) ?? [];
  const keys = stat.map((k) => (typeof k === "object" && k && "pubkey" in k ? toB58((k as { pubkey: string }).pubkey) : toB58(k as string)));
  const la = tx.meta?.loadedAddresses;
  if (la) keys.push(...la.writable.map(toB58), ...la.readonly.map(toB58));
  return keys;
}

/** Top-level compiled instructions (programId, account indexes, data bytes). */
export function topLevelInstructions(tx: TxLike): { programId: string; accounts: number[]; data: Uint8Array }[] {
  const keys = accountKeys(tx);
  const m = tx.transaction.message as Record<string, unknown>;
  const ixs = ((m.compiledInstructions ?? m.instructions) as CompiledIx[]) ?? [];
  return ixs.map((i) => ({
    programId: keys[i.programIdIndex],
    accounts: i.accountKeyIndexes ?? i.accounts ?? [],
    data: typeof i.data === "string" ? bs58.decode(i.data) : i.data,
  }));
}

function startsWith(d: Uint8Array, prefix: Uint8Array) {
  if (d.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (d[i] !== prefix[i]) return false;
  return true;
}
const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");

/** Decode one emit_cpi payload (bytes after EVENT_IX_TAG). */
export function decodeCpiEvent(payload: Uint8Array): { name: string; data: unknown } | null {
  const ev = fumpadCoder().events.decode(b64(payload));
  return ev ? { name: ev.name, data: normalize(ev.data) } : null;
}

/**
 * All FUMPAD + locker events of a successful transaction, in execution order per
 * top-level instruction. Failed transactions emit nothing (their state changes reverted).
 */
export function decodeTransactionEvents(tx: TxLike): FumpadEvent[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = accountKeys(tx);
  const fumpad = FUMPAD_PROGRAM_ID.toBase58();
  const evAuth = eventAuthorityPda().toBase58();
  const out: FumpadEvent[] = [];
  let index = 0;

  const byTop = new Map<number, FumpadEvent[]>();
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== fumpad) continue;
      const data = typeof ix.data === "string" ? bs58.decode(ix.data) : ix.data;
      if (!startsWith(data, EVENT_IX_TAG)) continue;
      const accts = ix.accounts ?? ix.accountKeyIndexes ?? [];
      if (accts.length < 1 || keys[accts[0]] !== evAuth) continue;
      const ev = decodeCpiEvent(data.subarray(8));
      if (!ev) continue;
      const list = byTop.get(group.index) ?? [];
      list.push({ name: ev.name, data: ev.data, program: "fumpad", index: 0, topIx: group.index } as FumpadEvent);
      byTop.set(group.index, list);
    }
  }

  // Locker `emit!` events from logs, attributed via the invoke stack.
  const locker = LP_LOCKER_PROGRAM_ID.toBase58();
  const stack: string[] = [];
  let top = -1;
  for (const line of tx.meta.logMessages ?? []) {
    const inv = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (inv) {
      if (inv[2] === "1") top += 1;
      stack.push(inv[1]);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith("Program data: ") && stack[stack.length - 1] === locker) {
      const ev = lockerCoder().events.decode(line.slice("Program data: ".length));
      if (!ev) continue;
      const list = byTop.get(top) ?? [];
      list.push({ name: ev.name, data: normalize(ev.data), program: "locker", index: 0, topIx: top } as FumpadEvent);
      byTop.set(top, list);
    }
  }

  for (const t of [...byTop.keys()].sort((a, b) => a - b)) {
    for (const e of byTop.get(t)!) out.push({ ...e, index: index++ } as FumpadEvent);
  }
  return out;
}

/** True if any instruction (top-level or inner) of the tx invokes `program`. */
export function txInvokes(tx: TxLike, program: PublicKey | string): boolean {
  const id = typeof program === "string" ? program : program.toBase58();
  const keys = accountKeys(tx);
  if (topLevelInstructions(tx).some((i) => i.programId === id)) return true;
  for (const g of tx.meta?.innerInstructions ?? []) for (const i of g.instructions) if (keys[i.programIdIndex] === id) return true;
  return false;
}
