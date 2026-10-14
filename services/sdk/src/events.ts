/**
 * fumpad v0.7 event decoding. Every event is an `emit_cpi!` self-CPI: an inner instruction to fumpad
 * whose first account is fumpad's `__event_authority` PDA (only fumpad can sign it; Anchor's handler
 * rejects the tag otherwise) and whose data = EVENT_IX_TAG ‖ discriminator ‖ borsh(event). Logs are never
 * used. Field names are camelCase; integers ≥ 64 bits are bigint; pubkeys are PublicKey.
 */
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { normalize } from "./borsh.js";
import { FUMPAD_IDL, fumpadCoder } from "./coder.js";
import { EVENT_IX_TAG, FUMPAD_PROGRAM_ID } from "./constants.js";
import { FumpadDecodeError, idlStructFields, idlTypeSize, type LegacyLayout, pickLayout, widen } from "./layouts.js";
import { coinPda, eventAuthorityPda } from "./pda.js";

type PK = PublicKey;
export interface FeePolicyData { kind: number; buybackShare: number; walletShare: number; maxCoins: number; wallet: PK }
export interface CoinRegisteredEvent { mint: PK; creator: PK; dbcPool: PK; dbcConfig: PK; launchSlot: bigint; launchWindowSlots: bigint; ts: bigint; feePolicy: FeePolicyData }
export interface RoutedTradeEvent { mint: PK; trader: PK; venue: number; isBuy: boolean; baseAmount: bigint; quoteGross: bigint; fee: bigint; preSqrtPrice: bigint; postSqrtPrice: bigint; slot: bigint; ts: bigint }
export interface CurveCompletedEvent { mint: PK; dbcPool: PK; ts: bigint }
/** `toWallet` / `feeWallet`: wallet-split policy coins (0 / default otherwise). toBuyback + toPlatform + toCreator + toWallet = claimed. */
export interface FeesClaimedEvent { mint: PK; venue: number; claimed: bigint; toBuyback: bigint; toPlatform: bigint; toCreator: bigint; launchWindow: boolean; ts: bigint; toWallet: bigint; feeWallet: PK }
export interface FeesWithdrawnEvent { mint: PK; recipient: PK; lamports: bigint; creator: boolean; ts: bigint }
export interface BuybackExecutedEvent { mint: PK; venue: number; lamportsIn: bigint; tokensOut: bigint; guardPriceQ64: bigint; spotPriceQ64: bigint; ts: bigint }
export interface PoolMigratedEvent { mint: PK; dammPool: PK; migrator: PK; cost: bigint; ts: bigint }
export interface GraduatedEvent {
  mint: PK; dammPool: PK; dammPosition: PK; leftoverTokens: bigint; migrationFee: bigint; surplus: bigint; migratorRefund: bigint;
  callerRefund: bigint; setupPrefunded: bigint; platformFee: bigint; ts: bigint;
}
export interface SampleRecordedEvent { mint: PK; venue: number; priceQ64: bigint; fallback: boolean; ts: bigint }
export interface TicketAttestedEvent {
  mint: PK; owner: PK; ticket: PK; seq: bigint; pool: PK; venue: number; source: number; signature: number[]; ixKey: number;
  baseAmount: bigint; quoteGross: bigint; tokens: bigint; sellPriceQ64: bigint; sellUsdCents: bigint; pythPublishTime: bigint; slot: bigint;
  sellTs: bigint; keepers: PK[]; submitter: PK; ts: bigint;
  /** Effective attestation time (= Ticket.attested_at; later than `ts` when the rate cap deferred the ticket). */
  effectiveAt: bigint;
}
export interface TicketDebitedEvent { ticket: PK; mint: PK; owner: PK; signature: number[]; ixKey: number; debited: bigint; remaining: bigint; voided: boolean; ts: bigint }
export interface TicketVoidedEvent { ticket: PK; mint: PK; owner: PK; reason: number; authority: PK; ts: bigint; coin: PK; reopened: boolean }
export interface ConsumedClosedEvent { consumed: PK; ticket: PK; rentPayer: PK; ts: bigint }
export interface ClaimQueuedEvent { mint: PK; ticket: PK; owner: PK; amount: bigint; queueLen: number; ts: bigint; triggeredBy: PK }
export interface ClaimPaidEvent { mint: PK; ticket: PK; owner: PK; amount: bigint; fromQueue: boolean; medianPriceQ64: bigint; ts: bigint; triggeredBy: PK }
export interface ClaimEscrowedEvent { mint: PK; ticket: PK; owner: PK; escrow: PK; amount: bigint; ts: bigint; triggeredBy: PK }
export interface EscrowWithdrawnEvent { mint: PK; ticket: PK; owner: PK; destination: PK; amount: bigint; ts: bigint }
export interface TicketClosedEvent { ticket: PK; owner: PK; finalStatus: number; rentPayer: PK; ts: bigint }
export interface PositionClosedEvent { mint: PK; wallet: PK; ts: bigint }
export interface AutoClaimSetEvent { mint: PK; wallet: PK; enabled: boolean; ts: bigint }
export interface PauseSetEvent { paused: number; expiresAt: bigint; authority: PK; ts: bigint }
export interface KeepersSetEvent { keepers: PK[]; addedAt: bigint[]; ts: bigint }
export interface ConfigUpdatedEvent { config: PK; add: boolean; ts: bigint; policy: FeePolicyData }
export interface ConfigQueuedEvent { config: PK; add: boolean; eta: bigint; ts: bigint; policy: FeePolicyData }
export interface OperatorsSetEvent { operators: PK[]; ts: bigint }
export interface UnregisteredFeesClaimedEvent { mint: PK; dbcPool: PK; dbcConfig: PK; claimed: bigint; platformTreasury: PK; ts: bigint }
export interface PositionRewardClaimedEvent {
  mint: PK; dammPool: PK; dammPosition: PK; rewardIndex: number; rewardMint: PK; destination: PK; amount: bigint; toRewardPool: boolean; ts: bigint;
}

export interface EventMap {
  CoinRegistered: CoinRegisteredEvent;
  RoutedTrade: RoutedTradeEvent;
  CurveCompleted: CurveCompletedEvent;
  FeesClaimed: FeesClaimedEvent;
  FeesWithdrawn: FeesWithdrawnEvent;
  BuybackExecuted: BuybackExecutedEvent;
  PoolMigrated: PoolMigratedEvent;
  Graduated: GraduatedEvent;
  SampleRecorded: SampleRecordedEvent;
  TicketAttested: TicketAttestedEvent;
  TicketDebited: TicketDebitedEvent;
  TicketVoided: TicketVoidedEvent;
  ConsumedClosed: ConsumedClosedEvent;
  ClaimQueued: ClaimQueuedEvent;
  ClaimPaid: ClaimPaidEvent;
  ClaimEscrowed: ClaimEscrowedEvent;
  EscrowWithdrawn: EscrowWithdrawnEvent;
  TicketClosed: TicketClosedEvent;
  PositionClosed: PositionClosedEvent;
  AutoClaimSet: AutoClaimSetEvent;
  PauseSet: PauseSetEvent;
  KeepersSet: KeepersSetEvent;
  ConfigUpdated: ConfigUpdatedEvent;
  ConfigQueued: ConfigQueuedEvent;
  OperatorsSet: OperatorsSetEvent;
  UnregisteredFeesClaimed: UnregisteredFeesClaimedEvent;
  PositionRewardClaimed: PositionRewardClaimedEvent;
}
/** Typed events; every other IDL event (governance) decodes generically. */
export type EventName = keyof EventMap;

export interface FumpadEvent<K extends string = string> {
  name: K;
  data: K extends keyof EventMap ? EventMap[K] : Record<string, unknown>;
  /** Position among the tx's fumpad events (0-based, execution order). */
  index: number;
  /** Top-level instruction that emitted it. */
  topIx: number;
  /** base64(discriminator ‖ borsh) — re-decodable with decodeEventRaw. */
  raw: string;
}

// ── tx shape (json / jsonParsed / web3.js) ──────────────────────────────────
interface CompiledIx {
  programIdIndex: number;
  accounts?: number[];
  accountKeyIndexes?: number[];
  data: string | Uint8Array;
}
export interface TxLike {
  slot: number;
  blockTime?: number | null;
  transaction: { signatures: string[]; message: unknown };
  meta: {
    err: unknown;
    innerInstructions?: { index: number; instructions: CompiledIx[] }[] | null;
    loadedAddresses?: { writable: (string | PublicKey)[]; readonly: (string | PublicKey)[] } | null;
    preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null;
    postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null;
    logMessages?: string[] | null;
    preBalances?: number[];
    postBalances?: number[];
    fee?: number;
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

/** Top-level compiled instructions (programId, account indexes, data). */
export function topLevelInstructions(tx: TxLike): { programId: string; accounts: number[]; data: Uint8Array }[] {
  const keys = accountKeys(tx);
  const m = tx.transaction.message as Record<string, unknown>;
  const ixs = ((m.compiledInstructions ?? m.instructions) as CompiledIx[]) ?? [];
  return ixs.map((i) => ({ programId: keys[i.programIdIndex], accounts: i.accountKeyIndexes ?? i.accounts ?? [], data: typeof i.data === "string" ? bs58.decode(i.data) : i.data }));
}

const startsWith = (d: Uint8Array, p: Uint8Array) => d.length >= p.length && p.every((x, i) => d[i] === x);
const b64 = (d: Uint8Array) => {
  let s = "";
  for (const x of d) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let discs: { name: string; disc: Uint8Array }[] | undefined;
export function eventNameOf(payload: Uint8Array): string | undefined {
  discs ??= ((FUMPAD_IDL as unknown as { events?: { name: string; discriminator: number[] }[] }).events ?? []).map((e) => ({ name: e.name, disc: Uint8Array.from(e.discriminator) }));
  return discs.find((e) => startsWith(payload, e.disc))?.name;
}

// ── historical layouts (layouts.ts) ───────────────────────────────────────
/** Fields appended to an event by a later program version (current layout = the IDL's). */
const APPENDED_FIELDS: Record<string, string[]> = {
  CoinRegistered: ["fee_policy"],
  FeesClaimed: ["to_wallet", "fee_wallet"],
  ConfigQueued: ["policy"],
  ConfigUpdated: ["policy"],
  TicketAttested: ["effective_at"],
  TicketVoided: ["coin", "reopened"],
};
/** Events embedding `Params`, which gained a trailing `launch_signer` (pubkey) inside the event. */
const PARAMS_EVENTS = ["GlobalInitialized", "ParamsQueued", "ParamsUpdated"];

/** Defaults of fields an older layout lacks, beyond the zero bytes `widen` inserts (layouts.ts). */
const LEGACY_DEFAULTS: Record<string, (d: Record<string, unknown>) => void> = {
  // effective_at = Ticket.attested_at = ts before the rate cap could defer a ticket
  TicketAttested: (d) => void (d.effectiveAt = d.ts),
  // the voided ticket's coin = the coin PDA of the event's mint (= the ticket's mint); reopen did not exist
  TicketVoided: (d) => {
    d.coin = coinPda(d.mint as PublicKey);
    d.reopened = false;
  },
  // zero bytes already are the other defaults: FeePolicy 0… = standard, to_wallet 0 / fee_wallet default, launch_signer default
};

export interface EventLayouts {
  /** Current payload length (discriminator included). */
  current: number;
  legacy: LegacyLayout[];
}
let layouts: Map<string, EventLayouts> | undefined;
/** Known payload layouts per event name (current + historical), checked against the IDL and unambiguous. */
export function eventLayouts(): Map<string, EventLayouts> {
  if (layouts) return layouts;
  const idl = FUMPAD_IDL;
  const m = new Map<string, EventLayouts>();
  for (const e of (idl as unknown as { events: { name: string }[] }).events) {
    const fields = idlStructFields(idl, e.name);
    const sizes = fields.map((f) => idlTypeSize(idl, f.type));
    const current = 8 + sizes.reduce((a, b) => a + b, 0);
    const legacy: LegacyLayout[] = [];
    const appended = APPENDED_FIELDS[e.name];
    if (appended) {
      const tail = fields.slice(fields.length - appended.length).map((f) => f.name);
      if (tail.join() !== appended.join()) throw new Error(`IDL ${e.name}: expected trailing fields ${appended.join(", ")} (got ${tail.join(", ")})`);
      const bytes = sizes.slice(fields.length - appended.length).reduce((a, b) => a + b, 0);
      legacy.push({ label: `without ${appended.join(", ")}`, at: current - bytes, bytes });
    }
    if (PARAMS_EVENTS.includes(e.name)) {
      const i = fields.findIndex((f) => f.name === "params");
      const pf = idlStructFields(idl, "Params");
      if (i < 0 || pf[pf.length - 1].name !== "launch_signer") throw new Error(`IDL ${e.name}: Params.launch_signer expected last`);
      legacy.push({ label: "Params without launch_signer", at: 8 + sizes.slice(0, i + 1).reduce((a, b) => a + b, 0) - 32, bytes: 32 });
    }
    if (new Set([current, ...legacy.map((l) => current - l.bytes)]).size !== legacy.length + 1) throw new Error(`IDL ${e.name}: ambiguous historical layouts`);
    m.set(e.name, { current, legacy });
  }
  return (layouts = m);
}

/**
 * Decode discriminator ‖ borsh (the `raw` of an event). null for events not in the IDL. Every historical layout of
 * the event decodes (layouts.ts), its missing fields set to their documented defaults; a payload matching no known
 * layout throws `FumpadDecodeError` (fail closed).
 */
export function decodeEventRaw(raw: string | Uint8Array): { name: string; data: Record<string, unknown> } | null {
  let bytes = typeof raw === "string" ? unb64(raw) : raw;
  const name = eventNameOf(bytes);
  if (!name) return null;
  const l = eventLayouts().get(name)!;
  const legacy = pickLayout("event", name, bytes.length, l.current, l.legacy);
  if (legacy) bytes = widen(bytes, legacy);
  let ev: { name: string; data: unknown } | null;
  try {
    ev = fumpadCoder().events.decode(b64(bytes));
  } catch (e) {
    throw new FumpadDecodeError(`event ${name}: ${String(e).slice(0, 200)}`);
  }
  if (!ev || ev.name !== name) throw new FumpadDecodeError(`event ${name}: undecodable payload`);
  const data = normalize(ev.data) as Record<string, unknown>;
  if (legacy) LEGACY_DEFAULTS[name]?.(data);
  return { name, data };
}

/** Every fumpad event in a successful transaction, in execution order. Failed txs → []. */
export function decodeFumpadEvents(tx: TxLike): FumpadEvent[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = accountKeys(tx);
  const program = FUMPAD_PROGRAM_ID.toBase58();
  const authority = eventAuthorityPda().toBase58();
  const out: FumpadEvent[] = [];
  const groups = [...(tx.meta.innerInstructions ?? [])].sort((a, b) => a.index - b.index);
  for (const g of groups) {
    for (const i of g.instructions) {
      if (keys[i.programIdIndex] !== program) continue;
      const accs = i.accountKeyIndexes ?? i.accounts ?? [];
      if (keys[accs[0]] !== authority) continue;
      const data = typeof i.data === "string" ? bs58.decode(i.data) : i.data;
      if (!startsWith(data, EVENT_IX_TAG)) continue;
      const payload = data.subarray(8);
      const d = decodeEventRaw(payload);
      if (!d) continue;
      out.push({ name: d.name, data: d.data as never, index: out.length, topIx: g.index, raw: b64(payload) });
    }
  }
  return out;
}

export function eventsNamed<K extends EventName>(events: FumpadEvent[], name: K): FumpadEvent<K>[] {
  return events.filter((e) => e.name === name) as FumpadEvent<K>[];
}

/** Signature bytes of a TicketAttested / TicketDebited event as the base58 tx signature. */
export const eventSignature = (sig: number[] | Uint8Array): string => bs58.encode(Uint8Array.from(sig));
