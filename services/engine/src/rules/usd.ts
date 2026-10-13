// SOL/USD rules for the $50 check: port of contracts/programs/fumpad/src/external/pyth.rs (`validate`
// minus the account-level checks, and `lamports_to_usd_cents`), with the v0.7 time rule (SPEC §5.4):
// the Pyth SOL/USD update with the greatest publish_time ≤ block_time, and block_time − publish_time ≤
// 60 s, else no ticket.
import { U64_MAX } from "./price.js";

/** pyth.rs MAX_CONF_BPS */
export const MAX_CONF_BPS = 200n;

/** One Pyth SOL/USD price update (price × 10^expo USD per SOL). */
export interface PythPrice {
  /** i64 */
  price: bigint;
  /** u64 */
  conf: bigint;
  expo: number;
  /** unix seconds */
  publishTime: number;
}

export interface UsdPrice {
  /** price − conf (conservative lower bound), > 0 */
  price: bigint;
  exponent: number;
}

export type OracleIssue = "missing" | "future" | "stale" | "non_positive_price" | "confidence_too_wide" | "bad_exponent";

/** Validate an update for a trade at `blockTime` (seconds). */
export function validateAt(u: PythPrice | null, blockTime: number, maxDeltaSecs: number): { ok: true; usd: UsdPrice } | { ok: false; issue: OracleIssue } {
  if (!u) return { ok: false, issue: "missing" };
  if (u.publishTime > blockTime) return { ok: false, issue: "future" };
  if (blockTime - u.publishTime > maxDeltaSecs) return { ok: false, issue: "stale" };
  if (u.price <= 0n) return { ok: false, issue: "non_positive_price" };
  if (u.conf * 10_000n > u.price * MAX_CONF_BPS) return { ok: false, issue: "confidence_too_wide" };
  if (u.expo < -18 || u.expo > 18) return { ok: false, issue: "bad_exponent" };
  return { ok: true, usd: { price: u.price - u.conf, exponent: u.expo } };
}

/** lamports_to_usd_cents: lamports × price × 10^(expo + 2 − 9), rounded down; null on u64 overflow. */
export function lamportsToUsdCents(lamports: bigint, p: UsdPrice): bigint | null {
  let v = lamports * p.price;
  if (v > (1n << 128n) - 1n) return null; // checked_mul on u128
  const e = p.exponent + 2 - 9;
  if (e >= 0) v = v * 10n ** BigInt(e);
  else v = v / 10n ** BigInt(-e);
  if (v > (1n << 128n) - 1n) return null;
  return v > U64_MAX ? null : v;
}
