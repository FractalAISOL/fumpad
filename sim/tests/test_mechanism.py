"""Mechanism rules on hand-built tapes: skip-ahead queue, per-claim cap, capacity, D16,
expiry (Open expires, Queued never), rebuy voiding, buyback band."""
from dataclasses import replace

import numpy as np

from sim import fumpad_math as fm
from sim.market import DAY, Tape
from sim.mechanism import CLAIMED, EXPIRED, OPEN, QUEUED, REFUSED, VOIDED, MechOptions, run_mechanism

DT = 300
OPT = MechOptions(claim_attempt_p=1.0)


def make_tape(price, tickets, rebuys=(), pool0=1_000.0, fum_fee=None, lp_fee=None):
    n = len(price)
    price = np.asarray(price, float)
    med = np.full(n, np.nan)
    for s in range(5, n):
        med[s] = np.sort(price[s - 5: s + 1])[2]
    tickets = sorted(tickets, key=lambda t: t[0])
    rb = sorted(rebuys, key=lambda t: t[0])
    col = lambda rows, i, d: np.array([r[i] for r in rows], dtype=d)  # noqa: E731
    return Tape(
        scenario="unit", seed=0, t_grad=0, dt=DT, price=price, median=med,
        base=np.full(n, 1e8), quote=np.full(n, 100.0),
        fum_fee=np.zeros(n) if fum_fee is None else np.asarray(fum_fee, float),
        lp_fee=np.zeros(n) if lp_fee is None else np.asarray(lp_fee, float),
        pool_tokens_at_grad=pool0, buyback_sol_at_grad=0.0, curve_tokens_bought_back=0.0, curve_volume_sol=0.0,
        tk_ts=col(tickets, 0, np.int64), tk_wallet=col(tickets, 1, np.int64), tk_tokens=col(tickets, 2, float),
        tk_price=col(tickets, 3, float), tk_phase=np.zeros(len(tickets), np.int8),
        tk_wtype=np.ones(len(tickets), np.int8),
        rb_ts=col(rb, 0, np.int64), rb_wallet=col(rb, 1, np.int64), rb_tokens=col(rb, 2, float),
    )


def test_skip_ahead_small_claim_passes_big_one():
    # pool 1000, cap 100: ticket A owes 500 (queued), B owes 50 (paid at once).
    price = [1.0] * 10 + [20.0] * 30
    tape = make_tape(price, [(-100, 1, 5_000, 1.0), (-50, 2, 500, 1.0)])
    r = run_mechanism(tape, fm.Params(), OPT)
    st = r.tickets["status"]
    assert st[0] == QUEUED and st[1] == CLAIMED
    assert abs(r.summary["pool_end"] - 950) < 1e-9


def test_queue_pays_when_inflows_make_room_in_order():
    n = 400
    price = [10.0] * n  # ticket price 1 → 10x from the start
    fee = np.zeros(n)
    fee[20:] = 0.5  # buyback inflows (SOL) → pool grows
    tape = make_tape(price, [(-100, 1, 5_000, 1.0), (-90, 2, 3_000, 1.0)], fum_fee=fee)
    p = fm.Params()
    r = run_mechanism(tape, p, OPT)
    T = r.tickets
    assert (T["status"] == CLAIMED).all()
    assert T["from_queue"].all()
    # skip-ahead order: the smaller, younger entry (300) fits first; the older 500 later
    assert T["paid_at"][1] <= T["paid_at"][0]


def test_queue_capacity_and_d16():
    price = [1.0] * 6 + [20.0] * 20
    tk = [(-1000 + i, 10 + i // 3, 50_000, 1.0) for i in range(9)]  # 3 per wallet, each owes 5000 > cap
    tape = make_tape(price, tk)
    r = run_mechanism(tape, replace(fm.Params(), queue_capacity=4), OPT)
    st = r.tickets["status"]
    assert (st == QUEUED).sum() == 4
    assert r.summary["peak_queue"] == 4
    # D16: the third ticket of wallet 10 can never queue
    r2 = run_mechanism(tape, fm.Params(), OPT)
    st2 = r2.tickets["status"]
    assert (st2 == QUEUED).sum() == 6 and (st2 == OPEN).sum() == 3
    assert r2.tickets["blocked_d16"].sum() == 3


def test_open_expires_queued_never():
    n = int(95 * DAY / DT)
    price = np.full(n, 1.0)
    price[6:30] = 20.0  # qualifies briefly
    tk = [(0, 1, 50_000, 1.0), (1, 2, 500, 50.0)]  # #1 queues (too big); #2 never qualifies
    r = run_mechanism(make_tape(price, tk), fm.Params(), OPT)
    st = r.tickets["status"]
    assert st[0] == QUEUED and st[1] == EXPIRED


def test_open_ticket_limit_five():
    tk = [(i, 7, 100, 1.0) for i in range(6)]
    r = run_mechanism(make_tape([1.0] * 10, tk), fm.Params(), OPT)
    assert (r.tickets["status"] == REFUSED).sum() == 1


def test_rebuy_voids_within_7_days_newest_first():
    price = [1.0] * int(9 * DAY / DT)
    tk = [(0, 1, 100, 1.0), (60, 1, 100, 1.0)]
    rb = [(120, 1, 150.0)]  # 100 off the newer, 50 off the older
    r = run_mechanism(make_tape(price, tk, rb), fm.Params(), OPT)
    T = r.tickets
    assert T["status"][1] == VOIDED and abs(T["tokens"][0] - 50) < 1e-9
    # after 7 days: no effect
    rb_late = [(int(7 * DAY) + 61, 1, 150.0)]
    r = run_mechanism(make_tape(price, tk, rb_late), fm.Params(), OPT)
    assert (r.tickets["tokens"] == 100).all()


def test_trigger_multiple_respected():
    price = [1.0] * 6 + [9.99] * 20
    r = run_mechanism(make_tape(price, [(0, 1, 100, 1.0)]), fm.Params(), OPT)
    assert r.tickets["first_qual"][0] == -1
    r = run_mechanism(make_tape(price, [(0, 1, 100, 1.0)]),
                      replace(fm.Params(), trigger_multiple_bps=50_000), OPT)
    assert r.tickets["status"][0] == CLAIMED


def test_buyback_only_inside_band():
    n = 100
    price = np.ones(n)
    price[50:] = np.linspace(1.0, 3.0, 50)  # trending: spot leaves the ±3% band of the median
    fee = np.full(n, 0.01)
    r = run_mechanism(make_tape(price, [], fum_fee=fee), fm.Params(), OPT)
    assert r.summary["inflow_buyback"] > 0
    assert r.summary["buyback_sol_unspent"] > 0  # accrued during the trend
