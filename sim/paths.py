"""Post-graduation price-path scenarios (multiplier over the graduation price).

Each scenario = a deterministic log-shape drawn from seeded random parameters + an
Ornstein–Uhlenbeck noise term in log-price with fat-tailed (Student-t, df=3) shocks.
The path is EXOGENOUS: order flow in market.py is conditioned on it, it does not
cause it (see REPORT.md "where the model is weakest").

All times in days; the grid is `n` steps of `dt_days`.
"""
from __future__ import annotations

import numpy as np

MIN_MULT = 0.03  # below ~0.05x every holder has dumped into the LP (constant k), see market.py


SIGMA_DECAY_DAYS = 3.0  # volatility ∝ √activity (activity ≈ e^(−t/1.5d), market.py) → e^(−t/3d)


def _ou_noise(rng: np.random.Generator, n: int, dt: float, sigma: float, theta: float,
              floor: float) -> np.ndarray:
    """OU noise in log-price whose σ fades with trading activity down to `floor`·σ:
    a coin nobody trades does not move (and the AMM constraint in market.py would
    otherwise turn noise into fictitious volume)."""
    shocks = rng.standard_t(3, size=n) / np.sqrt(3.0)  # unit variance
    t = np.arange(n) * dt
    s = sigma * np.sqrt(dt) * np.maximum(np.exp(-t / SIGMA_DECAY_DAYS), floor)
    x = np.empty(n)
    acc = 0.0
    a = 1.0 - theta * dt
    for i in range(n):  # tiny loop, cheap relative to the agent sim
        acc = acc * a + s[i] * shocks[i]
        x[i] = acc
    return x


def _smoothstep(t, t0, t1):
    u = np.clip((t - t0) / max(t1 - t0, 1e-9), 0.0, 1.0)
    return u * u * (3 - 2 * u)


def shape_dies(rng, t):
    """Short pop after graduation, then decay to near zero within days."""
    pop = np.log(rng.uniform(1.1, 2.5))
    t_pop = rng.uniform(0.02, 0.25)
    floor = np.log(rng.uniform(0.04, 0.12))
    tau = rng.uniform(0.3, 2.0)
    rise = pop * _smoothstep(t, 0, t_pop)
    decay = np.where(t > t_pop, (pop - floor) * (1 - np.exp(-(t - t_pop) / tau)), 0.0)
    return rise - decay, {"pop": float(np.exp(pop)), "floor": float(np.exp(floor))}


def shape_slow_bleed(rng, t):
    """Steady decline: reaches 5–30% of graduation price after 30 days."""
    m30 = rng.uniform(0.05, 0.3)
    r = -np.log(m30) / 30.0
    floor = np.log(0.04)
    return np.maximum(-r * t, floor), {"m30": m30}


def shape_run_fade(rng, t):
    """One big run to 10x–100x (peak after 1–14 days), then fade to 10–30% of the peak."""
    peak = np.exp(rng.uniform(np.log(10), np.log(100)))
    t_peak = rng.uniform(1, 14)
    keep = rng.uniform(0.1, 0.3)
    tau = rng.uniform(3, 20)
    lp = np.log(peak)
    rise = lp * _smoothstep(t, 0, t_peak) ** 1.5
    fade = np.where(t > t_peak, -np.log(keep) * (1 - np.exp(-(t - t_peak) / tau)), 0.0)
    return np.where(t <= t_peak, rise, lp - fade), {"peak": peak, "t_peak": t_peak, "keep": keep}


def shape_multi_pump(rng, t):
    """2–4 pumps (each 2–8x from the level before it) within 60 days, 50–85% retrace
    after each, on a slowly bleeding base."""
    n = rng.integers(2, 5)
    times = np.sort(rng.uniform(0.2, 60, size=n))
    x = -0.01 * t
    for tp in times:
        h = np.log(rng.uniform(2, 8))
        dur = rng.uniform(0.2, 3)
        retr = rng.uniform(0.5, 0.85)
        tau = rng.uniform(1, 7)
        up = h * _smoothstep(t, tp, tp + dur)
        down = np.where(t > tp + dur, h * retr * (1 - np.exp(-(t - tp - dur) / tau)), 0.0)
        x = x + up - down
    return x, {"pumps": int(n)}


def shape_choppy(rng, t):
    """No trend: a level between 0.5x and 3x with large mean-reverting swings."""
    lvl = np.log(rng.uniform(0.5, 3.0))
    return lvl * _smoothstep(t, 0, 1) + 0 * t, {"level": float(np.exp(lvl))}


def shape_moon_hold(rng, t):
    """Runs to 20–60x over 3–20 days and holds there (stress case for the pool)."""
    peak = np.log(rng.uniform(20, 60))
    t_peak = rng.uniform(3, 20)
    return peak * _smoothstep(t, 0, t_peak), {"peak": float(np.exp(peak)), "t_peak": t_peak}


# name → (shape fn, OU σ per √day at launch, OU θ per day, σ floor as a fraction)
SCENARIOS = {
    "dies": (shape_dies, 0.8, 3.0, 0.1),
    "slow_bleed": (shape_slow_bleed, 0.6, 2.0, 0.2),
    "run_fade": (shape_run_fade, 0.8, 2.0, 0.25),
    "multi_pump": (shape_multi_pump, 0.8, 2.0, 0.25),
    "choppy": (shape_choppy, 1.2, 1.5, 0.5),
    "moon_hold": (shape_moon_hold, 0.6, 2.0, 0.25),
}


def price_path(scenario: str, rng: np.random.Generator, n: int, dt_days: float):
    fn, sigma, theta, floor = SCENARIOS[scenario]
    t = np.arange(n) * dt_days
    shape, info = fn(rng, t)
    noise = _ou_noise(rng, n, dt_days, sigma, theta, floor)
    noise -= noise[0]
    # start exactly at the graduation price, let noise in over the first ~hour
    ramp = np.clip(t / (1 / 24), 0, 1)
    m = np.exp(shape + noise * ramp)
    return np.maximum(m, MIN_MULT), info
