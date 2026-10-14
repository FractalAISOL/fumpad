/** Account decoders for fumpad v0.7: Anchor borsh accounts via the IDL, zero-copy accounts by hand. */
import { PublicKey } from "@solana/web3.js";

import { normalize } from "./borsh.js";
import { FUMPAD_IDL, fumpadCoder } from "./coder.js";
import { BPS_DENOM, CLAIM_QUEUE_CAPACITY, FEE_POLICY, OBSERVATION_CAPACITY, PREGRAD_MIN_SAMPLES, PREGRAD_MIN_SPAN_SECS, PREGRAD_RING_LEN, PREGRAD_WINDOW_SECS } from "./constants.js";
import { FumpadDecodeError, idlStructFields, idlTypeSize, type LegacyLayout, pickLayout, widen } from "./layouts.js";
import { type Params, paramsFromIdl } from "./params.js";

export type CoinStatus = "curve" | "complete" | "graduated";
export type TicketStatus = "open" | "queued" | "claimed" | "expired" | "voided" | "escrowed";
export type TicketSource = "outside" | "router";
export const TICKET_STATUS_NAMES: readonly TicketStatus[] = ["open", "queued", "claimed", "expired", "voided", "escrowed"];

export interface RewardTerms {
  triggerMultipleBps: number;
  claimBps: number;
  maxClaimPoolBps: number;
  minSellUsdCents: bigint;
  minHoldSecs: bigint;
  rebuyWindowSecs: bigint;
  claimWindowSecs: bigint;
  maxOpenTickets: number;
}
export interface FeeSplitBps {
  buybackBps: number;
  platformBps: number;
  creatorBps: number;
}

/**
 * A config's fee policy (INTERFACE §5.9): `kind` 0 standard (Params split, launch window → buyback) or 1 wallet split
 * (our claimed fees split `buybackShare : walletShare` between the coin's buyback and `wallet`; launch window → 100%
 * wallet; no platform / creator). `maxCoins` 0 = unlimited.
 */
export interface FeePolicy {
  kind: number;
  buybackShare: number;
  walletShare: number;
  maxCoins: number;
  wallet: PublicKey;
}
export const STANDARD_FEE_POLICY: FeePolicy = Object.freeze({ kind: FEE_POLICY.standard, buybackShare: 0, walletShare: 0, maxCoins: 0, wallet: PublicKey.default });

/** Mirror of `FeePolicy::is_valid` (the program also refuses a wallet that is one of fumpad's PDAs). */
export function feePolicyProblems(p: FeePolicy): string[] {
  const out: string[] = [];
  if (p.kind === FEE_POLICY.standard) {
    if (p.buybackShare || p.walletShare || !p.wallet.equals(PublicKey.default)) out.push("standard policy: shares must be 0 and wallet unset");
  } else if (p.kind === FEE_POLICY.walletSplit) {
    if (p.wallet.equals(PublicKey.default)) out.push("wallet-split policy needs a wallet");
    if (p.walletShare <= 0) out.push("walletShare must be > 0");
    if (BigInt(p.buybackShare + p.walletShare) > BPS_DENOM) out.push("buybackShare + walletShare must be ≤ 10,000");
  } else out.push(`unknown policy kind ${p.kind}`);
  if (p.maxCoins < 0 || p.maxCoins > 0xffff) out.push("maxCoins out of u16 range");
  return out;
}

/** Split of one claim under a wallet-split policy: wallet = ⌊claimed × walletShare / (buyback + wallet)⌋, buyback the rest. */
export function walletSplit(claimed: bigint, p: Pick<FeePolicy, "buybackShare" | "walletShare">): { buyback: bigint; wallet: bigint } {
  const den = BigInt(p.buybackShare + p.walletShare);
  const wallet = den === 0n ? 0n : (claimed * BigInt(p.walletShare)) / den;
  return { buyback: claimed - wallet, wallet };
}

export interface GlobalAccount {
  bump: number;
  admin: PublicKey;
  platformTreasury: PublicKey;
  guardian: PublicKey;
  keepers: PublicKey[];
  keeperAddedAt: bigint[];
  clusterTag: number;
  paused: number;
  pauseExpiresAt: bigint;
  params: Params;
  pendingParams: Params;
  pendingEta: bigint;
  pendingAdmin: PublicKey;
  pendingTreasury: PublicKey;
  pendingGuardian: PublicKey;
  pendingAdminEta: bigint;
  configs: PublicKey[];
  pendingConfig: PublicKey;
  pendingConfigAdd: number;
  pendingConfigEta: bigint;
  /** Jobs keys (samples, claim_for, pre-grad buybacks); disjoint from `keepers`. Default key = empty slot. */
  operators: PublicKey[];
  /** Fee policy of each allow-list slot (same index as `configs`). */
  configPolicies: FeePolicy[];
  /** Coins registered on each slot since it was allow-listed (enforces `maxCoins`). */
  configCoins: number[];
  pendingConfigPolicy: FeePolicy;
}

/** The allow-list slot (policy + coins registered) of `config`, or null when it isn't allow-listed. */
export function configSlot(g: Pick<GlobalAccount, "configs" | "configPolicies" | "configCoins">, config: PublicKey): { index: number; policy: FeePolicy; coins: number } | null {
  if (config.equals(PublicKey.default)) return null;
  const index = g.configs.findIndex((c) => c.equals(config));
  return index < 0 ? null : { index, policy: g.configPolicies[index], coins: g.configCoins[index] };
}

export interface CoinAccount {
  bump: number;
  status: CoinStatus;
  launchFeesSettled: boolean;
  mint: PublicKey;
  creator: PublicKey;
  dbcPool: PublicKey;
  dbcConfig: PublicKey;
  dammPool: PublicKey;
  dammPosition: PublicKey;
  launchSlot: bigint;
  launchWindowSlots: bigint;
  createdAt: bigint;
  completedAt: bigint;
  graduatedAt: bigint;
  totalSupply: bigint;
  creatorFeesUnclaimed: bigint;
  platformFeesUnclaimed: bigint;
  buybackLamports: bigint;
  feesClaimedLamports: bigint;
  buybackSpentLamports: bigint;
  buybackTokens: bigint;
  routerVolumeLamports: bigint;
  routerTradeCount: bigint;
  ticketsCreated: bigint;
  tokensPaidOut: bigint;
  rewards: RewardTerms;
  feeSplit: FeeSplitBps;
  /** Rate-cap leaky bucket (INTERFACE §5.3): time at which the coin's attested backlog drains. */
  attestCursor: bigint;
  attestTokensTotal: bigint;
  attestReleasedTokens: bigint;
  /** Latest keeper pre-grad sample (also in `pregradRing`). */
  pregradSamplePriceQ64: bigint;
  pregradSampleTs: bigint;
  migrator: PublicKey;
  migratorCost: bigint;
  migrationFeeLamports: bigint;
  leftoverTokens: bigint;
  /** L5: last PREGRAD_RING_LEN keeper pre-grad samples (see `pregradMedianQ64`). */
  pregradRing: PregradRing;
  /** Fee policy kind snapshotted at registration (`FEE_POLICY`); non-zero → `feePolicy` (the account's tail) holds it and `feeSplit` is unused (zero). */
  feePolicyKind: number;
  /**
   * Wallet-split coins only: the policy snapshotted at `register_coin` — the tail appended to the Coin account
   * (`COIN_POLICY_TAIL_OFFSET`, 47 bytes: FeePolicy 39 + wallet_paid u64) — and what it has paid the wallet so far.
   */
  feePolicy?: FeePolicy;
  walletPaidLamports?: bigint;
}

/** Offset of a wallet-split coin's policy tail (= the standard Coin account length) and its length. */
export const COIN_ACCOUNT_LEN = 546;
export const COIN_POLICY_TAIL_LEN = 47;

/** L5: ring of keeper pre-graduation DBC spot samples (prices Q64.64 saturated to u64; ts unix seconds). */
export interface PregradRing {
  pricesQ64: bigint[];
  ts: number[];
  head: number;
  len: number;
}

export interface PositionAccount {
  bump: number;
  wallet: PublicKey;
  mint: PublicKey;
  nextTicketSeq: bigint;
  openTickets: PublicKey[];
  openCount: number;
  autoClaimOptOut: number;
  rentPayer: PublicKey;
  ticketsCreated: bigint;
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
  escrowPayer: PublicKey;
  source: TicketSource;
  /** 0 DBC, 1 DAMM v2 */
  venue: number;
  /** EFFECTIVE attestation time (may be in the future when the rate cap deferred it); challenge window runs from it. */
  attestedAt: bigint;
  rentPayer: PublicKey;
  consumed: PublicKey;
}

export interface ConsumedAccount {
  bump: number;
  /** 0 sell, 1 rebuy, 2 sell reopened by the guardian (one corrected attestation allowed) */
  kind: number;
  ticket: PublicKey;
  rentPayer: PublicKey;
  blockTime: bigint;
  /** sell markers: sha256(message)[..16] of the attestation that created / last re-used it */
  messageHash: number[];
}

type AccountName = "Global" | "Coin" | "Position" | "Ticket" | "Consumed";
const accountLens = new Map<string, number>();
/** Current borsh length (discriminator included) of an Anchor account, from the IDL. */
export function accountLen(name: AccountName): number {
  let n = accountLens.get(name);
  if (n === undefined) accountLens.set(name, (n = 8 + idlStructFields(FUMPAD_IDL, name).reduce((s, f) => s + idlTypeSize(FUMPAD_IDL, f.type), 0)));
  return n;
}
/**
 * Historical account layouts (layouts.ts): fields appended at the end by a later program version; the older account
 * reads with them zero. Coin's optional policy tail is handled in `decodeCoin`.
 */
const ACCOUNT_LEGACY: Partial<Record<AccountName, { label: string; appended: string[] }>> = {
  // 2026-10-14 fee policies: Global 1,044 → 1,491 (`migrate_global` grows it in place, new bytes zero)
  Global: { label: "pre-fee-policy Global", appended: ["config_policies", "config_coins", "pending_config_policy", "reserved"] },
  // c9be557 (L-2): + message_hash; zero = no hash recorded (older markers are sell / rebuy only, never reopened)
  Consumed: { label: "pre-L-2 Consumed", appended: ["message_hash"] },
};
const accountLegacy = new Map<string, LegacyLayout[]>();
function legacyAccountLayouts(name: AccountName): LegacyLayout[] {
  let out = accountLegacy.get(name);
  if (out) return out;
  out = [];
  const spec = ACCOUNT_LEGACY[name];
  if (spec) {
    const fields = idlStructFields(FUMPAD_IDL, name);
    const tail = fields.slice(fields.length - spec.appended.length);
    if (tail.map((f) => f.name).join() !== spec.appended.join()) throw new Error(`IDL ${name}: expected trailing fields ${spec.appended.join(", ")}`);
    const bytes = tail.reduce((s, f) => s + idlTypeSize(FUMPAD_IDL, f.type), 0);
    out.push({ label: spec.label, at: accountLen(name) - bytes, bytes });
  }
  accountLegacy.set(name, out);
  return out;
}

/** Decode an Anchor account in its current or a known historical layout; anything else throws FumpadDecodeError. */
const decode = <T>(name: AccountName, data: Uint8Array): T => {
  const legacy = pickLayout("account", name, data.length, accountLen(name), legacyAccountLayouts(name));
  const bytes = legacy ? widen(data, legacy) : data;
  try {
    return normalize(fumpadCoder().accounts.decode(name, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) as T;
  } catch (e) {
    throw new FumpadDecodeError(`account ${name}: ${String(e).slice(0, 200)}`);
  }
};
const strip = <T>(o: T & { reserved?: unknown }): T => {
  delete (o as { reserved?: unknown }).reserved;
  return o;
};

/** Global account length (with discriminator) since the fee policies (2026-10-14); the previous layout was 1,044 bytes. */
export const GLOBAL_ACCOUNT_LEN = 1_491;
export const GLOBAL_ACCOUNT_LEN_V1 = 1_044;

/**
 * Decode Global. A pre-fee-policy Global (1,044 bytes, before `migrate_global` grew it) decodes with its new tail read
 * as zero — standard policies, no coin counts, nothing pending — exactly what `migrate_global` writes.
 */
export function decodeGlobal(data: Uint8Array): GlobalAccount {
  const g = decode<Record<string, unknown>>("Global", data);
  return strip({
    ...(g as unknown as GlobalAccount),
    params: paramsFromIdl(g.params as Record<string, unknown>),
    pendingParams: paramsFromIdl(g.pendingParams as Record<string, unknown>),
  });
}
/** Decode a Coin (+ its fee-policy tail when `feePolicyKind != 0`: kind u8, buyback u16, wallet u16, max u16, wallet, paid u64). */
export function decodeCoin(data: Uint8Array): CoinAccount {
  // 546 B standard coin, 593 B with the policy tail (only ever created for a non-standard policy).
  const tail = data.length === COIN_ACCOUNT_LEN + COIN_POLICY_TAIL_LEN;
  const c = strip(decode<CoinAccount>("Coin", tail ? data.subarray(0, COIN_ACCOUNT_LEN) : data));
  if (!!c.feePolicyKind !== tail) {
    throw new FumpadDecodeError(`account Coin ${c.mint.toBase58()}: fee_policy_kind ${c.feePolicyKind} with ${data.length} bytes (corrupt: a policy tail exists iff the kind is non-standard)`);
  }
  if (tail) {
    const o = COIN_ACCOUNT_LEN;
    const v = new DataView(data.buffer, data.byteOffset + o, COIN_POLICY_TAIL_LEN);
    c.feePolicy = { kind: data[o], buybackShare: v.getUint16(1, true), walletShare: v.getUint16(3, true), maxCoins: v.getUint16(5, true), wallet: new PublicKey(data.subarray(o + 7, o + 39)) };
    c.walletPaidLamports = v.getBigUint64(39, true);
  }
  return c;
}
export const decodePosition = (data: Uint8Array): PositionAccount => strip(decode<PositionAccount>("Position", data));
export const decodeTicket = (data: Uint8Array): TicketAccount => strip(decode<TicketAccount>("Ticket", data));
export const decodeConsumed = (data: Uint8Array): ConsumedAccount => decode<ConsumedAccount>("Consumed", data);

export function accountDiscriminator(name: "Global" | "Coin" | "Position" | "Ticket" | "Consumed" | "Observations" | "ClaimQueue"): Uint8Array {
  const a = (FUMPAD_IDL as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((x) => x.name === name);
  if (!a) throw new Error(`no account ${name}`);
  return Uint8Array.from(a.discriminator);
}

/** Are `flag`'s pause bits in force at `now` (pauses lapse at pause_expires_at, D25)? */
export function isPaused(g: Pick<GlobalAccount, "paused" | "pauseExpiresAt">, flag: number, now: bigint | number): boolean {
  return (g.paused & flag) !== 0 && BigInt(now) < g.pauseExpiresAt;
}

/**
 * Active keepers at `now`: in the set and past their 6 h attestation freeze, or bootstrap keepers set by
 * `initialize_global` (`keeper_added_at == 0`: no freeze; `set_keepers` never stores 0).
 */
export function activeKeepers(g: Pick<GlobalAccount, "keepers" | "keeperAddedAt">, now: bigint | number, freezeSecs = 6n * 3_600n): PublicKey[] {
  return g.keepers.filter((k, i) => !k.equals(PublicKey.default) && (g.keeperAddedAt[i] === 0n || BigInt(now) >= g.keeperAddedAt[i] + freezeSecs));
}

/** Is `key` one of Global's operators (jobs keys: samples, claim_for, pre-graduation buybacks)? */
export function isOperator(g: Pick<GlobalAccount, "operators">, key: PublicKey): boolean {
  return !key.equals(PublicKey.default) && (g.operators ?? []).some((o) => o.equals(key));
}
/** Is `key` one of Global's attestor keys (`keepers`)? */
export function isAttestor(g: Pick<GlobalAccount, "keepers">, key: PublicKey): boolean {
  return !key.equals(PublicKey.default) && (g.keepers ?? []).some((k) => k.equals(key));
}
/** The on-chain role of `key`: "operator" (jobs), "attestor", "both" (only transiently after `migrate_global`), or null. */
export function keyRole(g: Pick<GlobalAccount, "keepers" | "operators">, key: PublicKey): "operator" | "attestor" | "both" | null {
  const op = isOperator(g, key);
  const at = isAttestor(g, key);
  return op && at ? "both" : op ? "operator" : at ? "attestor" : null;
}

// ── zero-copy ───────────────────────────────────────────────────────────────
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const pk = (d: Uint8Array, off: number) => new PublicKey(d.subarray(off, off + 32));
const u128 = (v: DataView, off: number) => v.getBigUint64(off, true) | (v.getBigUint64(off + 8, true) << 64n);

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
  keeperSampled: boolean;
  lastKeeperSampleTs: bigint;
  /** Oldest first. */
  samples: Observation[];
}
/** `Observations` (bytemuck): 8 disc | mint | pool | head u16 | len u16 | bump | keeper_sampled | pad2 | last_keeper i64 | 256 × {ts i64, fallback u64, price u128}. */
export function decodeObservations(data: Uint8Array): ObservationsAccount {
  const v = dv(data);
  const head = v.getUint16(8 + 64, true);
  const len = Math.min(v.getUint16(8 + 66, true), OBSERVATION_CAPACITY);
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
/** `ClaimQueue` (bytemuck): 8 disc | mint | len u16 | bump | pad5 | total_owed u64 | 1024 × {ticket, owner, amount u64, sell_ts i64}. */
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

/** SPL / Token-2022 token account base layout (mint, owner, amount). */
export function decodeTokenAccount(data: Uint8Array): { mint: PublicKey; owner: PublicKey; amount: bigint } {
  if (data.length < 72) throw new Error("not a token account");
  return { mint: pk(data, 0), owner: pk(data, 32), amount: dv(data).getBigUint64(64, true) };
}

/**
 * Port of PregradRing::median_q64 (L5): median of the ring samples with ts in [now − 300, now] (even count: mean of
 * the two middle values), or null unless ≥ 4 of them span ≥ 60 s. The pre-grad buyback guard price.
 */
export function pregradMedianQ64(ring: PregradRing, now: bigint): bigint | null {
  const prices: bigint[] = [];
  let lo: bigint | null = null;
  let hi: bigint | null = null;
  for (let i = 0; i < Math.min(ring.len, PREGRAD_RING_LEN); i++) {
    const ts = BigInt(ring.ts[i]);
    if (ts > now || now - ts > BigInt(PREGRAD_WINDOW_SECS)) continue;
    prices.push(ring.pricesQ64[i]);
    lo = lo === null || ts < lo ? ts : lo;
    hi = hi === null || ts > hi ? ts : hi;
  }
  if (prices.length < PREGRAD_MIN_SAMPLES || hi! - lo! < BigInt(PREGRAD_MIN_SPAN_SECS)) return null;
  prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = prices.length;
  return n % 2 === 1 ? prices[(n - 1) / 2] : (prices[n / 2 - 1] + prices[n / 2]) / 2n;
}

export const COVERAGE_BUCKETS = 6n;
export const MIN_COVERED_BUCKETS = 5;

/**
 * Port of Observations::median_price_q64: median (lower middle) of KEEPER samples with ts in
 * (now − window, now], or null unless ≥ minSamples of them cover ≥ 5 of the window's 6 buckets.
 */
export function medianPriceQ64(obs: Pick<ObservationsAccount, "samples">, now: bigint, windowSecs: bigint, minSamples: number): bigint | null {
  const cutoff = now - windowSecs;
  let bucketSecs = windowSecs / COVERAGE_BUCKETS;
  if (bucketSecs < 1n) bucketSecs = 1n;
  const prices: bigint[] = [];
  let buckets = 0;
  for (const s of obs.samples) {
    if (!s.fallback && s.ts > cutoff && s.ts <= now) {
      prices.push(s.priceQ64);
      let b = (now - s.ts) / bucketSecs;
      if (b > COVERAGE_BUCKETS - 1n) b = COVERAGE_BUCKETS - 1n;
      buckets |= 1 << Number(b);
    }
  }
  let covered = 0;
  for (let b = buckets; b; b >>= 1) covered += b & 1;
  if (prices.length === 0 || prices.length < minSamples || covered < MIN_COVERED_BUCKETS) return null;
  prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return prices[Math.floor((prices.length - 1) / 2)];
}
