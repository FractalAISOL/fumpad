/**
 * `parseMeteoraTrades(tx)`: every Meteora DBC / DAMM v2 swap in a confirmed transaction — direct or
 * nested by CPI inside any router / aggregator / trading-bot program — as an exact record.
 *
 * Source of truth = the programs' own `emit_cpi!` events (DBC `EvtSwap2` (+ the legacy `EvtSwap` it
 * emits alongside, cross-checked), `EvtCurveComplete`; DAMM v2 `EvtSwap2`), authenticated by:
 *   1. the event instruction is an inner instruction OF the program (program id = DBC/DAMM v2),
 *   2. its only account is the program's `__event_authority` PDA (only the program can sign as it),
 *   3. its CPI parent is a `swap`/`swap2` instruction OF THE SAME program (resolved by stack height).
 * The parent swap instruction supplies what the event leaves out (mints, user token accounts, payer,
 * referral account). Amounts are then cross-checked against the vault token-balance deltas of the
 * transaction; any disagreement rejects the swap (an `issue`, never a guessed record).
 *
 * See ATTESTATION.md for the trader definition and how keepers use these records.
 */
import {
  DAMM_V2_EVENT_AUTHORITY,
  DAMM_V2_POOL_AUTHORITY,
  DAMM_V2_PROGRAM_ID,
  DAMM_V2_SWAP_ACCOUNTS as DA,
  DBC_EVENT_AUTHORITY,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  DBC_SWAP_ACCOUNTS as DB,
  USDC_MINT,
  WSOL_MINT,
} from "./constants.js";
import { decodeEventPayload, EventDecodeError, eventPayload, instructionName, type Venue, venueOf } from "./decode.js";
import { appLabel, type AppLabel } from "./routers.js";
import { foreignVaultFlows } from "./vaultflow.js";
import { ancestors, type ConfirmedTx, type FlatIx, type NormalizedTx, normalizeTx, ownerDeltas, tokenDelta, TxShapeError } from "./tx.js";

export type Side = "buy" | "sell";

/**
 * How `trader` was determined (strongest first):
 *  - `base_owner_signer`: owner of the swap's base-side token account (sell: the input account, buy: the
 *    output account) and a signer of the transaction. Unambiguous.
 *  - `signer_net_base`: the base-side account is owned by someone else (a router PDA / intermediate
 *    account), and exactly ONE transaction signer has a net base-token change of the swap's sign for
 *    this mint. The signer is the beneficial trader.
 *  - `base_owner_unsigned`: the base-side owner did not sign and no unique signer moved the token
 *    (smart wallets / PDA vaults / programs, or several signers). `trader` = that owner; ambiguous.
 *  - `unknown`: the base-side account has no token-balance entry (created and closed inside the tx).
 */
export type TraderSource = "base_owner_signer" | "signer_net_base" | "base_owner_unsigned" | "unknown";

export interface FeeBreakdown {
  /** Which token the fee is charged in, and whether it was taken from the input or the output. */
  token: "base" | "quote";
  onInput: boolean;
  /** Total fee charged by the pool = lp/partner part + protocol + referral (+ compounding). */
  total: bigint;
  /** DBC `trading_fee` (partner + creator share) / DAMM v2 `claiming_fee` (LP-claimable). */
  trading: bigint;
  protocol: bigint;
  referral: bigint;
  /** DAMM v2 only (stays in the reserves of a Compounding pool); 0 for DBC. */
  compounding: bigint;
}

export interface MeteoraTrade {
  signature: string;
  slot: number;
  blockTime: number | null;
  venue: Venue;
  /**
   * Unique (with `signature`) and stable across RPC nodes: `(topIx << 16) | (innerIx + 1)` of the
   * swap instruction (innerIx = -1 for a top-level swap → low half 0). Inner-instruction lists are
   * part of the consensus-determined transaction status, so every keeper derives the same key.
   */
  ixKey: number;
  /** Top-level instruction index containing the swap. */
  topIx: number;
  /** Index of the swap instruction in meta.innerInstructions[topIx] (-1 = the swap IS the top-level instruction). */
  innerIx: number;
  /** CPI depth of the swap instruction (1 = called directly by the transaction). */
  stackHeight: number;
  pool: string;
  /** DBC: config key of the pool (from the event). DAMM v2: null (not part of the swap). */
  config: string | null;
  /** DBC: base_mint. DAMM v2: see `baseIsTokenA`. */
  baseMint: string;
  quoteMint: string;
  /**
   * DAMM v2 orientation (null for DBC): the base is the token in `opts.baseMints` if exactly one side is;
   * else the non-quote side when exactly one side is a known quote mint (WSOL, USDC, USDT);
   * else token A (the DBC-migration layout: launched token = A, quote = B).
   */
  baseIsTokenA: boolean | null;
  side: Side;
  trader: string | null;
  traderSource: TraderSource;
  /** Signer of the swap instruction (`payer` account: authority over the input token account). */
  swapAuthority: string;
  feePayer: string;
  signers: string[];
  inputTokenAccount: string;
  outputTokenAccount: string;
  inputOwner: string | null;
  outputOwner: string | null;
  /** Base tokens the trader sent (sell) or received (buy), raw units. */
  baseAmount: bigint;
  /**
   * Quote value at the pool price, BEFORE fees: sell → quote out + fees charged on it; buy → quote
   * that went into the curve after input fees. Ticket price = quoteGross / baseAmount (sells).
   */
  quoteGross: bigint;
  /** What the trader actually paid (buy, incl. fees) or received (sell, after fees), raw units. */
  quoteNet: bigint;
  /** Raw amounts as the program reports them (input/output token = per `side`). */
  amountIn: bigint;
  amountInAfterFee: bigint;
  amountOut: bigint;
  /** DAMM v2: Token-2022 transfer-fee adjusted amounts (equal to amountIn / amountOut otherwise). */
  amountInIncludingTransferFee: bigint;
  amountOutReceived: bigint;
  fee: FeeBreakdown;
  hasReferral: boolean;
  referralTokenAccount: string | null;
  referralOwner: string | null;
  /** 0 ExactIn, 1 PartialFill, 2 ExactOut. */
  swapMode: number;
  instruction: "swap" | "swap2";
  nextSqrtPrice: bigint;
  /** DBC: quote reserve after the swap + the pool's migration threshold. DAMM v2: reserves A/B after. */
  reserves: { quote?: bigint; migrationThreshold?: bigint; a?: bigint; b?: bigint };
  /** DBC: this swap filled the curve (EvtCurveComplete emitted under the same instruction). */
  curveComplete: { baseReserve: bigint; quoteReserve: bigint } | null;
  eventTimestamp: bigint;
  /** Program-level ancestors of the swap (top level first): routers/aggregators that CPI'd into it. */
  outerPrograms: string[];
  app: AppLabel;
  /** base64(discriminator ‖ borsh) of the primary event (re-decodable with decodeEventRaw). */
  eventRaw: string;
  eventName: string;
}

export type IssueCode =
  | "tx_shape"
  | "no_stack_heights"
  | "event_decode"
  | "event_without_swap_parent"
  | "unsupported_instruction"
  | "unsupported_event"
  | "pool_mismatch"
  | "missing_evt_swap2"
  | "evt_swap_mismatch"
  | "vault_mismatch"
  | "vault_mint_mismatch"
  | "direction_mismatch"
  | "accounts_short";

export interface ParseIssue {
  code: IssueCode;
  /** ixKey of the swap concerned, when known. */
  ixKey?: number;
  pool?: string;
  message: string;
}

export interface ParseResult {
  signature: string;
  slot: number;
  blockTime: number | null;
  version: number | "legacy";
  /** Failed transactions never yield trades (their state changes reverted). */
  status: "ok" | "failed" | "error";
  trades: MeteoraTrade[];
  /** Swaps (or the whole tx) that could not be turned into an exact, cross-checked record. */
  issues: ParseIssue[];
}

const keyOf = (ix: FlatIx) => (ix.topIx << 16) | (ix.innerIx + 1);
const u = (v: unknown) => v as bigint;

interface Pending {
  venue: Venue;
  swapIx: FlatIx;
  primary: { name: string; data: Record<string, unknown>; raw: string } | null;
  legacy: { name: string; data: Record<string, unknown> } | null;
  curveComplete: { baseReserve: bigint; quoteReserve: bigint } | null;
  issues: ParseIssue[];
}

export interface ParseOptions {
  /** Mints known to be the "base" (e.g. FUMPAD coins): orient DAMM v2 pools by them first. */
  baseMints?: ReadonlySet<string>;
  /** Quote mints for DAMM v2 orientation (default QUOTE_MINTS). */
  quoteMints?: ReadonlySet<string>;
}

/** Default quote-side mints for orienting DAMM v2 pools. */
export const QUOTE_MINTS: ReadonlySet<string> = new Set([
  WSOL_MINT,
  USDC_MINT,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export function dammBaseIsA(aMint: string, bMint: string, opts: ParseOptions = {}): boolean {
  const bases = opts.baseMints;
  if (bases && bases.has(aMint) !== bases.has(bMint)) return bases.has(aMint);
  const q = opts.quoteMints ?? QUOTE_MINTS;
  if (q.has(aMint) !== q.has(bMint)) return q.has(bMint);
  return true;
}

/** Parse every DBC / DAMM v2 swap of a confirmed transaction. Pure; never throws on chain data. */
export function parseMeteoraTrades(input: ConfirmedTx, opts: ParseOptions = {}): ParseResult {
  let tx: NormalizedTx;
  try {
    tx = normalizeTx(input);
  } catch (e) {
    const sig = input?.transaction?.signatures?.[0] ?? "";
    return { signature: sig, slot: input?.slot ?? 0, blockTime: input?.blockTime ?? null, version: "legacy", status: "error", trades: [], issues: [{ code: "tx_shape", message: e instanceof TxShapeError ? e.message : String(e) }] };
  }
  const base = { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, version: tx.version };
  if (tx.err) return { ...base, status: "failed", trades: [], issues: [] };

  const issues: ParseIssue[] = [];
  const pendings = new Map<number, Pending>(); // by swap ordinal
  /** DBC pools created in this tx (authenticated EvtInitializePool): their base vault was minted into in-tx. */
  const initializedPools = new Set<string>();

  for (const ix of tx.flat) {
    const venue = venueOf(ix.programId);
    if (!venue) continue;
    const payload = eventPayload(ix.data);
    if (!payload) continue;
    const authority = venue === "dbc" ? DBC_EVENT_AUTHORITY : DAMM_V2_EVENT_AUTHORITY;
    if (ix.accounts[0] !== authority) continue; // not a genuine emit_cpi (would have failed on-chain anyway)
    let ev;
    try {
      ev = decodeEventPayload(venue, payload);
    } catch (e) {
      issues.push({ code: "event_decode", message: e instanceof EventDecodeError ? e.message : String(e) });
      continue;
    }
    if (!ev) continue; // an event outside our subset (e.g. EvtClaimTradingFee)
    if (ev.name === "EvtInitializePool" && venue === "dbc") initializedPools.add(ev.data.pool as string);
    const isSwapEvent = ev.name === "EvtSwap" || ev.name === "EvtSwap2" || ev.name === "EvtCurveComplete";
    if (!isSwapEvent) continue;
    if (!tx.hasStackHeights) {
      issues.push({ code: "no_stack_heights", message: "inner instructions carry no stackHeight: CPI parents can't be resolved" });
      continue;
    }
    const parent = ix.parent === null ? null : tx.flat[ix.parent];
    const parentName = parent && parent.programId === ix.programId ? instructionName(venue, parent.data) : null;
    if (!parent || (parentName !== "swap" && parentName !== "swap2")) {
      issues.push({
        code: parentName === "swap2_with_transfer_hook" ? "unsupported_instruction" : "event_without_swap_parent",
        message: `${venue} ${ev.name} at ${ix.topIx}.${ix.innerIx}: parent is ${parent ? `${parent.programId}:${parentName ?? "?"}` : "none"}`,
      });
      continue;
    }
    const p = pendings.get(parent.ordinal) ?? { venue, swapIx: parent, primary: null, legacy: null, curveComplete: null, issues: [] };
    pendings.set(parent.ordinal, p);
    if (ev.name === "EvtSwap2") {
      if (p.primary) p.issues.push({ code: "unsupported_event", ixKey: keyOf(parent), message: "two EvtSwap2 under one swap instruction" });
      p.primary = ev;
    } else if (ev.name === "EvtSwap") p.legacy = ev;
    else p.curveComplete = { baseReserve: u(ev.data.base_reserve), quoteReserve: u(ev.data.quote_reserve) };
  }

  const trades: MeteoraTrade[] = [];
  for (const p of [...pendings.values()].sort((a, b) => a.swapIx.ordinal - b.swapIx.ordinal)) {
    const r = p.venue === "dbc" ? buildDbc(tx, p) : buildDamm(tx, p, opts);
    if ("trade" in r) trades.push(r.trade);
    else issues.push(...r.issues);
  }

  // Vault cross-check: per vault, the sum of the deltas the events imply PLUS every movement of that
  // vault not made by one of these swaps (vaultflow.ts — donations, the pool program's fee claims /
  // migration / leftover withdrawal, launch mints; V7-H2) must equal the observed token-balance delta.
  // Several swaps on one pool in a tx are summed. Anything still unexplained rejects those swaps with an
  // issue that names the pool (the engine scopes it to this tx).
  const expected = new Map<string, { delta: bigint; keys: number[]; mint: string; pool: string }>();
  const swapOrdinals = new Set<number>();
  for (const t of trades) {
    swapOrdinals.add((t as MeteoraTrade & { _vaults: VaultInfo })._vaults.swapOrdinal);
    for (const [vault, mint, d] of vaultDeltas(t)) {
      // A launch tx (pool init + first swaps): the base vault was created and minted the whole supply in
      // this tx, so its delta is supply − swaps. Its base leg can't be cross-checked; the quote vault (also
      // created here, starting at 0) still is.
      if (t.venue === "dbc" && mint === t.baseMint && initializedPools.has(t.pool) && tx.tokenBalances.get(vault)?.pre === null) continue;
      const e = expected.get(vault) ?? { delta: 0n, keys: [], mint, pool: t.pool };
      e.delta += d;
      e.keys.push(t.ixKey);
      expected.set(vault, e);
    }
  }
  const foreign = foreignVaultFlows(tx, new Set(expected.keys()), swapOrdinals);
  const rejected = new Set<number>();
  for (const [vault, e] of expected) {
    const bal = tx.tokenBalances.get(vault);
    const observed = tokenDelta(tx, vault);
    const f = foreign.get(vault) ?? { delta: 0n, synced: false, unknown: false };
    const explained = e.delta + f.delta;
    // SyncNative only ever raises a WSOL account's amount (lamports sent by plain system transfers,
    // possibly in earlier txs), so with one on the vault the observed delta may exceed what we can read.
    const ok = !f.unknown && (f.synced ? observed >= explained : observed === explained);
    if (bal && bal.mint !== e.mint) {
      for (const k of e.keys) rejected.add(k);
      issues.push({ code: "vault_mint_mismatch", ixKey: e.keys[0], pool: e.pool, message: `vault ${vault} holds ${bal.mint}, swap expects ${e.mint}` });
    } else if (!ok) {
      for (const k of e.keys) rejected.add(k);
      issues.push({
        code: "vault_mismatch",
        ixKey: e.keys[0],
        pool: e.pool,
        message: `vault ${vault}: events imply ${e.delta}, other movements ${f.delta}${f.unknown ? " + an unreadable token instruction" : ""}, token balances show ${observed}`,
      });
    }
  }
  return { ...base, status: "ok", trades: trades.filter((t) => !rejected.has(t.ixKey)).map(publicTrade), issues };
}

/** [vault, mint, expected delta] implied by one trade's event. */
function vaultDeltas(t: MeteoraTrade & { _vaults?: VaultInfo }): [string, string, bigint][] {
  const v = t._vaults!;
  const inMint = t.side === "sell" ? t.baseMint : t.quoteMint;
  const outMint = t.side === "sell" ? t.quoteMint : t.baseMint;
  const feeOnInVault = t.fee.token === (t.side === "sell" ? "base" : "quote");
  // Referral is paid out of the vault of the fee token (DBC process_swap / DAMM p_handle_swap).
  const refIn = t.referralTokenAccount && feeOnInVault ? t.fee.referral : 0n;
  const refOut = t.referralTokenAccount && !feeOnInVault ? t.fee.referral : 0n;
  const out: [string, string, bigint][] = [
    [v.inVault, inMint, v.inVaultReceived - refIn],
    [v.outVault, outMint, -t.amountOut - refOut],
  ];
  return out;
}

interface VaultInfo {
  /** `flat` ordinal of the swap instruction (its own token CPIs are not "other movements"). */
  swapOrdinal: number;
  inVault: string;
  outVault: string;
  /** What the input vault's balance grows by before referral (transfer-fee excluded). */
  inVaultReceived: bigint;
}

function resolveTrader(tx: NormalizedTx, side: Side, baseMint: string, baseAccount: string): { trader: string | null; source: TraderSource } {
  const owner = tx.tokenBalances.get(baseAccount)?.owner ?? null;
  if (owner && tx.signers.includes(owner)) return { trader: owner, source: "base_owner_signer" };
  const deltas = ownerDeltas(tx, baseMint);
  const cands = tx.signers.filter((s) => {
    const d = deltas.get(s) ?? 0n;
    return side === "sell" ? d < 0n : d > 0n;
  });
  if (cands.length === 1) return { trader: cands[0], source: "signer_net_base" };
  if (owner) return { trader: owner, source: "base_owner_unsigned" };
  return { trader: null, source: "unknown" };
}

function common(tx: NormalizedTx, p: Pending) {
  const outer = ancestors(tx, p.swapIx.ordinal);
  const outerPrograms = outer.map((i) => i.programId);
  return {
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    venue: p.venue,
    ixKey: keyOf(p.swapIx),
    topIx: p.swapIx.topIx,
    innerIx: p.swapIx.innerIx,
    stackHeight: p.swapIx.stackHeight,
    feePayer: tx.feePayer,
    signers: tx.signers,
    outerPrograms,
    app: appLabel(tx, outerPrograms),
  };
}

type Built = { trade: MeteoraTrade & { _vaults: VaultInfo } } | { issues: ParseIssue[] };

function buildDbc(tx: NormalizedTx, p: Pending): Built {
  const ixKey = keyOf(p.swapIx);
  const fail = (code: IssueCode, message: string, pool?: string): Built => ({ issues: [...p.issues, { code, ixKey, pool, message }] });
  if (p.issues.length) return { issues: p.issues };
  const a = p.swapIx.accounts;
  if (a.length < DB.program + 1) return fail("accounts_short", `dbc swap has ${a.length} accounts`);
  if (!p.primary) return fail("missing_evt_swap2", "dbc swap emitted no EvtSwap2 (older program version?)", a[DB.pool]);
  const e = p.primary.data;
  const pool = e.pool as string;
  if (pool !== a[DB.pool] || e.config !== a[DB.config]) return fail("pool_mismatch", `event pool/config ${pool}/${e.config} != instruction ${a[DB.pool]}/${a[DB.config]}`, pool);
  if (a[DB.poolAuthority] !== DBC_POOL_AUTHORITY) return fail("pool_mismatch", `pool authority ${a[DB.poolAuthority]}`, pool);
  const dir = Number(e.trade_direction); // 0 BaseToQuote (sell), 1 QuoteToBase (buy)
  if (dir !== 0 && dir !== 1) return fail("direction_mismatch", `trade_direction ${dir}`, pool);
  const side: Side = dir === 0 ? "sell" : "buy";
  const r = e.swap_result as Record<string, bigint>;
  const sp = e.swap_parameters as Record<string, unknown>;

  // EvtSwap (emitted alongside by the same instruction) must agree field by field.
  if (p.legacy) {
    const l = p.legacy.data;
    const lr = l.swap_result as Record<string, bigint>;
    const same =
      l.pool === pool &&
      Number(l.trade_direction) === dir &&
      l.amount_in === r.included_fee_input_amount &&
      lr.actual_input_amount === r.excluded_fee_input_amount &&
      lr.output_amount === r.output_amount &&
      lr.trading_fee === r.trading_fee &&
      lr.protocol_fee === r.protocol_fee &&
      lr.referral_fee === r.referral_fee &&
      lr.next_sqrt_price === r.next_sqrt_price;
    if (!same) return fail("evt_swap_mismatch", "EvtSwap disagrees with EvtSwap2", pool);
  }

  const total = r.trading_fee + r.protocol_fee + r.referral_fee;
  // Fee placement (DBC FeeMode::get_fee_mode): sells always pay in quote, out of the output;
  // buys pay in quote on the input (CollectFeeMode::QuoteToken) or in base on the output
  // (CollectFeeMode::OutputToken). The config's mode isn't in the tx, but it is observable: an input
  // fee is exactly included − excluded.
  const onInput = r.included_fee_input_amount !== r.excluded_fee_input_amount;
  if (onInput && r.included_fee_input_amount - r.excluded_fee_input_amount !== total)
    return fail("evt_swap_mismatch", `input fee ${r.included_fee_input_amount - r.excluded_fee_input_amount} != fee parts ${total}`, pool);
  if (onInput && side === "sell") return fail("direction_mismatch", "dbc sell with an input fee", pool);
  const feeToken: "base" | "quote" = side === "sell" ? "quote" : onInput ? "quote" : total > 0n ? "base" : "quote";

  const inputAcc = a[DB.inputTokenAccount];
  const outputAcc = a[DB.outputTokenAccount];
  const baseMint = a[DB.baseMint];
  const quoteMint = a[DB.quoteMint];
  // Direction cross-check: the program derives it from the input account's mint.
  const inMint = tx.tokenBalances.get(inputAcc)?.mint;
  if (inMint && inMint !== (side === "sell" ? baseMint : quoteMint)) return fail("direction_mismatch", `input account mint ${inMint} vs side ${side}`, pool);

  const amountIn = r.included_fee_input_amount;
  const amountOut = r.output_amount;
  const outBeforeFee = onInput ? amountOut : amountOut + total;
  const referral = a[DB.referralTokenAccount] === DBC_PROGRAM_ID ? null : a[DB.referralTokenAccount];
  if (!!referral !== Boolean(e.has_referral)) return fail("evt_swap_mismatch", `has_referral ${e.has_referral} vs referral account ${referral}`, pool);
  const baseAccount = side === "sell" ? inputAcc : outputAcc;
  const { trader, source } = resolveTrader(tx, side, baseMint, baseAccount);
  const baseVault = a[DB.baseVault];
  const quoteVault = a[DB.quoteVault];

  const trade: MeteoraTrade & { _vaults: VaultInfo } = {
    ...common(tx, p),
    pool,
    config: e.config as string,
    baseMint,
    quoteMint,
    side,
    trader,
    traderSource: source,
    swapAuthority: a[DB.payer],
    inputTokenAccount: inputAcc,
    outputTokenAccount: outputAcc,
    inputOwner: tx.tokenBalances.get(inputAcc)?.owner ?? null,
    outputOwner: tx.tokenBalances.get(outputAcc)?.owner ?? null,
    baseAmount: side === "sell" ? amountIn : amountOut,
    // buy: quote that reached the curve (after an input fee; = amountIn when the fee is in base)
    quoteGross: side === "sell" ? outBeforeFee : r.excluded_fee_input_amount,
    quoteNet: side === "sell" ? amountOut : amountIn,
    amountIn,
    amountInAfterFee: r.excluded_fee_input_amount,
    amountOut,
    amountInIncludingTransferFee: amountIn,
    amountOutReceived: amountOut,
    fee: { token: feeToken, onInput, total, trading: r.trading_fee, protocol: r.protocol_fee, referral: r.referral_fee, compounding: 0n },
    hasReferral: Boolean(e.has_referral),
    referralTokenAccount: referral,
    referralOwner: referral ? tx.tokenBalances.get(referral)?.owner ?? null : null,
    swapMode: Number(sp.swap_mode),
    instruction: instructionName("dbc", p.swapIx.data) as "swap" | "swap2",
    nextSqrtPrice: r.next_sqrt_price,
    reserves: { quote: u(e.quote_reserve_amount), migrationThreshold: u(e.migration_threshold) },
    curveComplete: p.curveComplete,
    eventTimestamp: u(e.current_timestamp),
    eventRaw: p.primary.raw,
    eventName: "EvtSwap2",
    baseIsTokenA: null,
    _vaults: { swapOrdinal: p.swapIx.ordinal, inVault: side === "sell" ? baseVault : quoteVault, outVault: side === "sell" ? quoteVault : baseVault, inVaultReceived: amountIn },
  };
  return { trade };
}

function buildDamm(tx: NormalizedTx, p: Pending, opts: ParseOptions): Built {
  const ixKey = keyOf(p.swapIx);
  const fail = (code: IssueCode, message: string, pool?: string): Built => ({ issues: [...p.issues, { code, ixKey, pool, message }] });
  if (p.issues.length) return { issues: p.issues };
  const a = p.swapIx.accounts;
  if (a.length < DA.program + 1) return fail("accounts_short", `damm_v2 swap has ${a.length} accounts`);
  if (p.curveComplete || p.legacy) return fail("unsupported_event", "unexpected DAMM v2 event under a swap");
  if (!p.primary) return fail("missing_evt_swap2", "damm_v2 swap emitted no EvtSwap2", a[DA.pool]);
  const e = p.primary.data;
  const pool = e.pool as string;
  if (pool !== a[DA.pool]) return fail("pool_mismatch", `event pool ${pool} != instruction ${a[DA.pool]}`, pool);
  if (a[DA.poolAuthority] !== DAMM_V2_POOL_AUTHORITY) return fail("pool_mismatch", `pool authority ${a[DA.poolAuthority]}`, pool);
  const dir = Number(e.trade_direction); // 0 AtoB, 1 BtoA
  if (dir !== 0 && dir !== 1) return fail("direction_mismatch", `trade_direction ${dir}`, pool);
  const cfm = Number(e.collect_fee_mode); // 0 BothToken, 1 OnlyB, 2 Compounding
  if (cfm < 0 || cfm > 2) return fail("direction_mismatch", `collect_fee_mode ${cfm}`, pool);
  const aMint = a[DA.tokenAMint];
  const bMint = a[DA.tokenBMint];
  const baseIsA = dammBaseIsA(aMint, bMint, opts);
  const baseMint = baseIsA ? aMint : bMint;
  const quoteMint = baseIsA ? bMint : aMint;
  // input = A on AtoB; selling = the input is the base token
  const side: Side = (dir === 0) === baseIsA ? "sell" : "buy";
  // DAMM v2 FeeMode::get_fee_mode: (BothToken, BtoA) -> fee on output A; (OnlyB|Compounding, BtoA) -> fee
  // on input B; every AtoB -> fee on output B.
  const onInput = dir === 1 && cfm !== 0;
  const feeOnA = dir === 1 && cfm === 0;
  const feeToken: "base" | "quote" = feeOnA === baseIsA ? "base" : "quote";
  const r = e.swap_result as Record<string, bigint>;
  const sp = e.params as Record<string, unknown>;
  const total = r.claiming_fee + r.protocol_fee + r.compounding_fee + r.referral_fee;
  if (onInput && r.included_fee_input_amount - r.excluded_fee_input_amount !== total)
    return fail("evt_swap_mismatch", `input fee ${r.included_fee_input_amount - r.excluded_fee_input_amount} != fee parts ${total}`, pool);
  if (!onInput && r.included_fee_input_amount !== r.excluded_fee_input_amount) return fail("evt_swap_mismatch", "input amounts differ without an input fee", pool);
  if (u(e.included_transfer_fee_amount_out) !== r.output_amount) return fail("evt_swap_mismatch", "included_transfer_fee_amount_out != output_amount", pool);

  const inputAcc = a[DA.inputTokenAccount];
  const outputAcc = a[DA.outputTokenAccount];
  const inMint = tx.tokenBalances.get(inputAcc)?.mint;
  if (inMint && inMint !== (dir === 0 ? aMint : bMint)) return fail("direction_mismatch", `input account mint ${inMint} vs trade_direction ${dir}`, pool);

  const amountIn = r.included_fee_input_amount; // after Token-2022 transfer fee (what the vault gets)
  const amountInIncl = u(e.included_transfer_fee_amount_in); // what left the user's account
  const amountOut = r.output_amount; // what left the vault
  const amountOutReceived = u(e.excluded_transfer_fee_amount_out);
  const referral = a[DA.referralTokenAccount] === DAMM_V2_PROGRAM_ID ? null : a[DA.referralTokenAccount];
  if (!!referral !== Boolean(e.has_referral)) return fail("evt_swap_mismatch", `has_referral ${e.has_referral} vs referral account ${referral}`, pool);
  const baseAccount = side === "sell" ? inputAcc : outputAcc;
  const { trader, source } = resolveTrader(tx, side, baseMint, baseAccount);
  const aVault = a[DA.tokenAVault];
  const bVault = a[DA.tokenBVault];
  const outBeforeFee = onInput ? amountOut : amountOut + total;

  const trade: MeteoraTrade & { _vaults: VaultInfo } = {
    ...common(tx, p),
    pool,
    config: null,
    baseMint,
    quoteMint,
    side,
    trader,
    traderSource: source,
    swapAuthority: a[DA.payer],
    inputTokenAccount: inputAcc,
    outputTokenAccount: outputAcc,
    inputOwner: tx.tokenBalances.get(inputAcc)?.owner ?? null,
    outputOwner: tx.tokenBalances.get(outputAcc)?.owner ?? null,
    baseAmount: side === "sell" ? amountInIncl : amountOutReceived,
    // sell: quote out before the (output-side, quote) fee; buy: quote into the curve after an input fee
    // (BothToken buys pay the fee in base on the output: then all input quote reached the curve).
    quoteGross: side === "sell" ? outBeforeFee : r.excluded_fee_input_amount,
    quoteNet: side === "sell" ? amountOutReceived : amountInIncl,
    amountIn,
    amountInAfterFee: r.excluded_fee_input_amount,
    amountOut,
    amountInIncludingTransferFee: amountInIncl,
    amountOutReceived,
    fee: { token: feeToken, onInput, total, trading: r.claiming_fee, protocol: r.protocol_fee, referral: r.referral_fee, compounding: r.compounding_fee },
    hasReferral: Boolean(e.has_referral),
    referralTokenAccount: referral,
    referralOwner: referral ? tx.tokenBalances.get(referral)?.owner ?? null : null,
    swapMode: Number(sp.swap_mode),
    instruction: instructionName("damm_v2", p.swapIx.data) as "swap" | "swap2",
    nextSqrtPrice: r.next_sqrt_price,
    reserves: { a: u(e.reserve_a_amount), b: u(e.reserve_b_amount) },
    curveComplete: null,
    eventTimestamp: u(e.current_timestamp),
    eventRaw: p.primary.raw,
    eventName: "EvtSwap2",
    baseIsTokenA: baseIsA,
    _vaults: { swapOrdinal: p.swapIx.ordinal, inVault: dir === 0 ? aVault : bVault, outVault: dir === 0 ? bVault : aVault, inVaultReceived: amountIn },
  };
  return { trade };
}

/** Strip the internal vault bookkeeping (non-enumerable copy for JSON/DB). */
export function publicTrade(t: MeteoraTrade): MeteoraTrade {
  const { _vaults, ...rest } = t as MeteoraTrade & { _vaults?: unknown };
  void _vaults;
  return rest;
}

export { DBC_PROGRAM_ID, DAMM_V2_PROGRAM_ID };
