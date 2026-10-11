"""CLI.

  python -m sim.run --scenario run_fade --seed 3            # one coin, prints metrics + chart
  python -m sim.run --scenario all --seeds 30 --jobs 8      # base params, all scenarios
  python -m sim.run --full --seeds 30 --jobs 8              # base + every sweep → sim/out/, tables.md
  python -m sim.run --list                                  # scenarios and variants

Deterministic: a coin is fully determined by (scenario, seed, variant); results do not
depend on --jobs.
"""
from __future__ import annotations

import argparse
import json
import os
import pickle
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import replace

import numpy as np

from . import fumpad_math as fm
from .market import MarketParams, simulate_market
from .mechanism import MechOptions, run_mechanism
from .metrics import aggregate, coin_metrics
from .paths import SCENARIOS

OUT = os.path.join(os.path.dirname(__file__), "out")
BASE_P = fm.Params()
BASE_MP = MarketParams()
BASE_OPT = MechOptions()

# tape key → (Params for the market phase, MarketParams). Variants that only change the
# claim side reuse the "base" tape (common random numbers).
TAPES = {
    "base": (BASE_P, BASE_MP),
    "pool3": (BASE_P.with_reward_pool_supply(30_000_000_000_000), BASE_MP),
    "pool8": (BASE_P.with_reward_pool_supply(80_000_000_000_000), BASE_MP),
    "fee30": (BASE_P.with_fee_pool_share(3_000), BASE_MP),
    "fee70": (BASE_P.with_fee_pool_share(7_000), BASE_MP),
    "route20": (BASE_P, replace(BASE_MP, route_share=0.2)),
    "route70": (BASE_P, replace(BASE_MP, route_share=0.7)),
    "turn2": (BASE_P, replace(BASE_MP, turnover0=2.0)),
    "turn8": (BASE_P, replace(BASE_MP, turnover0=8.0)),
    "pool8fee70": (BASE_P.with_reward_pool_supply(80_000_000_000_000).with_fee_pool_share(7_000), BASE_MP),
    "abuse": (BASE_P, replace(BASE_MP, n_spammers=40, n_roundtrippers=3)),
}

# variant name → (group, label, tape key, mechanism Params, MechOptions)
VARIANTS = {"base": ("base", "defaults", "base", BASE_P, BASE_OPT)}
for m in (5, 20):
    VARIANTS[f"trig{m}"] = ("trigger multiple", f"{m}x", "base", replace(BASE_P, trigger_multiple_bps=m * 10_000), BASE_OPT)
for b in (500, 1500):
    VARIANTS[f"claim{b}"] = ("claim bps", f"{b // 100}%", "base", replace(BASE_P, claim_bps=b), BASE_OPT)
for b in (500, 2000):
    VARIANTS[f"cap{b}"] = ("per-claim cap", f"{b // 100}% of pool", "base", replace(BASE_P, max_claim_pool_bps=b), BASE_OPT)
for c in (64, 1024):
    VARIANTS[f"qcap{c}"] = ("queue capacity", str(c), "base", replace(BASE_P, queue_capacity=c), BASE_OPT)
VARIANTS["d16off"] = ("D16 per-wallet queue limit", "unlimited", "base", replace(BASE_P, max_queue_entries_per_wallet=10**9), BASE_OPT)
VARIANTS["lazy"] = ("claim attentiveness", "5%/step", "base", BASE_P, replace(BASE_OPT, claim_attempt_p=0.05))
for k in ("pool3", "pool8"):
    VARIANTS[k] = ("reward-pool supply", f"{k[4:]}%", k, TAPES[k][0], BASE_OPT)
for k in ("fee30", "fee70"):
    VARIANTS[k] = ("fee pool share", f"{k[3:]}%", k, TAPES[k][0], BASE_OPT)
for k in ("route20", "route70"):
    VARIANTS[k] = ("market: FUMPAD-routed share", f"{k[5:]}%", k, BASE_P, BASE_OPT)
for k in ("turn2", "turn8"):
    VARIANTS[k] = ("market: day-0 turnover", f"{k[4:]}x FDV/day", k, BASE_P, BASE_OPT)
VARIANTS["abuse"] = ("abuse mix", "40 sybils + 3 round-trippers", "abuse", BASE_P, BASE_OPT)
VARIANTS["d1floor"] = ("D1 curve tickets (not spec)", "priced ≥ graduation price", "base", BASE_P,
                       replace(BASE_OPT, curve_ticket_floor=1.0))
VARIANTS["abuse_d1floor"] = ("abuse mix + D1 floor (not spec)", "40 sybils + 3 round-trippers", "abuse", BASE_P,
                             replace(BASE_OPT, curve_ticket_floor=1.0))
# combined recommendation candidates (chosen after a first sweep; see REPORT.md)
VARIANTS["rec_claim750"] = ("recommendation", "claim 7.5%", "base", replace(BASE_P, claim_bps=750), BASE_OPT)
VARIANTS["rec_claim750_q1024"] = ("recommendation", "claim 7.5% + queue 1024", "base",
                                  replace(BASE_P, claim_bps=750, queue_capacity=1024), BASE_OPT)
VARIANTS["rec_pool8_q1024"] = ("recommendation", "pool 8% + queue 1024", "pool8",
                               replace(TAPES["pool8"][0], queue_capacity=1024), BASE_OPT)
VARIANTS["rec_pool8_fee70_q1024"] = ("recommendation", "pool 8% + fee share 70% + queue 1024", "pool8fee70",
                                     replace(TAPES["pool8fee70"][0], queue_capacity=1024), BASE_OPT)

BASE_HORIZON = BASE_MP.horizon_days


def run_unit(scenario: str, seed: int, tape_key: str, variants: list[str], keep_series: bool):
    p_mkt, mp = TAPES[tape_key]
    t0 = time.time()
    tape = simulate_market(scenario, seed, p_mkt, mp)
    rows, series = [], {}
    for v in variants:
        _, _, _, p, opt = VARIANTS[v]
        res = run_mechanism(tape, p, opt)
        row = coin_metrics(tape, res, p, mp.horizon_days)
        row["variant"] = v
        rows.append(row)
        if keep_series and v == "base":
            k = max(1, len(res.ts_time) // 360)  # ≈ every 12 h
            series = dict(t=res.ts_time[::k].tolist(), pool=(res.ts_pool[::k] / res.summary["pool0"]).tolist(),
                          queue=res.ts_queue[::k].tolist(),
                          price=(tape.price[:: k * 12] / tape.info["p0"]).tolist())
    return dict(scenario=scenario, seed=seed, tape=tape_key, rows=rows, series=series, secs=time.time() - t0)


def plan(scenarios, seeds, variants):
    by_tape = {}
    for v in variants:
        by_tape.setdefault(VARIANTS[v][2], []).append(v)
    return [(sc, sd, tk, vs, tk == "base") for sc in scenarios for sd in seeds for tk, vs in by_tape.items()]


def execute(units, jobs):
    out = []
    if jobs <= 1:
        for u in units:
            out.append(run_unit(*u))
        return out
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        futs = [ex.submit(run_unit, *u) for u in units]
        done = 0
        for f in as_completed(futs):
            out.append(f.result())
            done += 1
            if done % max(1, len(futs) // 20) == 0:
                print(f"  {done}/{len(futs)} units", file=sys.stderr, flush=True)
    return out


def summarize(results, variants):
    rows = [r for u in results for r in u["rows"]]
    table = {}
    for v in variants:
        for sc in SCENARIOS:
            rs = [r for r in rows if r["variant"] == v and r["scenario"] == sc]
            if rs:
                table[(v, sc)] = aggregate(rs)
    return rows, table


def print_table(table, variants):
    cols = ["pct_qualifying", "pct_paid_instant", "pct_paid_queue", "pct_unpaid_queued", "pct_expired_unpaid",
            "wait_paid_median_days", "peak_queue_p90", "min_pool_pct_median"]
    print("variant      scenario     " + " ".join(f"{c[:14]:>14}" for c in cols))
    for (v, sc), a in table.items():
        if v in variants:
            print(f"{v:12} {sc:12} " + " ".join(f"{a[c]:14.2f}" for c in cols))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", default="all", help="scenario name or 'all'")
    ap.add_argument("--seed", type=int, help="run a single coin with this seed")
    ap.add_argument("--seeds", type=int, default=20, help="seeds 1..N for batch runs")
    ap.add_argument("--variant", default="base", help="comma-separated variant names (batch)")
    ap.add_argument("--full", action="store_true", help="every variant + write sim/out/ and tables.md")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--replot", action="store_true", help="rebuild sim/out/ from the last --full run (raw.pkl)")
    a = ap.parse_args(argv)

    if a.list:
        print("scenarios:", ", ".join(SCENARIOS))
        for k, (g, lbl, tk, _, _) in VARIANTS.items():
            print(f"  {k:10} {g}: {lbl} (tape: {tk})")
        return
    scenarios = list(SCENARIOS) if a.scenario == "all" else a.scenario.split(",")
    for sc in scenarios:
        if sc not in SCENARIOS:
            ap.error(f"unknown scenario {sc}")
    os.makedirs(OUT, exist_ok=True)
    raw = os.path.join(OUT, "raw.pkl")
    if a.replot:
        from .report import write_outputs
        with open(raw, "rb") as f:
            results, variants, seeds = pickle.load(f)
        rows, table = summarize(results, variants)
        write_outputs(results, rows, table, seeds)
        return

    if a.seed is not None and not a.full:
        from .report import coin_chart
        variants = a.variant.split(",")
        for sc in scenarios:
            p_mkt, mp = TAPES[VARIANTS[variants[0]][2]]
            tape = simulate_market(sc, a.seed, p_mkt, mp)
            for v in variants:
                p, opt = VARIANTS[v][3], VARIANTS[v][4]
                res = run_mechanism(tape, p, opt)
                m = coin_metrics(tape, res, p, mp.horizon_days)
                show = {k: (round(x, 3) if isinstance(x, float) else x) for k, x in m.items()
                        if not k.startswith("wait_")}
                print(json.dumps(show, default=str, indent=1))
                path = coin_chart(tape, res, p, os.path.join(OUT, f"coin_{sc}_{a.seed}_{v}.png"))
                print("chart:", path)
        return

    variants = list(VARIANTS) if a.full else a.variant.split(",")
    seeds = list(range(1, a.seeds + 1))
    units = plan(scenarios, seeds, variants)
    print(f"{len(units)} market runs × variants, {a.jobs} workers", file=sys.stderr)
    t0 = time.time()
    results = execute(units, a.jobs)
    print(f"done in {time.time() - t0:.0f}s", file=sys.stderr)
    rows, table = summarize(results, variants)
    print_table(table, variants)
    if a.full:
        from .report import write_outputs
        with open(raw, "wb") as f:
            pickle.dump((results, variants, seeds), f)
        write_outputs(results, rows, table, seeds)


if __name__ == "__main__":
    main()
