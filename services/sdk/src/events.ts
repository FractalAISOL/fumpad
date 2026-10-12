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
import { FUMPAD_IDL, fumpadCoder, lockerCoder } from "./coder.js";
import { EVENT_IX_TAG, FUMPAD_PROGRAM_ID, LP_LOCKER_PROGRAM_ID } from "./constants.js";
import { eventAuthorityPda } from "./pda.js";

// ── Event payloads (normalized: camelCase, bigint, PublicKey) ───────────────

export interface CoinCreatedEvent { mint: PublicKey; creator: PublicKey; name: string; symbol: string; uri: string; ts: bigint }
export interface TradeEvent {
  mint: PublicKey; user: PublicKey; isBuy: boolean; onAmm: boolean; tokenAmount: bigint; solAmount: bigint;
  feePool: bigint; feePlatform: bigint; feeCreator: bigint; poolTokensBought: bigint; priceQ64: bigint;
  virtualSolReserves: bigint; virtualTokenReserves: bigint; ts: bigint;
  /** D19 (v0.5): snipe tax (lamports, to the reward pool, on top of the normal fee); 0 outside the launch window. */
  snipeTax: bigint;
  /** D19: tax rate applied, bps of (solAmount + snipeTax). Total charged = solAmount + fees + snipeTax. */
  snipeTaxBps: number;
}
export interface CurveCompletedEvent { mint: PublicKey; ts: bigint }
/** v0.5 D20: the graduation fee = callerRefund + setupPrefunded (observations + claim-queue rent) + platformFee. */
export interface GraduatedEvent {
  mint: PublicKey; pool: PublicKey; solDeposited: bigint; tokensDeposited: bigint; lpLocked: bigint; ts: bigint;
  callerRefund: bigint; setupPrefunded: bigint; platformFee: bigint;
}
export interface LpFeesSettledEvent { mint: PublicKey; lamports: bigint; platform: bigint; creator: bigint; ts: bigint }
export interface TicketCreatedEvent { mint: PublicKey; owner: PublicKey; ticket: PublicKey; tokens: bigint; sellPriceQ64: bigint; sellUsdCents: bigint; ts: bigint }
export interface TicketDebitedEvent { ticket: PublicKey; debited: bigint; remaining: bigint; voided: boolean; ts: bigint }
/** v0.4: `triggeredBy` = owner (claim), keeper (claim_for) or cranker (process_queue). */
export interface ClaimQueuedEvent { mint: PublicKey; ticket: PublicKey; owner: PublicKey; amount: bigint; queueLen: number; ts: bigint; triggeredBy: PublicKey }
export interface ClaimPaidEvent { mint: PublicKey; ticket: PublicKey; owner: PublicKey; amount: bigint; fromQueue: boolean; medianPriceQ64: bigint; ts: bigint; triggeredBy: PublicKey }
export interface TicketClosedEvent { ticket: PublicKey; owner: PublicKey; finalStatus: number; ts: bigint }
export interface SampleRecordedEvent { mint: PublicKey; priceQ64: bigint; fallback: boolean; ts: bigint }
export interface BuybackExecutedEvent { mint: PublicKey; lamportsIn: bigint; tokensOut: bigint; ts: bigint }
export interface FeesWithdrawnEvent { mint: PublicKey; recipient: PublicKey; lamports: bigint; creator: boolean; ts: bigint }
export interface HoldingsRegisteredEvent { mint: PublicKey; wallet: PublicKey; added: bigint; ts: bigint }
// v0.3
export interface ParamsQueuedEvent { params: Record<string, unknown>; eta: bigint; ts: bigint }
export interface ParamsUpdatedEvent { params: Record<string, unknown>; ts: bigint }
export interface ParamsCancelledEvent { ts: bigint }
export interface CurveReopenedEvent { mint: PublicKey; completedAt: bigint; ts: bigint }
export interface ClaimEscrowedEvent { mint: PublicKey; ticket: PublicKey; owner: PublicKey; escrow: PublicKey; amount: bigint; ts: bigint; triggeredBy: PublicKey }
// v0.4
export interface AutoClaimSetEvent { mint: PublicKey; wallet: PublicKey; enabled: boolean; ts: bigint }
export interface EscrowWithdrawnEvent { mint: PublicKey; ticket: PublicKey; owner: PublicKey; destination: PublicKey; amount: bigint; ts: bigint }
// v0.5
/** `migrate_global` grew a legacy Global (old → new length; the appended params it set). */
export interface GlobalMigratedEvent { oldLen: number; newLen: number; snipeWindowSlots: number; snipeStartBps: number; rentPaid: bigint; ts: bigint }
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
  ParamsQueued: ParamsQueuedEvent;
  ParamsUpdated: ParamsUpdatedEvent;
  ParamsCancelled: ParamsCancelledEvent;
  CurveReopened: CurveReopenedEvent;
  ClaimEscrowed: ClaimEscrowedEvent;
  EscrowWithdrawn: EscrowWithdrawnEvent;
  AutoClaimSet: AutoClaimSetEvent;
  GlobalMigrated: GlobalMigratedEvent;
  Locked: LockedEvent;
  Skimmed: SkimmedEvent;
}
export type EventName = keyof EventMap;
/**
 * One decoded event. `raw` = base64 of discriminator ‖ borsh body (what `decodeEventRaw`
 * takes), so an indexer can store it and re-decode on replay.
 */
export type FumpadEvent = {
  [K in EventName]: {
    name: K; data: EventMap[K]; program: "fumpad" | "locker"; index: number; topIx: number; raw: string;
    /** Emitted by an older program in a shorter layout; fields added since decode as 0 (see LEGACY_EVENT_PADS). */
    legacy?: true;
  };
}[EventName];

/** `TicketClosed.final_status` / TicketStatus enum order. */
export const TICKET_STATUS_NAMES = ["open", "queued", "claimed", "expired", "voided", "escrowed"] as const;

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
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    preBalances?: number[];
    postBalances?: number[];
  } | null;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/**
 * Per-owner token balance change of `mint` in a transaction (post − pre), from the
 * RPC's pre/postTokenBalances. Used to see PumpSwap trades that bypass FUMPAD.
 */
export function tokenDeltas(tx: TxLike, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (list: TokenBalance[] | null | undefined, sign: bigint) => {
    for (const b of list ?? []) {
      if (b.mint !== mint || !b.owner) continue;
      out.set(b.owner, (out.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
    }
  };
  add(tx.meta?.postTokenBalances, 1n);
  add(tx.meta?.preTokenBalances, -1n);
  for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
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

// ── Older event layouts ─────────────────────────────────────────────────────
// Fields are only ever appended to an event (or to `Params`, which ParamsQueued/ParamsUpdated
// embed first). A payload from an older program (the live devnet program until it's upgraded,
// and all history before an upgrade) is too short for the current IDL; it decodes after zero
// bytes are inserted where the fields were added. Zero = "absent": no snipe tax (pre-v0.5 had
// none), Graduated split fields 0 (unknown), snipe params 0.

/** Per event: where bytes were inserted in the body (after the discriminator), oldest change first. */
export const LEGACY_EVENT_PADS: Partial<Record<EventName, { at: number | "end"; bytes: number }[]>> = {
  Trade: [{ at: "end", bytes: 10 }], // v0.5: snipe_tax u64, snipe_tax_bps u16
  Graduated: [{ at: "end", bytes: 24 }], // v0.5: caller_refund, setup_prefunded, platform_fee
  ParamsQueued: [{ at: 183, bytes: 4 }], // v0.5: Params + snipe_window_slots, snipe_start_bps
  ParamsUpdated: [{ at: 183, bytes: 4 }],
};

let discNames: { name: EventName; disc: Uint8Array }[] | undefined;
function eventNameOf(payload: Uint8Array): EventName | undefined {
  discNames ??= ((FUMPAD_IDL as unknown as { events?: { name: string; discriminator: number[] }[] }).events ?? []).map((e) => ({
    name: e.name as EventName,
    disc: Uint8Array.from(e.discriminator),
  }));
  return discNames.find((e) => startsWith(payload, e.disc))?.name;
}

/** Bytes of a legacy payload in the current layout (zero-filled), or null if no known upgrade applies. */
export function upgradeLegacyEventPayload(payload: Uint8Array): Uint8Array | null {
  const name = eventNameOf(payload);
  const pads = name && LEGACY_EVENT_PADS[name];
  if (!pads) return null;
  let body = payload.subarray(8);
  for (const p of pads) {
    const at = p.at === "end" ? body.length : p.at;
    if (at > body.length) return null;
    const next = new Uint8Array(body.length + p.bytes);
    next.set(body.subarray(0, at), 0);
    next.set(body.subarray(at), at + p.bytes);
    body = next;
  }
  const out = new Uint8Array(8 + body.length);
  out.set(payload.subarray(0, 8), 0);
  out.set(body, 8);
  return out;
}

/**
 * Strict decode: the body must be exactly one event in the current layout. (Anchor's decoder
 * doesn't check: a u64 read past the end of a short buffer silently yields a truncated number,
 * so a short legacy payload can "decode" to garbage. Re-encoding pins the length.)
 */
function decodeExact(payload: Uint8Array): { ok: true; ev: { name: string; data: unknown } | null } | { ok: false; err: unknown } {
  try {
    const ev = fumpadCoder().events.decode(b64(payload));
    if (!ev) return { ok: true, ev: null };
    const len = fumpadCoder().types.encode(ev.name, ev.data).length;
    if (len !== payload.length - 8) return { ok: false, err: new Error(`${ev.name}: body is ${payload.length - 8} bytes, layout needs ${len}`) };
    return { ok: true, ev };
  } catch (err) {
    return { ok: false, err };
  }
}

/** Decode fumpad event bytes (discriminator ‖ borsh body), current or legacy layout. */
function decodeFumpadBytes(payload: Uint8Array): { name: string; data: unknown; legacy?: true } | null {
  const cur = decodeExact(payload);
  if (cur.ok) return cur.ev ? { name: cur.ev.name, data: normalize(cur.ev.data) } : null;
  const up = upgradeLegacyEventPayload(payload);
  if (!up) throw cur.err;
  const old = decodeExact(up);
  if (!old.ok) throw cur.err;
  return old.ev ? { name: old.ev.name, data: normalize(old.ev.data), legacy: true } : null;
}

/** Decode one emit_cpi payload (bytes after EVENT_IX_TAG). Tolerates older (shorter) layouts. */
export function decodeCpiEvent(payload: Uint8Array): { name: string; data: unknown; legacy?: true } | null {
  return decodeFumpadBytes(payload);
}

/** Re-decode a stored `FumpadEvent.raw` (legacy layouts too). */
export function decodeEventRaw(program: "fumpad" | "locker", raw: string): { name: EventName; data: EventMap[EventName]; legacy?: true } | null {
  if (program === "fumpad") return decodeFumpadBytes(Buffer.from(raw, "base64")) as { name: EventName; data: EventMap[EventName]; legacy?: true } | null;
  const ev = lockerCoder().events.decode(raw);
  return ev ? { name: ev.name as EventName, data: normalize(ev.data) as EventMap[EventName] } : null;
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
      const payload = data.subarray(8);
      const ev = decodeCpiEvent(payload);
      if (!ev) continue;
      const list = byTop.get(group.index) ?? [];
      list.push({ name: ev.name, data: ev.data, program: "fumpad", index: 0, topIx: group.index, raw: b64(payload), ...(ev.legacy ? { legacy: true } : {}) } as FumpadEvent);
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
      const raw = line.slice("Program data: ".length);
      const ev = lockerCoder().events.decode(raw);
      if (!ev) continue;
      const list = byTop.get(top) ?? [];
      list.push({ name: ev.name, data: normalize(ev.data), program: "locker", index: 0, topIx: top, raw } as FumpadEvent);
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
