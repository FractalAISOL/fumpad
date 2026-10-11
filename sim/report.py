"""Charts (PNG) and generated tables for REPORT.md. Mechanism metrics only."""
from __future__ import annotations

import json
import math
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from .paths import SCENARIOS  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "out")
# reference categorical palette (light), fixed order
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
INK, INK2, GRID, SURF = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"

plt.rcParams.update({
    "figure.facecolor": SURF, "axes.facecolor": SURF, "axes.edgecolor": GRID, "axes.labelcolor": INK2,
    "xtick.color": INK2, "ytick.color": INK2, "text.color": INK, "axes.grid": True, "grid.color": GRID,
    "grid.linewidth": 0.6, "axes.spines.top": False, "axes.spines.right": False, "font.size": 9,
    "axes.titlesize": 10, "axes.titleweight": "bold", "lines.linewidth": 2,
})


def coin_chart(tape, res, p, path):
    fig, ax = plt.subplots(3, 1, figsize=(8, 7), sharex=True)
    t = np.arange(len(tape.price)) * tape.dt / 86400
    ax[0].plot(t, tape.price / tape.info["p0"], color=SERIES[0], lw=1)
    ax[0].set_yscale("log")
    ax[0].set_ylabel("price / graduation price")
    ax[0].set_title(f"{tape.scenario} seed {tape.seed}")
    ax[1].plot(res.ts_time, res.ts_pool / 1e6, color=SERIES[0])
    ax[1].set_ylabel("reward pool (M tokens)")
    ax[2].plot(res.ts_time, res.ts_queue, color=SERIES[0])
    ax[2].axhline(p.queue_capacity, color=INK2, lw=1, ls="--")
    ax[2].text(t[-1], p.queue_capacity, "capacity", color=INK2, ha="right", va="bottom")
    ax[2].set_ylabel("queue length")
    ax[2].set_xlabel("days since graduation")
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)
    return path


def _clean(x):
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    return x


def chart_pool(results, path):
    scs = list(SCENARIOS)
    fig, axs = plt.subplots(2, 3, figsize=(11, 6), sharex=True, sharey=True)
    for ax, sc in zip(axs.flat, scs):
        S = [u["series"] for u in results if u["scenario"] == sc and u["series"]]
        if not S:
            continue
        n = min(len(s["pool"]) for s in S)
        P = np.array([s["pool"][:n] for s in S]) * 100
        t = np.array(S[0]["t"][:n])
        lo, md, hi = np.percentile(P, [10, 50, 90], axis=0)
        ax.fill_between(t, np.maximum(lo, 0.05), hi, color=SERIES[0], alpha=0.18, lw=0)
        ax.plot(t, np.maximum(md, 0.05), color=SERIES[0])
        ax.axhline(100, color=INK2, lw=1, ls=":")
        ax.set_yscale("log")
        ax.set_title(sc)
    for ax in axs[:, 0]:
        ax.set_ylabel("pool, % of pool at graduation")
    for ax in axs[1]:
        ax.set_xlabel("days since graduation")
    fig.suptitle("Reward pool balance — median and 10th–90th percentile across coins (defaults)", fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def chart_outcomes(table, path, variant="base"):
    scs = [sc for sc in SCENARIOS if (variant, sc) in table and table[(variant, sc)]["qualifying"] > 0]
    cats = [("pct_paid_instant", "paid instantly"), ("pct_paid_queue", "paid from queue"),
            ("pct_unpaid_queued", "still queued at day 180"), ("pct_expired_unpaid", "expired unpaid"),
            ("pct_voided", "voided by rebuy")]
    fig, ax = plt.subplots(figsize=(9, 0.55 * len(scs) + 1.6))
    y = np.arange(len(scs))
    left = np.zeros(len(scs))
    for k, (key, lbl) in enumerate(cats):
        v = np.array([table[(variant, sc)][key] for sc in scs])
        ax.barh(y, v, left=left, color=SERIES[k], edgecolor=SURF, linewidth=2, label=lbl, height=0.6)
        for yi, (l0, vi) in enumerate(zip(left, v)):
            if vi >= 6:
                ax.text(l0 + vi / 2, yi, f"{vi:.0f}%", ha="center", va="center", color="white", fontsize=8)
        left += v
    ax.set_yticks(y, [f"{sc} (n={table[(variant, sc)]['qualifying']})" for sc in scs])
    ax.invert_yaxis()
    ax.set_xlim(0, 100)
    ax.set_xlabel("% of tickets that reached the trigger (pooled across coins)")
    ax.grid(axis="y", visible=False)
    ax.legend(ncol=5, loc="upper center", bbox_to_anchor=(0.5, -0.18), frameon=False, fontsize=8)
    ax.set_title("What happens to tickets that reach 10x (defaults)")
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def chart_waits(rows, path, variant="base"):
    fig, ax = plt.subplots(figsize=(8, 4.2))
    for k, sc in enumerate(SCENARIOS):
        w = np.concatenate([np.array(r["wait_paid_days"]) for r in rows
                            if r["variant"] == variant and r["scenario"] == sc] or [np.array([])])
        if len(w) < 5:
            continue
        w = np.sort(np.maximum(w, 1 / 288))
        ax.plot(w, np.arange(1, len(w) + 1) / len(w) * 100, color=SERIES[k], label=f"{sc} (n={len(w)})")
    ax.set_xscale("log")
    ax.set_xlabel("time in queue before payout (days, log)")
    ax.set_ylabel("% of queued claims paid within")
    ax.set_title("Time in queue for claims that were paid from the queue (defaults)")
    ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def chart_sensitivity(table, path, scenarios=("run_fade", "moon_hold", "multi_pump", "choppy")):
    from .run import VARIANTS
    groups = {}
    for v, (g, lbl, *_r) in VARIANTS.items():
        if g in ("base", "abuse mix", "D1 curve tickets (not spec)", "abuse mix + D1 floor (not spec)", "claim attentiveness", "recommendation", "D16 per-wallet queue limit"):
            continue
        groups.setdefault(g, []).append((v, lbl))
    base_lbl = {"trigger multiple": "10x", "claim bps": "10%", "per-claim cap": "10% of pool",
                "queue capacity": "256", "reward-pool supply": "5%", "fee pool share": "50%",
                "market: FUMPAD-routed share": "40%", "market: day-0 turnover": "4x FDV/day"}
    G = list(groups)
    fig, axs = plt.subplots(2, math.ceil(len(G) / 2), figsize=(13, 6.2), sharey=True)
    for ax, g in zip(axs.flat, G):
        vs = sorted(groups[g] + [("base", base_lbl[g] + " (default)")],
                    key=lambda x: _sort_key(x[1]))
        x = np.arange(len(vs))
        for k, sc in enumerate(scenarios):
            yv = [table.get((v, sc), {}).get("pct_unpaid_total", np.nan) for v, _ in vs]
            ax.plot(x, yv, marker="o", ms=6, color=SERIES[k], label=sc, lw=1.5)
        ax.set_xticks(x, [l_ for _, l_ in vs], fontsize=7.5)
        ax.set_title(g, fontsize=9)
    for ax in axs[:, 0]:
        ax.set_ylabel("% of qualifying tickets unpaid\n(queued at day 180 + expired)")
    for ax in list(axs.flat)[len(G):]:
        ax.axis("off")
    axs.flat[0].legend(frameon=False, fontsize=8)
    fig.suptitle("Sensitivity: unpaid share of qualifying tickets", fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def _sort_key(lbl):
    try:
        return float(lbl.split("%")[0].split("x")[0].split(" ")[0])
    except ValueError:
        return 0.0


def fmt(x, d=1):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "–"
    return f"{x:.{d}f}"


def tables_md(table, seeds):
    from .run import VARIANTS
    L = [f"<!-- generated by `python -m sim.run --full --seeds {len(seeds)}` -->", ""]
    L.append("### Base parameters, per scenario")
    L.append("")
    L.append("| scenario | coins | tickets | % reach 10x | paid instantly | paid from queue | still queued (d180) | expired unpaid | voided | claim tokens paid | queue wait median / p90 (d) | peak queue p90 / max | coins w/ full queue | pool min (median % of start) | paid / available (median) |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for sc in SCENARIOS:
        a = table.get(("base", sc))
        if not a:
            continue
        L.append(f"| {sc} | {a['coins']} | {a['tickets']} | {fmt(a['pct_qualifying'], 2)}% | {fmt(a['pct_paid_instant'])}% | "
                 f"{fmt(a['pct_paid_queue'])}% | {fmt(a['pct_unpaid_queued'])}% | {fmt(a['pct_expired_unpaid'])}% | "
                 f"{fmt(a['pct_voided'])}% | {fmt(a['pct_claim_tokens_paid'])}% | "
                 f"{fmt(a['wait_paid_median_days'], 2)} / {fmt(a['wait_paid_p90_days'], 1)} | "
                 f"{fmt(a['peak_queue_p90'], 0)} / {fmt(a['peak_queue_max'], 0)} | {a['coins_queue_full']} | "
                 f"{fmt(a['min_pool_pct_median'])}% | {fmt(a['paid_pct_available_median'])}% |")
    L.append("")
    L.append("Percentages of qualifying tickets are pooled across coins (count-weighted); "
             "'claim tokens paid' weights by claim size.")
    L.append("")
    L.append("### Sensitivity (each row changes one thing vs defaults)")
    L.append("")
    focus = ["run_fade", "moon_hold", "multi_pump", "choppy"]
    hdr = "| parameter | value | " + " | ".join(f"{sc}: unpaid % / wait p90 d / peak q p90" for sc in focus) + " |"
    L.append(hdr)
    L.append("|---|---|" + "---|" * len(focus))
    for v, (g, lbl, *_r) in VARIANTS.items():
        if not any((v, sc) in table for sc in focus):
            continue
        cells = []
        for sc in focus:
            a = table.get((v, sc))
            cells.append("–" if not a else f"{fmt(a['pct_unpaid_total'])} / {fmt(a['wait_paid_p90_days'], 1)} / {fmt(a['peak_queue_p90'], 0)}")
        L.append(f"| {g} | {lbl} | " + " | ".join(cells) + " |")
    L.append("")
    L.append("### Pool funding and reach (base)")
    L.append("")
    L.append("| scenario | pool at graduation (% supply, median) | inflows over 180 d (% of start pool, median) | D1 curve tickets reaching 10x | curve-ticket payouts (% of start pool, median) | expired because queue full / D16 | sells refused a ticket (5-open limit) |")
    L.append("|---|---|---|---|---|---|---|")
    for sc in SCENARIOS:
        a = table.get(("base", sc))
        if a:
            L.append(f"| {sc} | {fmt(a['pool0_pct_supply'] if 'pool0_pct_supply' in a else a['pool0_pct_supply_median'], 2)}% | "
                     f"{fmt(a['inflow_pct_pool0_median'], 0)}% | {a['curve_qualifying']} | {fmt(a['curve_paid_pct_pool0_median'], 2)}% | "
                     f"{a['expired_blocked_full']} / {a['expired_blocked_d16']} | {a['refused_5_open']} |")
    L.append("")
    L.append("### Abuse mix (40 sybil curve sellers × 2 tickets, 3 self-impact round-trippers)")
    L.append("")
    L.append("| scenario | unpaid % (abuse run) | unpaid % (base) | abusive tickets reaching 10x | share of payouts to abusive wallets (median) | peak queue p90 |")
    L.append("|---|---|---|---|---|---|")
    for sc in SCENARIOS:
        a, b = table.get(("abuse", sc)), table.get(("base", sc))
        if a and b:
            L.append(f"| {sc} | {fmt(a['pct_unpaid_total'])} | {fmt(b['pct_unpaid_total'])} | {a['abuse_tickets_qual']} | "
                     f"{fmt(a['abuse_paid_pct_median'])}% | {fmt(a['peak_queue_p90'], 0)} |")
    return "\n".join(L) + "\n"


def write_outputs(results, rows, table, seeds):
    os.makedirs(OUT, exist_ok=True)
    flat = [{k: _clean(v) for k, v in r.items() if not k.startswith("wait_")} for r in rows]
    with open(os.path.join(OUT, "coins.json"), "w") as f:
        json.dump(flat, f, default=str)
    with open(os.path.join(OUT, "summary.json"), "w") as f:
        json.dump({f"{v}|{sc}": {k: _clean(x) for k, x in a.items()} for (v, sc), a in table.items()}, f, indent=1)
    chart_pool(results, os.path.join(OUT, "pool_over_time.png"))
    chart_outcomes(table, os.path.join(OUT, "outcomes.png"))
    chart_waits(rows, os.path.join(OUT, "queue_wait.png"))
    chart_sensitivity(table, os.path.join(OUT, "sensitivity.png"))
    with open(os.path.join(OUT, "tables.md"), "w") as f:
        f.write(tables_md(table, seeds))
    print("wrote", OUT)
