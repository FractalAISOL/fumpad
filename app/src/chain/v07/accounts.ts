/**
 * ADAPTER (until @fumpad/sdk v0.7): the few account fields the app reads from chain, by byte
 * offset (8-byte Anchor discriminator included).
 *
 *   - FUMPAD `Coin` (INTERFACE-v0.7 §5.3): status, pools, config. Offsets match the Rust struct
 *     (contracts branch, 037027a `state/coin.rs`); not yet checked against a deployed account
 *     (UNVERIFIED). Every decode self-checks (discriminator, mint, and the DBC pool PDA
 *     re-derived from the decoded config) and refuses on mismatch.
 *   - DBC `PoolConfig` (1,048 bytes; offsets from the DBC 0.2.1 IDL, matching INTERFACE §5.4 and
 *     checked against the spike's devnet config with the official SDK decoder): the curve's
 *     start, segment 0 and the base fee, for the launch's first-buy check.
 *   - FUMPAD `Ticket` (§5.6, `state/ticket.rs`): owner + escrow payer, for `withdraw_escrow`. Same caveat.
 *
 * No React, no `@/` imports.
 */
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_DISC, dbcPoolPda, startsWith, WSOL_MINT } from "./ids";

const key = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));
const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64 = (d: Uint8Array, o: number) => view(d).getBigUint64(o, true);
const u16 = (d: Uint8Array, o: number) => view(d).getUint16(o, true);
const u128 = (d: Uint8Array, o: number) => u64(d, o) + (u64(d, o + 8) << BigInt(64));

export class LayoutError extends Error {
  constructor(what: string) {
    super(`Unexpected ${what} account data. The app may be out of date; reload and try again.`);
    this.name = "LayoutError";
  }
}

export type CoinChainStatus = "curve" | "complete" | "graduated";
export interface CoinAccount {
  status: CoinChainStatus;
  mint: PublicKey;
  creator: PublicKey;
  dbcPool: PublicKey;
  dbcConfig: PublicKey;
  /** Default key until graduation. */
  dammPool: PublicKey;
  launchSlot: bigint;
  launchWindowSlots: bigint;
}

/** `Coin` (§5.3): bump u8 @8, status u8 @9, launch_fees_settled @10, mint @11, creator @43, dbc_pool @75, dbc_config @107, damm_pool @139, damm_position @171, launch_slot @203, launch_window_slots @211. */
export function decodeCoin(d: Uint8Array, expectMint: PublicKey): CoinAccount {
  if (d.length < 219 || !startsWith(d, ACCOUNT_DISC.Coin)) throw new LayoutError("coin");
  const status = (["curve", "complete", "graduated"] as const)[d[9]];
  const c: CoinAccount = {
    status,
    mint: key(d, 11),
    creator: key(d, 43),
    dbcPool: key(d, 75),
    dbcConfig: key(d, 107),
    dammPool: key(d, 139),
    launchSlot: u64(d, 203),
    launchWindowSlots: u64(d, 211),
  };
  if (!status || !c.mint.equals(expectMint) || !dbcPoolPda(c.dbcConfig, c.mint).equals(c.dbcPool)) throw new LayoutError("coin");
  return c;
}

/** DBC curve state at launch, from the config: a fresh pool starts at `sqrtStartPrice` on segment 0. */
export interface DbcCurveStart {
  sqrtStartPrice: bigint;
  /** Segment 0: liquidity and the sqrt price where it ends. */
  liquidity: bigint;
  segmentEndSqrtPrice: bigint;
  /** The fee a min-fee first swap pays (the scheduler's floor), numerator over 1e9. */
  minFeeNumerator: bigint;
  /** Tokens the curve sells before it completes, base units. */
  swapBaseAmount: bigint;
  migrationQuoteThreshold: bigint;
  firstSwapMinFee: boolean;
}

export const FEE_DENOMINATOR = BigInt(1_000_000_000);

/**
 * DBC `PoolConfig`: pool_fees.base_fee {cliff_fee_numerator u64 @104, second_factor u64 @112,
 * third_factor u64 @120, first_factor u16 @128, base_fee_mode u8 @130}; swap_base_amount @256;
 * migration_quote_threshold @264; enable_first_swap_with_min_fee @365; sqrt_start_price u128 @392;
 * curve[0] {sqrt_price u128 @408, liquidity u128 @424}.
 */
export function decodeDbcCurveStart(d: Uint8Array): DbcCurveStart {
  if (d.length !== 1048 || !startsWith(d, ACCOUNT_DISC.PoolConfig) || !key(d, 8).equals(WSOL_MINT)) throw new LayoutError("DBC config");
  const cliff = u64(d, 104);
  const mode = d[130];
  const periods = BigInt(u16(d, 128));
  const reduction = u64(d, 120);
  let minFee = cliff;
  if (mode === 0) {
    // Linear scheduler: cliff − periods × reduction (the fee once the window is over).
    minFee = cliff > periods * reduction ? cliff - periods * reduction : BigInt(0);
  } else if (mode === 1) {
    // Exponential: cliff × (1 − reduction/10⁴)^periods.
    for (let i = BigInt(0); i < periods; i++) minFee = (minFee * (BigInt(10_000) - reduction)) / BigInt(10_000);
  } else if (mode !== 2) {
    throw new LayoutError("DBC config");
  }
  const curve = { sqrtStartPrice: u128(d, 392), segmentEndSqrtPrice: u128(d, 408), liquidity: u128(d, 424) };
  if (curve.sqrtStartPrice === BigInt(0) || curve.liquidity === BigInt(0) || curve.segmentEndSqrtPrice <= curve.sqrtStartPrice)
    throw new LayoutError("DBC config");
  return { ...curve, minFeeNumerator: minFee, swapBaseAmount: u64(d, 256), migrationQuoteThreshold: u64(d, 264), firstSwapMinFee: d[365] === 1 };
}

export interface TicketAccount {
  owner: PublicKey;
  mint: PublicKey;
  /** 0 Open, 1 Queued, 2 Claimed, 3 Expired, 4 Voided, 5 Escrowed. */
  status: number;
  escrowPayer: PublicKey;
}

/** `Ticket` (§5.6): owner @9, mint @41, seq @73, …, sell_ts @121, status @129, queued_at @130, claim_amount @138, claimed_at @146, escrow_payer @154. */
export function decodeTicket(d: Uint8Array, expect: { owner: PublicKey; mint: PublicKey }): TicketAccount {
  if (d.length < 186 || !startsWith(d, ACCOUNT_DISC.Ticket)) throw new LayoutError("ticket");
  const t = { owner: key(d, 9), mint: key(d, 41), status: d[129], escrowPayer: key(d, 154) };
  if (!t.owner.equals(expect.owner) || !t.mint.equals(expect.mint) || t.status > 5) throw new LayoutError("ticket");
  return t;
}
