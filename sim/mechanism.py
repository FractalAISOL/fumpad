"""Phase B — the reward mechanism replayed over a market tape.

Per coin: the reward pool (tokens), tickets (Open → Queued → Claimed | Expired | Voided),
the skip-ahead claim queue, rebuy debits, inline / post-graduation buybacks and LP-fee
skims. Mirrors instructions/rewards/{claim,process_queue,hooks,logic,queue}.rs and
venue/execute_buyback.rs, with the SPEC-only D16 rule (≤ 2 queue entries per wallet per
coin; the claim that would exceed it is refused like a full queue and the ticket stays
Open — the merged code does not enforce D16 yet).

Order of operations inside one 5-minute step (keeper assumed live, SPEC §5.4/§7):
  1. inflows   — FUMPAD fee pool share accrues in SOL; `execute_buyback` spends
                 min(balance, buyback_max_pool_bps × quote depth) when spot is within
                 ±buyback_max_deviation_bps of the median; LP skim hourly (base half of the
                 LP-fee growth → pool).
  2. events    — tickets created this step (refused if the wallet already has
                 max_open_tickets Open/Queued), FUMPAD buys by ticket holders (rebuy rule).
  3. expiry    — Open tickets past sell_ts + claim_window → Expired (Queued never expire, D5).
  4. crank     — `process_queue`: pay every entry that fits, in (sell_ts, id) order.
  5. claims    — every Open ticket whose oracle median ≥ trigger × ticket price is
                 "qualifying"; its owner calls `claim` with probability claim_attempt_p per
                 step. Pay now if it fits and no older fitting entry waits (none can after
                 step 4), else queue; queue full / D16 → stays Open, retried next step.
"""
from __future__ import annotations

import bisect
from dataclasses import dataclass

import numpy as np

from . import fumpad_math as fm
from .market import DAY, PUMPSWAP_FEE, Tape

OPEN, QUEUED, CLAIMED, EXPIRED, VOIDED, REFUSED = range(6)
STATUS_NAMES = ["open", "queued", "claimed", "expired", "voided", "refused"]


@dataclass(frozen=True)
class MechOptions:
    claim_attempt_p: float = 0.5  # per 5-min step while qualifying (≈ claims within 10 min)
    skim_every_steps: int = 12  # hourly LP skim + settle (keeper)
    record_every: int = 12  # time-series resolution (hourly)


@dataclass
class MechResult:
    tickets: dict  # column arrays
    ts_time: np.ndarray  # days since graduation
    ts_pool: np.ndarray  # tokens
    ts_queue: np.ndarray
    ts_paid_cum: np.ndarray
    ts_inflow_cum: np.ndarray
    summary: dict


def run_mechanism(tape: Tape, p: fm.Params, opt: MechOptions | None = None, rng_seed: int | None = None) -> MechResult:
    opt = opt or MechOptions()
    rng = np.random.default_rng(rng_seed if rng_seed is not None else tape.seed + 7919)
    trig = p.trigger_multiple_bps / fm.BPS
    claim_frac = p.claim_bps / fm.BPS
    cap_frac = p.max_claim_pool_bps / fm.BPS
    window = p.claim_window_secs
    n_steps = len(tape.price)
    dt = tape.dt

    # ── ticket table ─────────────────────────────────────────────────────────
    N = len(tape.tk_ts)
    sell_ts = tape.tk_ts
    wallet = tape.tk_wallet
    price = tape.tk_price
    tokens = tape.tk_tokens.astype(float).copy()
    status = np.full(N, -1, dtype=np.int8)  # -1 = not created yet
    q_amount = np.zeros(N)  # claim amount fixed at queue entry (re-synced by rebuys)
    first_qual = np.full(N, -1, dtype=np.int64)  # step of first qualification
    queued_at = np.full(N, -1, dtype=np.int64)
    paid_at = np.full(N, -1, dtype=np.int64)
    paid_amt = np.zeros(N)
    from_queue = np.zeros(N, dtype=bool)
    blocked = np.zeros(N, dtype=np.int32)  # refused queue entries (full / D16)
    blocked_full = np.zeros(N, dtype=bool)
    blocked_d16 = np.zeros(N, dtype=bool)

    open_by_wallet: dict[int, list[int]] = {}  # Open + Queued tickets (Position.open_tickets)
    queued_by_wallet: dict[int, int] = {}
    queue: list[tuple[int, int]] = []  # sorted (sell_ts, id)
    open_set: set[int] = set()
    open_arr = np.zeros(0, dtype=np.int64)
    open_dirty = False

    pool = tape.pool_tokens_at_grad
    bb_sol = tape.buyback_sol_at_grad
    lp_acc = 0.0
    inflow_cum = 0.0
    inflow_bb = 0.0
    inflow_lp = 0.0
    paid_cum = 0.0
    paid_by_wtype = np.zeros(8)
    pool_share = p.fee_pool_share_bps / fm.BPS
    pool0 = pool
    min_pool = pool
    peak_queue = 0
    queue_full_steps = 0

    rec_t, rec_pool, rec_q, rec_paid, rec_in = [], [], [], [], []

    qmin = [np.inf, True]  # cached smallest queued amount, dirty flag

    def create(i):
        nonlocal open_dirty
        lst = open_by_wallet.setdefault(int(wallet[i]), [])
        if len(lst) >= p.max_open_tickets:
            status[i] = REFUSED
            return
        status[i] = OPEN
        lst.append(i)
        open_set.add(i)
        open_dirty = True

    def close(i, st):
        nonlocal open_dirty
        prev = status[i]
        status[i] = st
        if prev == OPEN:
            open_set.discard(i)
            open_dirty = True
        lst = open_by_wallet.get(int(wallet[i]))
        if lst is not None and i in lst:
            lst.remove(i)

    def dequeue(i):
        k = bisect.bisect_left(queue, (int(sell_ts[i]), i))
        if k < len(queue) and queue[k] == (int(sell_ts[i]), i):
            queue.pop(k)
            w = int(wallet[i])
            queued_by_wallet[w] -= 1

    def rebuy(w, amount, now):
        lst = open_by_wallet.get(int(w))
        if not lst:
            return
        views = [(int(sell_ts[i]), i, tokens[i], status[i] in (OPEN, QUEUED)) for i in lst]
        debits = fm.plan_rebuy(views, amount, now, p.rebuy_window_secs) if isinstance(amount, int) else \
            _plan_rebuy_float(views, amount, now, p.rebuy_window_secs)
        for i, d in zip(list(lst), debits):
            if d <= 0:
                continue
            tokens[i] -= d
            owed = tokens[i] * claim_frac
            if status[i] == QUEUED:
                q_amount[i] = owed
                qmin[1] = True
            if tokens[i] <= 1e-9 or owed <= 0:
                if status[i] == QUEUED:
                    dequeue(i)
                close(i, VOIDED)

    def crank(s):
        nonlocal pool, paid_cum
        if not queue:
            return
        if qmin[1]:
            qmin[0] = min(q_amount[i] for _, i in queue)
            qmin[1] = False
        if qmin[0] > pool * cap_frac:
            return  # nothing can fit (skip-ahead walk would pay nobody)
        qmin[1] = True
        k = 0
        while k < len(queue):
            cap = pool * cap_frac
            _, i = queue[k]
            a = q_amount[i]
            if 0 < a <= cap and a <= pool:
                pool -= a
                paid_cum += a
                paid_amt[i] = a
                paid_at[i] = s
                from_queue[i] = True
                paid_by_wtype[tape.tk_wtype[i]] += a
                queue.pop(k)
                queued_by_wallet[int(wallet[i])] -= 1
                close(i, CLAIMED)
            else:
                k += 1

    # ── curve-phase events (no claims before graduation) ─────────────────────
    ev_t = 0  # pointer into tickets
    rb_t = 0
    t_grad = tape.t_grad
    while ev_t < N and sell_ts[ev_t] < t_grad or rb_t < len(tape.rb_ts) and tape.rb_ts[rb_t] < t_grad:
        nt = sell_ts[ev_t] if ev_t < N else np.iinfo(np.int64).max
        nr = tape.rb_ts[rb_t] if rb_t < len(tape.rb_ts) else np.iinfo(np.int64).max
        if nt <= nr and nt < t_grad:
            create(ev_t)
            ev_t += 1
        elif nr < t_grad:
            rebuy(tape.rb_wallet[rb_t], float(tape.rb_tokens[rb_t]), int(nr))
            rb_t += 1
        else:
            break

    exp_ptr = 0  # tickets are sorted by sell_ts → expiry pointer
    price_tape, med, quote, base = tape.price, tape.median, tape.quote, tape.base
    for s in range(n_steps):
        now = t_grad + s * dt
        spot = price_tape[s]
        m = med[s]
        # 1. inflows
        bb_sol += tape.fum_fee[s] * pool_share
        if bb_sol > 0 and m == m and abs(spot - m) <= m * p.buyback_max_deviation_bps / fm.BPS:
            spend = min(bb_sol, quote[s] * p.buyback_max_pool_bps / fm.BPS)
            si = spend * (1 - PUMPSWAP_FEE)
            got = base[s] * si / (quote[s] + si)
            pool += got
            inflow_cum += got
            inflow_bb += got
            bb_sol -= spend
        lp_acc += tape.lp_fee[s]
        if (s + 1) % opt.skim_every_steps == 0 and lp_acc > 0:
            got = lp_acc / 2 / spot  # base half of the fee growth, withdrawn at the pool ratio
            pool += got
            inflow_cum += got
            inflow_lp += got
            lp_acc = 0.0
        # 2. events up to `now`
        while ev_t < N and sell_ts[ev_t] <= now or rb_t < len(tape.rb_ts) and tape.rb_ts[rb_t] <= now:
            nt = sell_ts[ev_t] if ev_t < N else np.iinfo(np.int64).max
            nr = tape.rb_ts[rb_t] if rb_t < len(tape.rb_ts) else np.iinfo(np.int64).max
            if nt <= nr:
                create(ev_t)
                ev_t += 1
            else:
                rebuy(tape.rb_wallet[rb_t], float(tape.rb_tokens[rb_t]), int(nr))
                rb_t += 1
        # 3. expiry of Open tickets
        while exp_ptr < ev_t and sell_ts[exp_ptr] + window < now:
            if status[exp_ptr] == OPEN:
                close(exp_ptr, EXPIRED)
            exp_ptr += 1
        # 4. crank
        crank(s)
        # 5. claims
        if m == m and open_set:
            # Open tickets live in [exp_ptr, ev_t) (older ones are closed or expired)
            thr = m / trig * (1 + 1e-12)  # median ≥ trigger × price
            seg = slice(exp_ptr, ev_t)
            hit = (price[seg] <= thr) & (status[seg] == OPEN)
            cand = np.nonzero(hit)[0] + exp_ptr if hit.any() else ()
            if len(cand):
                newq = cand[first_qual[cand] < 0]
                first_qual[newq] = s
                tries = cand[rng.random(len(cand)) < opt.claim_attempt_p]
                for i in tries:
                    i = int(i)
                    if status[i] != OPEN:
                        continue
                    amount = tokens[i] * claim_frac
                    if amount <= 0:
                        continue
                    if amount <= pool * cap_frac and amount <= pool:
                        pool -= amount
                        paid_cum += amount
                        paid_amt[i] = amount
                        paid_at[i] = s
                        paid_by_wtype[tape.tk_wtype[i]] += amount
                        close(i, CLAIMED)
                        continue
                    w = int(wallet[i])
                    if len(queue) >= p.queue_capacity:
                        blocked[i] += 1
                        blocked_full[i] = True
                        continue
                    if queued_by_wallet.get(w, 0) >= p.max_queue_entries_per_wallet:
                        blocked[i] += 1
                        blocked_d16[i] = True
                        continue
                    bisect.insort(queue, (int(sell_ts[i]), i))
                    qmin[1] = True
                    queued_by_wallet[w] = queued_by_wallet.get(w, 0) + 1
                    q_amount[i] = amount
                    queued_at[i] = s
                    status[i] = QUEUED
                    open_set.discard(i)
                    open_dirty = True
        lq = len(queue)
        if lq > peak_queue:
            peak_queue = lq
        if lq >= p.queue_capacity:
            queue_full_steps += 1
        if pool < min_pool:
            min_pool = pool
        if s % opt.record_every == 0 or s == n_steps - 1:
            rec_t.append(s * dt / DAY)
            rec_pool.append(pool)
            rec_q.append(lq)
            rec_paid.append(paid_cum)
            rec_in.append(inflow_cum)

    # tickets never reached (created after horizon) stay -1
    tickets = dict(sell_ts=sell_ts, wallet=wallet, price=price, tokens0=tape.tk_tokens, tokens=tokens,
                   status=status, first_qual=first_qual, queued_at=queued_at, paid_at=paid_at,
                   paid_amt=paid_amt, from_queue=from_queue, blocked=blocked, blocked_full=blocked_full,
                   blocked_d16=blocked_d16, phase=tape.tk_phase, wtype=tape.tk_wtype)
    summary = dict(pool0=pool0, pool_end=pool, min_pool=min_pool, inflow=inflow_cum, inflow_buyback=inflow_bb,
                   inflow_lp=inflow_lp, paid=paid_cum, peak_queue=peak_queue, queue_end=len(queue),
                   queue_full_steps=queue_full_steps, buyback_sol_unspent=bb_sol,
                   paid_by_wtype=paid_by_wtype.tolist(), n_steps=n_steps,
                   queue_owed_end=float(sum(q_amount[i] for _, i in queue)))
    return MechResult(tickets, np.array(rec_t), np.array(rec_pool), np.array(rec_q), np.array(rec_paid),
                      np.array(rec_in), summary)


def _plan_rebuy_float(views, amount, now, window):
    debits = [0.0] * len(views)
    order = [k for k, (ts, _i, tok, active) in enumerate(views)
             if active and tok > 0 and now >= ts and now - ts <= window]
    order.sort(key=lambda k: (views[k][0], views[k][1]), reverse=True)
    left = amount
    for k in order:
        if left <= 0:
            break
        d = min(left, views[k][2])
        debits[k] = d
        left -= d
    return debits
