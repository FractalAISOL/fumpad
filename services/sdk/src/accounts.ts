/** Account decoders: Anchor borsh accounts via the IDL, zero-copy + foreign layouts by hand. */
import { PublicKey } from "@solana/web3.js";

import { normalize } from "./borsh.js";
import { fumpadCoder, lockerCoder } from "./coder.js";
import { CLAIM_QUEUE_CAPACITY, MAX_KEEPERS, OBSERVATION_CAPACITY, PUMPSWAP_POOL_DISCRIMINATOR } from "./constants.js";
import { paramsFromIdl } from "./instructions/fumpad.js";
import type { Params } from "./params.js";
import type { SnipeConfig } from "./math/fees.js";
import type { ReferencePrice } from "./math/reference.js";

export type CoinStatus = "curve" | "complete" | "graduated";
export type TicketStatus = "open" | "queued" | "claimed" | "expired" | "voided" | "escrowed";

/** D14 per-coin fee snapshot (`Coin.fees`). */
export interface CoinFees {
  graduationFeeLamports: bigint;
  feeBps: number;
  feePoolShareBps: number;
  feePlatformShareBps: number;
  feeCreatorShareBps: number;
}

export interface CoinAccount {
  bump: number;
  mint: PublicKey;
  creator: PublicKey;
  status: CoinStatus;
  createdAt: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  completedAt: bigint;
  graduatedAt: bigint;
  ammPool: PublicKey;
  creatorFeesUnclaimed: bigint;
  platformFeesUnclaimed: bigint;
  buybackLamports: bigint;
  volumeLamports: bigint;
  tradeCount: bigint;
  ticketsCreated: bigint;
  tokensPaidOut: bigint;
  reference: ReferencePrice;
  /** D14: fee params snapshotted at create_coin — use these, not Global.params. */
  fees: CoinFees;
  /** D19 (v0.5): launch slot + snipe-tax schedule snapshotted at create_coin (zeros = none). */
  snipe: SnipeConfig;
}

export interface GlobalAccount {
  bump: number;
  admin: PublicKey;
  platformTreasury: PublicKey;
  keepers: PublicKey[];
  paused: number;
  params: Params;
  /** D15: queued params change (valid when pendingEta ≠ 0). */
  pendingParams: Params;
  pendingEta: bigint;
  /**
   * v0.5: the account still has a pre-v0.5 layout (672 bytes) — the program was upgraded (or
   * not yet) without `migrate_global`. Appended params decode as 0 (snipe tax off, which is what
   * a pre-v0.5 program does).
   */
  legacyLayout?: boolean;
}

export interface PositionAccount {
  bump: number;
  wallet: PublicKey;
  mint: PublicKey;
  matured: bigint;
  pending: bigint;
  pendingSince: bigint;
  nextTicketSeq: bigint;
  openTickets: PublicKey[];
  openCount: number;
  /** v0.3 R-L2: canonical-ATA balance at FUMPAD's last observation. */
  lastBalance: bigint;
  /** v0.4 D17: 0 = keeper auto-claim on (default), 1 = opted out. */
  autoClaimOptOut: number;
}

export interface TicketAccount {
  bump: number;
  owner: PublicKey;
  mint: PublicKey;
  seq: bigint;
  tokens: bigint;
  originalTokens: bigint;
  sellPriceQ64: bigint;
  sellUsdCents: bigint;
  sellTs: bigint;
  status: TicketStatus;
  queuedAt: bigint;
  claimAmount: bigint;
  claimedAt: bigint;
  /** D16: rent payer of this ticket's escrow (refunded by withdraw_escrow). */
  escrowPayer: PublicKey;
}

export interface LockAccount {
  bump: number;
  pool: PublicKey;
  mint: PublicKey;
  lpMint: PublicKey;
  lpVault: PublicKey;
  baseDest: PublicKey;
  quoteDest: PublicKey;
  principalNum: bigint;
  lpSupplyAtLock: bigint;
  lpLocked: bigint;
  lockedAt: bigint;
  lpSkimmed: bigint;
  baseSkimmed: bigint;
  quoteSkimmed: bigint;
}

const strip = <T>(o: unknown, drop: string[] = ["reserved"]): T => {
  const x = normalize(o) as Record<string, unknown>;
  for (const k of drop) delete x[k];
  return x as T;
};

export function decodeCoin(data: Uint8Array): CoinAccount {
  return strip<CoinAccount>(fumpadCoder().accounts.decode("Coin", Buffer.from(data)));
}
// ── Global layout versions (mirrors contracts `instructions/admin/migrate_global.rs`) ──
/** Bytes before `Global.params` (discriminator, bump, admin, treasury, keepers, paused). */
const GLOBAL_PARAMS_OFFSET = 8 + 1 + 32 + 32 + 32 * MAX_KEEPERS + 1;
const GLOBAL_RESERVED_LEN = 128;
/** Serialized `Params` length, current (v0.5) and older layouts `migrate_global` upgrades. */
export const PARAMS_LEN = 187;
export const LEGACY_PARAMS_LENS = [183] as const;
const globalLen = (paramsLen: number) => GLOBAL_PARAMS_OFFSET + 2 * paramsLen + GLOBAL_RESERVED_LEN + 8;
/** Current Global account size (v0.5: 680 bytes). */
export const GLOBAL_ACCOUNT_LEN = globalLen(PARAMS_LEN);

/** True if `data` is an older Global layout that `migrate_global` must upgrade. */
export function globalNeedsMigration(data: Uint8Array): boolean {
  return data.length !== GLOBAL_ACCOUNT_LEN && LEGACY_PARAMS_LENS.some((p) => globalLen(p) === data.length);
}

/**
 * The bytes of a legacy Global in the current layout, with the appended `Params` fields zeroed in
 * both copies (read-side only; on chain `migrate_global` sets them from its args).
 */
export function upgradeLegacyGlobal(data: Uint8Array): Uint8Array {
  const p = LEGACY_PARAMS_LENS.find((x) => globalLen(x) === data.length);
  if (p === undefined) throw new Error(`unknown Global layout (${data.length} bytes)`);
  const pad = new Uint8Array(PARAMS_LEN - p);
  const o = GLOBAL_PARAMS_OFFSET;
  const pend = o + p + GLOBAL_RESERVED_LEN;
  const parts = [data.subarray(0, o + p), pad, data.subarray(o + p, pend + p), pad, data.subarray(pend + p)];
  const out = new Uint8Array(GLOBAL_ACCOUNT_LEN);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Decode Global; tolerates the pre-v0.5 672-byte layout (`legacyLayout: true`). */
export function decodeGlobal(data: Uint8Array): GlobalAccount {
  const legacy = globalNeedsMigration(data);
  const bytes = legacy ? upgradeLegacyGlobal(data) : data;
  const g = strip<Record<string, unknown>>(fumpadCoder().accounts.decode("Global", Buffer.from(bytes)));
  return {
    ...(g as unknown as GlobalAccount),
    ...(legacy ? { legacyLayout: true } : {}),
    params: paramsFromIdl(g.params as Record<string, unknown>),
    pendingParams: paramsFromIdl(g.pendingParams as Record<string, unknown>),
  };
}
export function decodePosition(data: Uint8Array): PositionAccount {
  const p = strip<PositionAccount>(fumpadCoder().accounts.decode("Position", Buffer.from(data)));
  return { ...p, openTickets: p.openTickets.filter((k) => !k.equals(PublicKey.default)) };
}
export function decodeTicket(data: Uint8Array): TicketAccount {
  return strip<TicketAccount>(fumpadCoder().accounts.decode("Ticket", Buffer.from(data)));
}
export function decodeLock(data: Uint8Array): LockAccount {
  return strip<LockAccount>(lockerCoder().accounts.decode("Lock", Buffer.from(data)), []);
}

/** Anchor account discriminator for a fumpad account type (for getProgramAccounts filters). */
export function accountDiscriminator(name: "Coin" | "Global" | "Position" | "Ticket" | "Observations" | "ClaimQueue"): Uint8Array {
  return fumpadCoder().accounts.accountDiscriminator(name);
}

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const pk = (d: Uint8Array, off: number) => new PublicKey(d.subarray(off, off + 32));
const u128 = (v: DataView, off: number) => v.getBigUint64(off, true) | (v.getBigUint64(off + 8, true) << 64n);
const i128 = (v: DataView, off: number) => {
  const u = u128(v, off);
  return u >= 1n << 127n ? u - (1n << 128n) : u;
};

export interface Observation {
  ts: bigint;
  fallback: boolean;
  priceQ64: bigint;
}
export interface ObservationsAccount {
  mint: PublicKey;
  pool: PublicKey;
  head: number;
  len: number;
  /** 1 once a keeper sample exists (else lastKeeperSampleTs = init time / fallback grace start). */
  keeperSampled: boolean;
  lastKeeperSampleTs: bigint;
  /** Valid samples in ring order (oldest first). */
  samples: Observation[];
}

/** Zero-copy `Observations` (repr C): 8 disc | mint | pool | head u16 | len u16 | bump | keeper_sampled | pad2 | last_keeper i64 | 256 × 32B. */
export function decodeObservations(data: Uint8Array): ObservationsAccount {
  const v = dv(data);
  const head = v.getUint16(8 + 64, true);
  const len = v.getUint16(8 + 66, true);
  const base = 8 + 80;
  const samples: Observation[] = [];
  const start = len < OBSERVATION_CAPACITY ? 0 : head;
  for (let k = 0; k < len; k++) {
    const i = (start + k) % OBSERVATION_CAPACITY;
    const off = base + i * 32;
    samples.push({ ts: v.getBigInt64(off, true), fallback: v.getBigUint64(off + 8, true) !== 0n, priceQ64: u128(v, off + 16) });
  }
  return { mint: pk(data, 8), pool: pk(data, 40), head, len, keeperSampled: data[8 + 69] !== 0, lastKeeperSampleTs: v.getBigInt64(8 + 72, true), samples };
}

export interface QueueEntry {
  ticket: PublicKey;
  owner: PublicKey;
  amount: bigint;
  sellTs: bigint;
}
export interface ClaimQueueAccount {
  mint: PublicKey;
  len: number;
  totalOwed: bigint;
  entries: QueueEntry[];
}

/** Zero-copy `ClaimQueue`: 8 disc | mint | len u16 | bump | pad5 | total_owed u64 | 1024 × 80B (v0.4). */
export function decodeClaimQueue(data: Uint8Array): ClaimQueueAccount {
  const v = dv(data);
  const len = Math.min(v.getUint16(40, true), CLAIM_QUEUE_CAPACITY);
  const entries: QueueEntry[] = [];
  for (let i = 0; i < len; i++) {
    const off = 56 + i * 80;
    entries.push({ ticket: pk(data, off), owner: pk(data, off + 32), amount: v.getBigUint64(off + 64, true), sellTs: v.getBigInt64(off + 72, true) });
  }
  return { mint: pk(data, 8), len, totalOwed: v.getBigUint64(48, true), entries };
}

export interface PumpPool {
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
  virtualQuoteReserves: bigint;
}

/** PumpSwap `Pool` (offsets per external/pumpswap.rs). */
export function decodePumpPool(data: Uint8Array): PumpPool {
  if (data.length < 211) throw new Error("not a PumpSwap pool (short)");
  for (let i = 0; i < 8; i++) if (data[i] !== PUMPSWAP_POOL_DISCRIMINATOR[i]) throw new Error("not a PumpSwap pool");
  const v = dv(data);
  return {
    creator: pk(data, 11),
    baseMint: pk(data, 43),
    quoteMint: pk(data, 75),
    lpMint: pk(data, 107),
    poolBaseTokenAccount: pk(data, 139),
    poolQuoteTokenAccount: pk(data, 171),
    lpSupply: v.getBigUint64(203, true),
    virtualQuoteReserves: data.length >= 261 ? i128(v, 245) : 0n,
  };
}

/** SPL / Token-2022 token account (base layout): mint, owner, amount. */
export function decodeTokenAccount(data: Uint8Array): { mint: PublicKey; owner: PublicKey; amount: bigint } {
  if (data.length < 165) throw new Error("not a token account");
  return { mint: pk(data, 0), owner: pk(data, 32), amount: dv(data).getBigUint64(64, true) };
}

export interface PythPrice {
  feedId: string;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  fullyVerified: boolean;
}

/** Pyth PriceUpdateV2 (external/pyth.rs layout). */
export function decodePythPriceUpdate(data: Uint8Array): PythPrice {
  const v = dv(data);
  const level = data[40];
  const m = level === 1 ? 41 : 42;
  const feedId = Array.from(data.subarray(m, m + 32), (x) => x.toString(16).padStart(2, "0")).join("");
  return {
    feedId,
    price: v.getBigInt64(m + 32, true),
    conf: v.getBigUint64(m + 40, true),
    exponent: v.getInt32(m + 48, true),
    publishTime: v.getBigInt64(m + 52, true),
    fullyVerified: level === 1,
  };
}

/** Conservative (price − conf) SOL/USD as a float, for display. */
export function pythUsd(p: PythPrice): number {
  return Number(p.price - p.conf) * 10 ** p.exponent;
}
