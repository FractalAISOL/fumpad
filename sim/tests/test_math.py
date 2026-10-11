"""The Python port must reproduce the Rust math (numbers from the Rust unit tests and
from the constants.rs defaults)."""
import random

import pytest

from sim import fumpad_math as fm

P = 1 << 64
CRASH = P // 20


def fresh(p=fm.Params()):
    return fm.CurveReserves.initial(p)


def test_defaults_valid_and_derivation_matches_constants():
    p = fm.Params()
    assert p.is_valid()
    c, l, y0 = fm.derive_curve(p.total_supply - p.reward_pool_supply, p.initial_virtual_sol, p.graduation_lamports)
    assert (c, l, y0) == (fm.DEFAULT_CURVE_SUPPLY, fm.DEFAULT_LP_SUPPLY, fm.DEFAULT_INITIAL_VIRTUAL_TOKEN)


def test_basic_buy_matches_rust():
    r = fresh()
    q = fm.quote_buy(r, 1_000_000_000)
    assert q.tokens_out == r.virtual_token * 1_000_000_000 // 31_000_000_000
    assert not q.completes and q.sol_used == 1_000_000_000
    r2 = fm.CurveReserves(**vars(r))
    r2.apply_buy(q)
    back = fm.quote_sell(r2, q.tokens_out)
    assert back <= q.sol_used and q.sol_used - back <= 1


def test_completion_raises_85_sol_and_price_ratio_14_7x():
    p = fm.Params()
    r = fresh()
    q = fm.quote_buy(r, 1_000 * 10**9)
    assert q.completes and q.tokens_out == r.real_token
    start = r.spot_q64()
    r.apply_buy(q)
    assert abs(r.real_sol - p.graduation_lamports) <= 2
    ratio_x100 = r.spot_q64() * 100 // start
    assert 1460 <= ratio_x100 <= 1480  # ≈ 14.7x (SPEC §3)


def test_graduation_price_continuity_random_fill():
    p = fm.Params()
    r = fresh()
    rng = random.Random(99)
    while True:
        q = fm.quote_buy(r, rng.randint(1, 3_000_000_000))
        r.apply_buy(q)
        if q.completes:
            break
    curve_price = r.spot_q64()
    lp_price = fm.price_q64(r.real_sol - p.graduation_fee_lamports, p.lp_supply)
    assert abs(curve_price - lp_price) * 1_000_000 <= curve_price
    assert abs(r.real_sol - p.graduation_lamports) < 1_000


@pytest.mark.parametrize("pool_pct", [3, 5, 8])
def test_rederived_curves_keep_continuity(pool_pct):
    p = fm.Params().with_reward_pool_supply(fm.DEFAULT_TOTAL_SUPPLY * pool_pct // 100)
    assert p.is_valid()
    r = fresh(p)
    q = fm.quote_buy(r, 10**15)
    r.apply_buy(q)
    assert abs(r.real_sol - 85 * 10**9) <= 10
    lp_price = fm.price_q64(r.real_sol, p.lp_supply)
    assert abs(r.spot_q64() - lp_price) * 1_000_000 <= r.spot_q64()


def test_round_trip_never_profits():
    rng = random.Random(42)
    for _ in range(500):
        r = fresh()
        r.apply_buy(fm.quote_buy(r, rng.randint(1, 80 * 10**9)))
        if r.real_token == 0:
            continue
        q = fm.quote_buy(r, rng.randint(1, 100 * 10**9))
        if q.tokens_out == 0:
            continue
        r2 = fm.CurveReserves(**vars(r))
        r2.apply_buy(q)
        assert fm.quote_sell(r2, q.tokens_out) <= q.sol_used


def test_fee_split_doc_example():
    p = fm.Params()
    f = fm.compute_fee(10_000_000_000, p)  # $10k-equivalent example from fees.rs
    assert (f.total, f.pool, f.platform, f.creator) == (100_000_000, 50_000_000, 30_000_000, 20_000_000)
    for amt in [0, 1, 99, 101, 12_345_678]:
        f = fm.compute_fee(amt, p)
        assert f.pool + f.platform + f.creator == f.total
        assert f.total * 10_000 >= amt * p.fee_bps


def test_fee_pool_share_variant_keeps_sum():
    for share in (3_000, 5_000, 7_000):
        p = fm.Params().with_fee_pool_share(share)
        assert p.is_valid()
        f = fm.compute_fee(10_000_000_000, p)
        assert f.pool == 100_000_000 * share // 10_000


def test_ticket_price_d12_vectors_from_rust():
    tp = fm.ticket_price_q64
    assert tp(5, 7, 0) == 7 and tp(9, 7, 0) == 9
    for ex in [P * 91 // 100, P - 1, P]:
        assert tp(ex, P, P) == ex
    t = tp(P // 2, P, P)
    assert P * 9 // 10 <= t <= P * 9 // 10 + 1
    assert tp(P * 99 // 100, P // 2, P) == P * 99 // 100
    pre = CRASH
    ex = pre * 99 // 100
    t = tp(ex, P, pre)
    assert t + P // 1_000_000 >= P * 99 // 100 and t <= P and t > ex * 19
    assert tp(2, 3, 4) == 3 and tp(1, 3, 2) == 3 and tp(28, 30, 30) == 28 and tp(4, 10, 2) == 20
    # self-impact cap
    assert tp(P * 97 // 100, P, P) == P * 97 // 100
    t = tp(P * 49 // 100, P, P)
    assert P * 9 // 10 <= t <= P * 9 // 10 + 1


def test_ticket_price_float_matches_int():
    rng = random.Random(5)
    for _ in range(1000):
        ref = rng.uniform(0.5, 2) * P
        pre = rng.uniform(0.2, 2) * P
        ex = pre * rng.uniform(0.3, 1.0)
        a = fm.ticket_price_q64(int(ex), int(ref), int(pre))
        b = fm.ticket_price_float(ex, ref, pre)
        assert abs(a - b) <= 1e-9 * a + 2


def test_reference_blend_and_staging():
    assert fm.blend(100, 200, 300, 600) == 150 and fm.blend(200, 100, 300, 600) == 150
    assert fm.blend(100, 0, 1, 600) == 100 and fm.blend(5, 7, 10_000, 600) == 7
    for exact in (True, False):
        r = fm.ReferencePrice.new(P, 1_000)
        r.update(1_300, P, P, exact)
        r.update(1_300, CRASH, CRASH, exact)
        assert r.avg_q64 == P
    t = 1_000
    r = fm.ReferencePrice.new(P, t)
    r.update(t, CRASH, CRASH, False)
    n = 0
    while r.avg_q64 * 10 > P:
        t += 150
        r.update(t, CRASH, CRASH, False)
        n += 1
    assert n >= 11
    r = fm.ReferencePrice.new(P, 1_000)
    r.update(1_600, P, P // 2, True)
    r.update(1_900, P // 2, P // 2, True)
    assert r.avg_q64 == P - P // 4


def test_claim_math():
    assert fm.claim_amount(1_000_000, 1_000) == 100_000
    assert fm.claim_amount(9, 1_000) == 0
    assert fm.claim_cap(1_000, 1_000) == 100
    assert fm.fits(100, 1_000, 1_000) and not fm.fits(101, 1_000, 1_000)
    assert not fm.fits(0, 1_000, 1_000) and not fm.fits(1, 9, 1_000)
    assert fm.meets_multiple(fm.price_q64(10_000, 10**6), fm.price_q64(1_000, 10**6), 100_000)
    assert not fm.meets_multiple(fm.price_q64(9_999, 10**6), fm.price_q64(1_000, 10**6), 100_000)


def test_rebuy_newest_first_vector_from_rust():
    w = 7 * 86_400
    tickets = [(100, 0, 1_000, True), (300, 2, 400, True), (200, 1, 500, True), (300, 3, 50, False), (-w, 4, 9_999, True)]
    assert fm.plan_rebuy(tickets, 600, 1_000, w) == [0, 400, 200, 0, 0]
    assert fm.plan_rebuy(tickets, 10_000, 1_000, w) == [1_000, 400, 500, 0, 0]
    assert fm.plan_rebuy([(0, 0, 10, True)], 5, w, w) == [5]
    assert fm.plan_rebuy([(0, 0, 10, True)], 5, w + 1, w) == [0]


def test_position_min_hold_and_caps():
    p = fm.Params()
    s = fm.Position()
    s.add(1_000, 0, p.min_hold_secs)
    a = fm.Position(**{**vars(s), "open_tickets": []})
    assert a.plan_sell(1_000, 1_000, 599, p.min_hold_secs) == 0
    b = fm.Position(**{**vars(s), "open_tickets": []})
    assert b.plan_sell(1_000, 1_000, 600, p.min_hold_secs) == 1_000
    c = fm.Position(**{**vars(s), "open_tickets": []})
    assert c.plan_sell(500, 200, 700, p.min_hold_secs) == 200  # balance moved out elsewhere
    s.add(500, 700, p.min_hold_secs)
    assert (s.matured, s.pending, s.pending_since) == (1_000, 500, 700)
