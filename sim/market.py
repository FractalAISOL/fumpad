"""Phase A — the market: bonding-curve trading (exact integer math) and post-graduation
trading on the PumpSwap pool, producing a *tape* the mechanism (Phase B) replays.

The tape holds everything the reward mechanism reacts to that does NOT depend on the
claim parameters: ticket candidates (wallet, time, tokens, D12 ticket price), FUMPAD buys
by ticket holders (rebuy rule), FUMPAD fees and LP fees per step, spot / oracle median /
pool depth per step. Splitting the phases lets the sensitivity sweeps over trigger,
claim bps, per-claim cap and queue capacity reuse one market run (common random numbers);
sweeps over reward-pool supply and fee pool share regenerate the tape because they
change the curve.

Post-graduation the price path is exogenous (paths.py). Order flow is conditioned on it:
with constant-product reserves (k fixed at graduation; LP-fee growth is skimmed, D11),
a price move from p to p' forces holders to absorb Δbase = √(k/p) − √(k/p') tokens.
Gross volume comes from a turnover model; agents decide WHO sells (take-profit targets,
scalpers, random holders weighted by balance) and who buys.
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field

import numpy as np

from . import fumpad_math as fm
from .paths import price_path

DAY = 86_400

# wallet types
CREATOR, RETAIL, SCALPER, WHALE, SPAMMER, ROUNDTRIP = range(6)
TYPE_NAMES = ["creator", "retail", "scalper", "whale", "spammer", "roundtrip"]
# rebuy modes
RB_NONE, RB_FUMPAD_7D, RB_ELSEWHERE_7D, RB_AFTER_7D = range(4)

PUMPSWAP_FEE = 0.0025  # non-canonical pool: 0.20% LP + 0.05% protocol (SPEC §1)
PUMPSWAP_LP_FEE = 0.0020


@dataclass(frozen=True)
class MarketParams:
    sol_usd: float = 150.0
    horizon_days: float = 180.0
    dt: int = 300  # post-graduation step (s)
    # curve phase
    curve_minutes_lo: float = 20.0
    curve_minutes_hi: float = 720.0
    curve_new_wallet_p: float = 0.85
    curve_hazard_per_min: float = 0.0015
    curve_tp_lo: float = 1.5
    curve_tp_hi: float = 6.0
    # order sizes (SOL), lognormal
    order_median_sol: float = 0.35
    order_sigma: float = 1.2
    whale_mult: float = 12.0
    # wallet mix for new buyers
    p_scalper: float = 0.35
    p_whale: float = 0.04
    scalper_hold_mean_min: float = 20.0
    tp_lo: float = 1.5
    tp_hi: float = 8.0
    # routing: share of wallets that trade through FUMPAD after graduation
    route_share: float = 0.4
    # post-graduation turnover (fraction of FDV per day)
    turnover0: float = 4.0
    turnover_tau_days: float = 1.5
    turnover_floor: float = 0.02
    activity_k: float = 3.0  # volume × (1 + k·|1h log return|)
    new_wallet_p: float = 0.6
    # rebuy behaviour: P(a sell schedules a rebuy) and the mode mix of rebuyers
    p_rebuyer: float = 0.35
    rebuy_mode_mix: tuple = (0.5, 0.3, 0.2)  # fumpad<7d, elsewhere<7d, fumpad>7d
    # abuse (0 = off)
    n_spammers: int = 0  # sybil wallets, 2 small tickets each on the curve
    n_roundtrippers: int = 0  # self-impact round-trippers (D12 cap)
    roundtrip_frac_of_base: float = 0.25


@dataclass
class Tape:
    scenario: str
    seed: int
    t_grad: int
    dt: int
    price: np.ndarray  # SOL / token
    median: np.ndarray  # NaN where < 25 min of samples
    base: np.ndarray  # AMM base reserve (tokens)
    quote: np.ndarray  # AMM quote reserve (SOL)
    fum_fee: np.ndarray  # FUMPAD fees collected per step (SOL, all three shares)
    lp_fee: np.ndarray  # PumpSwap LP fee growth per step (SOL value)
    # curve outcome
    pool_tokens_at_grad: float  # reward_pool_supply + inline buybacks (tokens)
    buyback_sol_at_grad: float  # pool-share lamports the curve could not spend
    curve_tokens_bought_back: float
    curve_volume_sol: float
    # ticket candidates (sorted by ts, then seq)
    tk_ts: np.ndarray
    tk_wallet: np.ndarray
    tk_tokens: np.ndarray
    tk_price: np.ndarray
    tk_phase: np.ndarray  # 0 curve, 1 amm
    tk_wtype: np.ndarray
    # FUMPAD buys by wallets that have ticket candidates (rebuy rule)
    rb_ts: np.ndarray
    rb_wallet: np.ndarray
    rb_tokens: np.ndarray
    info: dict = field(default_factory=dict)


class Wallets:
    def __init__(self, cap=4096):
        self.n = 0
        self._alloc(cap)

    def _alloc(self, cap):
        def grow(name, dtype, fill):
            old = getattr(self, name, None)
            a = np.full(cap, fill, dtype=dtype)
            if old is not None:
                a[: len(old)] = old
            setattr(self, name, a)

        for name, dt_, fill in [("bal", float, 0.0), ("matured", float, 0.0), ("pending", float, 0.0),
                                ("pend_since", np.int64, 0), ("cost", float, 0.0), ("tp", float, np.inf),
                                ("sell_at", float, np.inf), ("wtype", np.int8, 0), ("fum", bool, False),
                                ("rebuy", np.int8, 0), ("ticketed", bool, False), ("rebuy_pending", bool, False)]:
            grow(name, dt_, fill)
        self.cap = cap

    def new(self, wtype, fum, rebuy):
        if self.n == self.cap:
            self._alloc(self.cap * 2)
        i = self.n
        self.n += 1
        self.wtype[i], self.fum[i], self.rebuy[i] = wtype, fum, rebuy
        return i

    # Position (tracked tokens) — state/position.rs semantics, floats
    def settle(self, w, now, hold):
        if self.pending[w] > 0 and now - self.pend_since[w] >= hold:
            self.matured[w] += self.pending[w]
            self.pending[w] = 0.0

    def add_tracked(self, w, amount, now, hold):
        self.settle(w, now, hold)
        self.pending[w] += amount
        self.pend_since[w] = now

    def plan_sell(self, w, sold, balance_before, now, hold):
        self.settle(w, now, hold)
        excess = self.matured[w] + self.pending[w] - balance_before
        if excess > 0:
            m = min(excess, self.matured[w])
            self.matured[w] -= m
            self.pending[w] = max(self.pending[w] - (excess - m), 0.0)
        t = min(sold, self.matured[w])
        m = min(sold, self.matured[w])
        self.matured[w] -= m
        self.pending[w] = max(self.pending[w] - (sold - m), 0.0)
        return t


class Market:
    def __init__(self, scenario: str, seed: int, p: fm.Params, mp: MarketParams):
        self.scenario, self.seed, self.p, self.mp = scenario, seed, p, mp
        ss = np.random.SeedSequence([seed, sum(map(ord, scenario))])
        r_path, r_agents = (np.random.default_rng(s) for s in ss.spawn(2))
        self.rng_path, self.rng = r_path, r_agents
        self.W = Wallets()
        self.tk = []  # (ts, wallet, tokens, price, phase, wtype)
        self.rb = []  # (ts, wallet, tokens)
        self.hold = p.min_hold_secs
        self.min_usd = p.min_sell_usd_cents / 100.0

    # ── helpers ──────────────────────────────────────────────────────────────
    def order_sol(self, whale=False, scale=1.0):
        """Order size in SOL; `scale` grows with market cap (bigger coins, bigger trades)."""
        x = self.rng.lognormal(math.log(self.mp.order_median_sol * scale), self.mp.order_sigma)
        return min(x * (self.mp.whale_mult if whale else 1.0), 200.0 * scale)

    def new_wallet(self, post_grad: bool):
        mp, rng = self.mp, self.rng
        u = rng.random()
        wtype = SCALPER if u < mp.p_scalper else WHALE if u < mp.p_scalper + mp.p_whale else RETAIL
        fum = rng.random() < mp.route_share
        rebuy = RB_NONE
        if rng.random() < mp.p_rebuyer:
            rebuy = 1 + rng.choice(3, p=np.array(mp.rebuy_mode_mix) / sum(mp.rebuy_mode_mix))
        return self.W.new(wtype, fum, rebuy)

    def record_ticket(self, now, w, tokens, price, phase):
        self.tk.append((now, w, tokens, price, phase, int(self.W.wtype[w])))
        self.W.ticketed[w] = True

    def after_buy_targets(self, w, price, now, curve: bool):
        W, mp, rng = self.W, self.mp, self.rng
        if W.wtype[w] == SCALPER:
            W.sell_at[w] = now + rng.exponential(mp.scalper_hold_mean_min * 60)
        elif W.wtype[w] in (RETAIL, WHALE):
            lo, hi = (mp.curve_tp_lo, mp.curve_tp_hi) if curve else (mp.tp_lo, mp.tp_hi)
            W.tp[w] = price * math.exp(rng.uniform(math.log(lo), math.log(hi)))

    # ── curve phase (exact integer math) ─────────────────────────────────────
    def run_curve(self):
        p, mp, rng, W = self.p, self.mp, self.rng, self.W
        r = fm.CurveReserves.initial(p)
        ref = fm.ReferencePrice.new(r.spot_q64(), 1)
        self.c_pool_tokens = 0
        self.c_unspent = 0
        self.c_volume = 0
        state = {"done": False}

        def buy(w, sol, now):
            lam = int(sol * 1e9)
            q = fm.quote_buy(r, lam)
            if q.tokens_out == 0:
                return
            fee = fm.compute_fee(q.sol_used, p)
            pre = r.spot_q64()
            r.apply_buy(q)
            bb, unspent = fm.inline_buyback(r, fee.pool)
            self.c_pool_tokens += bb.tokens_out
            self.c_unspent += unspent
            self.c_volume += q.sol_used
            ref.update(now, pre, r.spot_q64(), True)
            tok = q.tokens_out / fm.TOKEN_UNIT
            price = q.sol_used / 1e9 / tok
            W.cost[w] = (W.cost[w] * W.bal[w] + price * tok) / (W.bal[w] + tok)
            W.bal[w] += tok
            W.add_tracked(w, tok, now, self.hold)
            if W.ticketed[w]:
                self.rb.append((now, w, tok))
            self.after_buy_targets(w, fm.q64_to_sol_per_token(r.spot_q64()), now, True)
            if q.completes or r.real_token == 0:
                state["done"] = True

        def sell(w, tokens, now):
            tin = min(int(tokens * fm.TOKEN_UNIT), int(W.bal[w] * fm.TOKEN_UNIT))
            if tin <= 0:
                return
            gross = fm.quote_sell(r, tin)
            if not gross:
                return
            fee = fm.compute_fee(gross, p)
            pre = r.spot_q64()
            r.apply_sell(tin, gross)
            bb, unspent = fm.inline_buyback(r, fee.pool)
            self.c_pool_tokens += bb.tokens_out
            self.c_unspent += unspent
            self.c_volume += gross
            ref.update(now, pre, r.spot_q64(), True)
            sold = tin / fm.TOKEN_UNIT
            bal_before = W.bal[w]
            W.bal[w] = max(bal_before - sold, 0.0)
            tt = W.plan_sell(w, sold, bal_before, now, self.hold)
            if W.wtype[w] != CREATOR and tt > 0:
                usd = gross / 1e9 * (tt / sold) * mp.sol_usd
                if usd >= self.min_usd:
                    tp_q = fm.ticket_price_q64(fm.price_q64(gross, tin), ref.avg_q64, pre)
                    self.record_ticket(now, w, tt, fm.q64_to_sol_per_token(tp_q), 0)
            if W.bal[w] <= 0:
                W.tp[w] = np.inf
                W.sell_at[w] = np.inf
            if r.real_token == 0:
                state["done"] = True

        # creator dev buy, abusers
        D = math.exp(rng.uniform(math.log(mp.curve_minutes_lo), math.log(mp.curve_minutes_hi)))
        creator = W.new(CREATOR, False, RB_NONE)
        buy(creator, rng.uniform(0.2, 2.0), 1)
        spammers = [W.new(SPAMMER, True, RB_NONE) for _ in range(mp.n_spammers)]
        spam_usd = 120.0  # each sybil buys once, then makes two sells ≥ $50 after the 10-min hold
        rts = [W.new(ROUNDTRIP, True, RB_NONE) for _ in range(mp.n_roundtrippers)]
        for i, w in enumerate(rts):
            buy(w, rng.uniform(3, 6), 5 + i)
        self.roundtrippers = rts

        m = 0
        max_minutes = int(D * 4) + 60
        while not state["done"]:
            m += 1
            t0 = m * 60
            behind = 1.0 + max(0.0, m / D - 1.0) * 2.0
            target_sol = 2.2 * 85.0 / D * behind
            actions = []
            # buys
            sol_left = rng.exponential(target_sol)
            while sol_left > 0:
                if rng.random() < mp.curve_new_wallet_p or W.n < 3:
                    w = self.new_wallet(False)
                else:
                    w = int(rng.integers(1, W.n))
                    if W.wtype[w] in (SPAMMER, ROUNDTRIP):
                        continue
                s = self.order_sol(W.wtype[w] == WHALE)
                s = min(s, sol_left + 0.05)
                sol_left -= s
                actions.append((t0 + int(rng.integers(0, 60)), 0, w, s))
            # sells: scalpers due, take-profit, hazard
            n = W.n
            spot = fm.q64_to_sol_per_token(r.spot_q64())
            held = W.bal[:n] > 0
            normal = held & (W.wtype[:n] != SPAMMER) & (W.wtype[:n] != ROUNDTRIP) & (W.wtype[:n] != CREATOR)
            for w in np.nonzero(normal & (W.sell_at[:n] <= t0))[0]:
                actions.append((t0 + int(rng.integers(0, 60)), 1, int(w), W.bal[w]))
            for w in np.nonzero(normal & (W.tp[:n] <= spot))[0]:
                actions.append((t0 + int(rng.integers(0, 60)), 1, int(w), W.bal[w] * rng.uniform(0.3, 1.0)))
                W.tp[w] = np.inf
            k = rng.poisson(mp.curve_hazard_per_min * normal.sum())
            if k:
                idx = np.nonzero(normal)[0]
                for w in rng.choice(idx, size=min(k, len(idx)), replace=False):
                    actions.append((t0 + int(rng.integers(0, 60)), 1, int(w), W.bal[w] * rng.uniform(0.2, 1.0)))
            # sybil spammers: buy at minute 1 + i, sell half at +11 min and the rest at +22 min
            for i, w in enumerate(spammers):
                if m == 1 + i:
                    actions.append((t0 + 1, 0, w, spam_usd / mp.sol_usd))
                elif W.bal[w] > 0 and m == 12 + i:
                    actions.append((t0 + 30, 1, w, W.bal[w] / 2))
                elif W.bal[w] > 0 and m == 23 + i:
                    actions.append((t0 + 30, 1, w, W.bal[w]))
            actions.sort(key=lambda a: (a[0], a[1]))
            for ts, kind, w, amt in actions:
                if state["done"]:
                    break
                if kind == 0:
                    buy(w, amt, ts)
                else:
                    sell(w, amt, ts)
            if m > max_minutes and not state["done"]:  # force completion (logged)
                need = fm.sol_for_tokens(r, r.real_token)
                buy(self.new_wallet(False), need / 1e9 * 1.0001 + 1e-6, t0 + 59)
                self.forced_completion = True
        self.t_grad = m * 60 + 60
        self.curve = r
        self.curve_minutes = m
        self.curve_target_minutes = D

    # ── post-graduation ──────────────────────────────────────────────────────
    def run_amm(self):
        p, mp, rng, W = self.p, self.mp, self.rng, self.W
        dt = mp.dt
        n = int(mp.horizon_days * DAY / dt)
        r = self.curve
        base0 = p.lp_supply / fm.TOKEN_UNIT
        quote0 = (r.real_sol - p.graduation_fee_lamports) / 1e9
        k0 = base0 * quote0
        p0 = quote0 / base0
        mult, info = price_path(self.scenario, self.rng_path, n, dt / DAY)
        price = p0 * mult
        base = np.sqrt(k0 / price)
        quote = np.sqrt(k0 * price)
        # oracle: lower median of the last 6 five-minute samples (≈ 30-min window),
        # valid once 25 min of samples exist (≈ 84-of-120 coverage)
        med = np.full(n, np.nan)
        win = 6
        for s in range(win - 1, n):
            med[s] = np.sort(price[s - win + 1: s + 1])[(win - 1) // 2]
        fum_fee = np.zeros(n)
        lp_fee = np.zeros(n)
        hold = self.hold
        # D10 reference on PumpSwap: v = max(last, pre); weight ≈ one 5-min step of a
        # 10-min average with frequent touches (EMA, α = 1 − e^(−300/600))
        alpha = 1 - math.exp(-dt / 600.0)
        ref = p0  # carried through graduation; curve ends at p0 (continuity)
        rebuys = []  # heap of (ts, seq, wallet, sol, via_fumpad)
        rt_next = {w: self.t_grad + int(rng.uniform(0.1, 3) * DAY) for w in self.roundtrippers}

        def amm_sell(w, tok, now, s, spot, b, q):
            tok = min(tok, W.bal[w])
            if tok <= 1e-9:
                return 0.0
            out = q * tok / (b + tok) * (1 - PUMPSWAP_FEE)
            bal_before = W.bal[w]
            W.bal[w] -= tok
            if W.bal[w] <= 1e-9:
                W.bal[w] = 0.0
                W.tp[w] = np.inf
                W.sell_at[w] = np.inf
            if W.fum[w]:
                fum_fee[s] += out * p.fee_bps / fm.BPS
                tt = W.plan_sell(w, tok, bal_before, now, hold)
                if W.wtype[w] != CREATOR and tt > 0 and out * (tt / tok) * mp.sol_usd >= self.min_usd:
                    exec_p = out / tok
                    self.record_ticket(now, w, tt, fm.ticket_price_float(exec_p, ref, spot), 1)
            if W.rebuy[w] != RB_NONE and not W.rebuy_pending[w] and W.wtype[w] in (RETAIL, WHALE):
                mode = W.rebuy[w]
                delay = rng.exponential(1.5 * DAY) if mode != RB_AFTER_7D else rng.uniform(7.05, 30) * DAY
                if mode != RB_AFTER_7D:
                    delay = min(delay, 6.9 * DAY)
                heapq.heappush(rebuys, (now + delay, len(self.rb) + w, w, out * rng.uniform(0.5, 1.2),
                                        mode != RB_ELSEWHERE_7D))
                W.rebuy_pending[w] = True
            return out

        def amm_buy(w, sol, now, s, spot, b, q, via_fumpad=None):
            fumv = W.fum[w] if via_fumpad is None else via_fumpad
            si = sol * (1 - PUMPSWAP_FEE)
            tok = b * si / (q + si)
            if fumv:
                fum_fee[s] += sol * p.fee_bps / fm.BPS
                W.add_tracked(w, tok, now, hold)
                if W.ticketed[w]:
                    self.rb.append((now, w, tok))
            W.cost[w] = (W.cost[w] * W.bal[w] + spot * tok) / (W.bal[w] + tok)
            W.bal[w] += tok
            self.after_buy_targets(w, spot, now, False)
            return tok

        for s in range(n):
            now = self.t_grad + s * dt
            spot, b, q = price[s], base[s], quote[s]
            prev = price[s - 1] if s else p0
            ref = ref + (max(prev, spot) - ref) * alpha
            tdays = s * dt / DAY
            r1h = abs(math.log(spot / price[max(s - 12, 0)]))
            u = (mp.turnover0 * math.exp(-tdays / mp.turnover_tau_days) + mp.turnover_floor) * (1 + mp.activity_k * r1h)
            G = u * (p.total_supply / fm.TOKEN_UNIT) * dt / DAY  # tokens traded this step
            net = (base[s - 1] if s else base0) - b  # tokens holders must absorb
            if G < abs(net):
                G = abs(net)
            S_target = (G - net) / 2
            vol_sol = 0.0
            scale = min(max(math.sqrt(spot / p0), 0.3), 10.0)
            # expected order ≈ 2× median for σ=1.2; keep ≤ ~60 orders per step
            scale = max(scale, G * spot / (60 * 2 * mp.order_median_sol))
            act = np.nonzero(W.bal[: W.n] > 0)[0]
            act = act[(W.wtype[act] != ROUNDTRIP) & (W.wtype[act] != SPAMMER)]
            bal = W.bal
            # desired sells
            orders = []
            for w in act[W.sell_at[act] <= now]:
                orders.append((int(w), bal[w]))
            for w in act[W.tp[act] <= spot]:
                frac = rng.uniform(0.3, 1.0)
                orders.append((int(w), bal[w] * frac))
                W.tp[w] = spot * rng.uniform(1.5, 4.0) if frac < 1 else np.inf
            D = sum(o[1] for o in orders)
            extra = max(S_target - D, 0.0)
            S_total = D + extra
            B = S_total + net
            if B < 0:
                extra += -B
                B = 0.0
            # random holder sells, ∝ balance
            if extra > 0:
                idx = act
                if len(idx):
                    wts = bal[idx]
                    tot = wts.sum()
                    if tot > 0:
                        extra = min(extra, tot * 0.98)
                        cw = np.cumsum(wts)
                        guard = 0
                        while extra > 1e-6 and guard < 400:
                            guard += 1
                            j = min(int(np.searchsorted(cw, rng.random() * tot)), len(idx) - 1)
                            w = int(idx[j])
                            amt = min(W.bal[w] * rng.uniform(0.2, 1.0), extra)
                            if amt <= 0:
                                continue
                            orders.append((w, amt))
                            extra -= amt
            rng.shuffle(orders)
            for w, amt in orders:
                vol_sol += amm_sell(w, amt, now, s, spot, b, q)
            # scheduled rebuys due
            while rebuys and rebuys[0][0] <= now:
                _, _, w, sol, via = heapq.heappop(rebuys)
                W.rebuy_pending[w] = False
                tok = amm_buy(w, sol, now, s, spot, b, q, via_fumpad=via and W.fum[w])
                vol_sol += sol
                B -= tok
            # remaining buys
            sol_left = max(B, 0.0) * spot
            guard = 0
            while sol_left > 1e-6 and guard < 2000:
                guard += 1
                if rng.random() < mp.new_wallet_p or W.n < 3:
                    w = self.new_wallet(True)
                else:
                    w = int(rng.integers(1, W.n))
                    if W.wtype[w] in (SPAMMER, ROUNDTRIP, CREATOR):
                        continue
                sol = min(self.order_sol(W.wtype[w] == WHALE, scale), sol_left)
                amm_buy(w, sol, now, s, spot, b, q)
                vol_sol += sol
                sol_left -= sol
            # self-impact round trips (abuse): big FUMPAD sell + same-bundle rebuy elsewhere
            for w in self.roundtrippers:
                if now >= rt_next[w] and W.bal[w] > 0:
                    W.settle(w, now, hold)
                    tok = min(b * mp.roundtrip_frac_of_base, W.matured[w])
                    if tok > 0:
                        out = amm_sell(w, tok, now, s, spot, b, q)
                        vol_sol += out
                        # rebuy elsewhere in the same bundle: balance restored, not tracked
                        W.bal[w] += tok
                        vol_sol += out
                    rt_next[w] = now + int(rng.uniform(0.5, 3) * DAY)
            lp_fee[s] = PUMPSWAP_LP_FEE * vol_sol
        self.tape_post = dict(price=price, median=med, base=base, quote=quote, fum_fee=fum_fee,
                              lp_fee=lp_fee, path_info=info, p0=p0, n=n)

    def tape(self) -> Tape:
        tp = self.tape_post
        tk = sorted(enumerate(self.tk), key=lambda x: (x[1][0], x[0]))
        tk = [x[1] for x in tk]
        rb = sorted(self.rb, key=lambda x: x[0])
        A = lambda rows, i, dt_: np.array([r_[i] for r_ in rows], dtype=dt_)  # noqa: E731
        return Tape(
            scenario=self.scenario, seed=self.seed, t_grad=self.t_grad, dt=self.mp.dt,
            price=tp["price"], median=tp["median"], base=tp["base"], quote=tp["quote"],
            fum_fee=tp["fum_fee"], lp_fee=tp["lp_fee"],
            pool_tokens_at_grad=(self.p.reward_pool_supply + self.c_pool_tokens) / fm.TOKEN_UNIT,
            buyback_sol_at_grad=self.c_unspent / 1e9,
            curve_tokens_bought_back=self.c_pool_tokens / fm.TOKEN_UNIT,
            curve_volume_sol=self.c_volume / 1e9,
            tk_ts=A(tk, 0, np.int64), tk_wallet=A(tk, 1, np.int64), tk_tokens=A(tk, 2, float),
            tk_price=A(tk, 3, float), tk_phase=A(tk, 4, np.int8), tk_wtype=A(tk, 5, np.int8),
            rb_ts=A(rb, 0, np.int64), rb_wallet=A(rb, 1, np.int64), rb_tokens=A(rb, 2, float),
            info=dict(path=tp["path_info"], p0=tp["p0"], curve_minutes=self.curve_minutes,
                      curve_target_minutes=self.curve_target_minutes,
                      forced_completion=getattr(self, "forced_completion", False),
                      n_wallets=self.W.n, raised_sol=self.curve.real_sol / 1e9),
        )


def simulate_market(scenario: str, seed: int, p: fm.Params | None = None, mp: MarketParams | None = None) -> Tape:
    m = Market(scenario, seed, p or fm.Params(), mp or MarketParams())
    m.run_curve()
    m.run_amm()
    return m.tape()
