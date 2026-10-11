"""Exact Python ports of the on-chain math (contracts/programs/fumpad/src/math/*,
instructions/rewards/logic.rs, constants.rs). Integer arithmetic in base units
(lamports, token base units with 6 decimals, Q64.64 prices) so results match the
Rust code bit for bit. Python ints are unbounded, so the u128/u256 overflow guards
of the Rust code are not needed; where Rust saturates or returns None we mirror it.

The simulation uses these for the bonding-curve phase (exact) and the unit tests;
the post-graduation phase works in floats (see market.py) with the same formulas.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

Q64 = 1 << 64
BPS = 10_000
LAMPORTS_PER_SOL = 1_000_000_000
TOKEN_UNIT = 1_000_000  # 6 decimals

# ── constants.rs defaults ────────────────────────────────────────────────────
DEFAULT_TOTAL_SUPPLY = 1_000_000_000_000_000
DEFAULT_REWARD_POOL_SUPPLY = 50_000_000_000_000
DEFAULT_CURVE_SUPPLY = 753_448_275_862_069
DEFAULT_LP_SUPPLY = 196_551_724_137_931
DEFAULT_INITIAL_VIRTUAL_SOL = 30_000_000_000
DEFAULT_INITIAL_VIRTUAL_TOKEN = 1_019_371_196_754_564
DEFAULT_GRADUATION_LAMPORTS = 85_000_000_000
MAX_SELF_IMPACT_DISCOUNT_BPS = 1_000
REFERENCE_WINDOW_SECS = 600
REFERENCE_MAX_UNCONFIRMED_SECS = 150
CLAIM_QUEUE_CAPACITY = 256
LP_FEE_PLATFORM_SHARE_BPS = 6_000


@dataclass(frozen=True)
class Params:
    """Mirror of `state/global.rs::Params` (the fields the simulation uses) plus the
    spec-level knobs that are not (yet) on-chain params: queue capacity (a constant),
    D16 per-wallet queue limit (spec only, not yet in code)."""
    total_supply: int = DEFAULT_TOTAL_SUPPLY
    reward_pool_supply: int = DEFAULT_REWARD_POOL_SUPPLY
    curve_supply: int = DEFAULT_CURVE_SUPPLY
    lp_supply: int = DEFAULT_LP_SUPPLY
    initial_virtual_sol: int = DEFAULT_INITIAL_VIRTUAL_SOL
    initial_virtual_token: int = DEFAULT_INITIAL_VIRTUAL_TOKEN
    graduation_lamports: int = DEFAULT_GRADUATION_LAMPORTS
    graduation_fee_lamports: int = 0
    fee_bps: int = 100
    fee_pool_share_bps: int = 5_000
    fee_platform_share_bps: int = 3_000
    fee_creator_share_bps: int = 2_000
    trigger_multiple_bps: int = 100_000  # 10x
    claim_bps: int = 1_000  # 10% of ticket tokens
    max_claim_pool_bps: int = 1_000  # one claim ≤ 10% of pool
    min_sell_usd_cents: int = 5_000
    min_hold_secs: int = 600
    rebuy_window_secs: int = 7 * 86_400
    claim_window_secs: int = 90 * 86_400
    max_open_tickets: int = 5
    oracle_window_secs: int = 1_800
    buyback_max_deviation_bps: int = 300
    buyback_max_pool_bps: int = 50
    # spec / constants, not Params fields
    queue_capacity: int = CLAIM_QUEUE_CAPACITY
    max_queue_entries_per_wallet: int = 2  # D16

    def with_reward_pool_supply(self, reward_pool_supply: int) -> "Params":
        """Re-derive the curve for a different reward-pool allocation the way SPEC §3
        derives the defaults: same 30 SOL virtual start, ~85 SOL raised, and the curve's
        final price equal to the LP opening price with the remaining supply."""
        curve_supply, lp_supply, ivt = derive_curve(self.total_supply - reward_pool_supply,
                                                    self.initial_virtual_sol, self.graduation_lamports)
        return replace(self, reward_pool_supply=reward_pool_supply, curve_supply=curve_supply,
                       lp_supply=lp_supply, initial_virtual_token=ivt)

    def with_fee_pool_share(self, pool_bps: int) -> "Params":
        """Change the pool share; platform:creator keep their 3:2 ratio on the rest."""
        rest = BPS - pool_bps
        platform = rest * 3 // 5
        return replace(self, fee_pool_share_bps=pool_bps, fee_platform_share_bps=platform,
                       fee_creator_share_bps=rest - platform)

    def is_valid(self) -> bool:
        return (self.fee_pool_share_bps + self.fee_platform_share_bps + self.fee_creator_share_bps == BPS
                and self.reward_pool_supply + self.curve_supply + self.lp_supply == self.total_supply
                and self.initial_virtual_token > self.curve_supply
                and self.trigger_multiple_bps > BPS and self.claim_bps <= BPS
                and self.max_claim_pool_bps <= BPS)


def derive_curve(non_pool_supply: int, virtual_sol: int, raised: int) -> tuple[int, int, int]:
    """(curve_supply, lp_supply, initial_virtual_token) such that the curve completes at
    `raised` lamports and its final price == raised / lp_supply (no jump at graduation).

    With x0 = virtual SOL, x1 = x0 + raised, y0/y1 = initial/final virtual tokens:
      continuity  x1 / y1 = raised / L  →  y1 = x1·L / raised
      constant k  x0·y0 = x1·y1         →  C = y0 − y1 = y1·raised/x0 = L·x1/x0
      supply      C + L = N              →  L = N·x0 / (x0 + x1)
    Reproduces the constants.rs defaults exactly for N = 950M tokens (tested).
    """
    x0, x1 = virtual_sol, virtual_sol + raised
    lp = non_pool_supply * x0 // (x0 + x1)
    curve = non_pool_supply - lp
    y1 = x1 * lp // raised
    y0 = curve + y1 + 1  # +1 lands on the rounding used for the defaults (checked in tests)
    return curve, lp, y0


# ── math/fees.rs ─────────────────────────────────────────────────────────────
def ceil_div(a: int, b: int) -> int:
    return -(-a // b)


@dataclass(frozen=True)
class FeeSplit:
    total: int
    pool: int
    platform: int
    creator: int


def compute_fee(sol_amount: int, p: Params) -> FeeSplit:
    total = ceil_div(sol_amount * p.fee_bps, BPS)
    pool = total * p.fee_pool_share_bps // BPS
    platform = total * p.fee_platform_share_bps // BPS
    return FeeSplit(total, pool, platform, total - pool - platform)


# ── math/curve.rs ────────────────────────────────────────────────────────────
@dataclass
class CurveReserves:
    virtual_sol: int
    virtual_token: int
    real_sol: int
    real_token: int

    @classmethod
    def initial(cls, p: Params) -> "CurveReserves":
        return cls(p.initial_virtual_sol, p.initial_virtual_token, 0, p.curve_supply)

    def spot_q64(self) -> int:
        return price_q64(self.virtual_sol, self.virtual_token)

    def k(self) -> int:
        return self.virtual_sol * self.virtual_token

    def apply_buy(self, q: "BuyQuote") -> None:
        self.virtual_sol += q.sol_used
        self.real_sol += q.sol_used
        self.virtual_token -= q.tokens_out
        self.real_token -= q.tokens_out
        assert self.real_token >= 0

    def apply_sell(self, tokens_in: int, sol_out: int) -> None:
        self.virtual_sol -= sol_out
        self.real_sol -= sol_out
        self.virtual_token += tokens_in
        self.real_token += tokens_in
        assert self.real_sol >= 0


@dataclass(frozen=True)
class BuyQuote:
    sol_used: int = 0
    tokens_out: int = 0
    completes: bool = False


def quote_buy(r: CurveReserves, sol_in: int) -> BuyQuote:
    if r.virtual_token <= r.real_token or r.virtual_sol == 0:
        raise ValueError("inconsistent curve")
    if sol_in == 0 or r.real_token == 0:
        return BuyQuote()
    x, y, s = r.virtual_sol, r.virtual_token, sol_in
    raw = y * s // (x + s)
    if raw < r.real_token:
        return BuyQuote(sol_in, raw, False)
    t = r.real_token
    cost = ceil_div(x * t, y - t)
    assert cost <= s
    return BuyQuote(cost, t, True)


def quote_sell(r: CurveReserves, tokens_in: int) -> int | None:
    if tokens_in == 0:
        return 0
    out = r.virtual_sol * tokens_in // (r.virtual_token + tokens_in)
    return None if out > r.real_sol else out


def sol_for_tokens(r: CurveReserves, tokens_out: int) -> int | None:
    if tokens_out > r.real_token:
        return None
    return ceil_div(r.virtual_sol * tokens_out, r.virtual_token - tokens_out)


def inline_buyback(r: CurveReserves, pool_lamports: int) -> tuple[BuyQuote, int]:
    """curve/mod.rs::inline_buyback → (quote applied to r, unspent lamports)."""
    q = quote_buy(r, pool_lamports)
    if q.tokens_out == 0:
        q = BuyQuote()
    r.apply_buy(q)
    return q, pool_lamports - q.sol_used


# ── math/price.rs ────────────────────────────────────────────────────────────
def price_q64(lamports: int, tokens: int) -> int:
    if tokens == 0:
        raise ZeroDivisionError
    return (lamports << 64) // tokens


def meets_multiple(current_q64: int, reference_q64: int, multiple_bps: int) -> bool:
    return current_q64 * BPS >= reference_q64 * multiple_bps


def mul_div_ceil(a: int, b: int, d: int) -> int:
    return ceil_div(a * b, d)


def q64_to_sol_per_token(q: int) -> float:
    """Q64 lamports/base-unit → SOL per whole token."""
    return q / Q64 * TOKEN_UNIT / LAMPORTS_PER_SOL


# ── math/reference.rs ────────────────────────────────────────────────────────
def blend(avg: int, v: int, w: int, window: int) -> int:
    w = min(w, window)
    part = lambda diff: (diff // window) * w + (diff % window) * w // window  # noqa: E731
    return avg + part(v - avg) if v >= avg else avg - part(avg - v)


@dataclass
class ReferencePrice:
    avg_q64: int = 0
    last_spot_q64: int = 0
    updated_at: int = 0

    @classmethod
    def new(cls, spot: int, now: int) -> "ReferencePrice":
        return cls(spot, spot, now)

    def update(self, now: int, pre_spot: int, post_spot: int, exact: bool) -> None:
        if self.updated_at == 0:
            s = max(pre_spot, post_spot)
            self.avg_q64, self.last_spot_q64, self.updated_at = s, s, now
            return
        dt = max(now - self.updated_at, 0)
        if exact:
            v, w = self.last_spot_q64, min(dt, REFERENCE_WINDOW_SECS)
        else:
            v, w = max(self.last_spot_q64, pre_spot), min(dt, REFERENCE_MAX_UNCONFIRMED_SECS)
        self.avg_q64 = blend(self.avg_q64, v, w, REFERENCE_WINDOW_SECS)
        self.last_spot_q64 = post_spot
        self.updated_at = max(self.updated_at, now)


def ticket_price_q64(execution: int, reference: int, pre_trade_spot: int) -> int:
    """D12 (+10% cap): max(execution, max(⌈ref·exec/pre⌉, ⌈ref·0.9⌉))."""
    if pre_trade_spot == 0:
        floor = reference
    else:
        fair = mul_div_ceil(reference, execution, pre_trade_spot)
        capped = mul_div_ceil(reference, BPS - MAX_SELF_IMPACT_DISCOUNT_BPS, BPS)
        floor = max(fair, capped)
    return max(execution, floor)


def ticket_price_float(execution: float, reference: float, pre_trade_spot: float) -> float:
    """Same rule in floats (post-graduation phase)."""
    if pre_trade_spot <= 0:
        return max(execution, reference)
    ratio = max(execution / pre_trade_spot, 1 - MAX_SELF_IMPACT_DISCOUNT_BPS / BPS)
    return max(execution, reference * ratio)


# ── rewards/logic.rs ─────────────────────────────────────────────────────────
def claim_amount(tokens: int, claim_bps: int) -> int:
    return tokens * claim_bps // BPS


def claim_cap(pool: int, max_claim_pool_bps: int) -> int:
    return pool * max_claim_pool_bps // BPS


def fits(amount: int, pool: int, max_claim_pool_bps: int) -> bool:
    return 0 < amount <= claim_cap(pool, max_claim_pool_bps) and amount <= pool


@dataclass
class Position:
    """state/position.rs + logic.rs (settle / add / cap_tracked / debit_sold / plan_sell)."""
    matured: int = 0
    pending: int = 0
    pending_since: int = 0
    open_tickets: list = field(default_factory=list)

    def settle(self, now: int, min_hold: int) -> None:
        if self.pending > 0 and now - self.pending_since >= min_hold:
            self.matured += self.pending
            self.pending = 0

    def add(self, amount: int, now: int, min_hold: int) -> None:
        self.settle(now, min_hold)
        self.pending += amount
        self.pending_since = now

    def cap_tracked(self, balance: int) -> None:
        excess = self.matured + self.pending - balance
        if excess <= 0:
            return
        m = min(excess, self.matured)
        self.matured -= m
        self.pending = max(self.pending - (excess - m), 0)

    def debit_sold(self, sold: int) -> None:
        m = min(sold, self.matured)
        self.matured -= m
        self.pending = max(self.pending - (sold - m), 0)

    def plan_sell(self, sold: int, balance_before: int, now: int, min_hold: int) -> int:
        """Ticket-candidate tokens (0 = not matured). Always debits the position."""
        self.settle(now, min_hold)
        self.cap_tracked(balance_before)
        t = min(sold, self.matured)
        self.debit_sold(sold)
        return t


def plan_rebuy(tickets: list[tuple[int, int, int, bool]], amount: int, now: int, window: int) -> list[int]:
    """logic.rs::plan_rebuy. tickets = [(sell_ts, seq, tokens, active)] → debits."""
    debits = [0] * len(tickets)
    order = [i for i, (ts, _seq, tok, active) in enumerate(tickets)
             if active and tok > 0 and now >= ts and now - ts <= window]
    order.sort(key=lambda i: (tickets[i][0], tickets[i][1]), reverse=True)
    left = amount
    for i in order:
        if left == 0:
            break
        d = min(left, tickets[i][2])
        debits[i] = d
        left -= d
    return debits
