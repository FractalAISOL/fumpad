"""Per-coin mechanism-health metrics (no value / P&L figures by design)."""
from __future__ import annotations

import numpy as np

from .market import DAY, SPAMMER, ROUNDTRIP, Tape
from .mechanism import CLAIMED, EXPIRED, OPEN, QUEUED, REFUSED, VOIDED, MechResult


def coin_metrics(tape: Tape, res: MechResult, p, horizon_days: float) -> dict:
    T = res.tickets
    st = T["status"]
    window_days = p.claim_window_secs / DAY
    cutoff = tape.t_grad + (horizon_days - window_days) * DAY
    # cohort: tickets whose whole claim window fits inside the horizon
    coh = (T["sell_ts"] <= cutoff) & (st >= 0) & (st != REFUSED)
    q = coh & (T["first_qual"] >= 0)
    nq = int(q.sum())
    paid_inst = q & (st == CLAIMED) & ~T["from_queue"]
    paid_q = q & (st == CLAIMED) & T["from_queue"]
    unpaid_q = q & (st == QUEUED)
    expired = q & (st == EXPIRED)
    voided = q & (st == VOIDED)
    still_open = q & (st == OPEN)
    dt_days = tape.dt / DAY
    waits_paid = (T["paid_at"][paid_q] - T["queued_at"][paid_q]) * dt_days
    waits_unpaid = (res.summary["n_steps"] - 1 - T["queued_at"][unpaid_q]) * dt_days
    owed_q = T["tokens"][q] * p.claim_bps / 10_000
    paid_tokens_q = T["paid_amt"][q].sum()
    pool0 = res.summary["pool0"]
    supply_tokens = p.total_supply / 1e6
    curve_q = q & (T["phase"] == 0)
    abuse = np.isin(T["wtype"], [SPAMMER, ROUNDTRIP])
    pbw = res.summary["paid_by_wtype"]
    paid_total = res.summary["paid"]
    # time series → days to pool < 10% of starting pool
    below = np.nonzero(res.ts_pool < 0.1 * pool0)[0]
    return dict(
        scenario=tape.scenario, seed=tape.seed,
        tickets=int(coh.sum()), qualifying=nq,
        pct_qualifying=100 * nq / max(int(coh.sum()), 1),
        paid_instant=int(paid_inst.sum()), paid_queue=int(paid_q.sum()), unpaid_queued=int(unpaid_q.sum()),
        expired_unpaid=int(expired.sum()), voided_after_qual=int(voided.sum()), open_censored=int(still_open.sum()),
        expired_blocked_full=int((expired & T["blocked_full"]).sum()),
        expired_blocked_d16=int((expired & T["blocked_d16"]).sum()),
        refused_5_open=int(((st == REFUSED) & (T["sell_ts"] <= cutoff)).sum()),
        curve_qualifying=int(curve_q.sum()),
        curve_paid_tokens_pct_pool0=100 * T["paid_amt"][curve_q].sum() / pool0,
        owed_tokens_qual=float(owed_q.sum()), paid_tokens_qual=float(paid_tokens_q),
        wait_paid_days=waits_paid.tolist(), wait_unpaid_days=waits_unpaid.tolist(),
        peak_queue=res.summary["peak_queue"], queue_end=res.summary["queue_end"],
        queue_full_hours=res.summary["queue_full_steps"] * tape.dt / 3600,
        pool0_pct_supply=100 * pool0 / supply_tokens,
        min_pool_pct_pool0=100 * res.summary["min_pool"] / pool0,
        end_pool_pct_pool0=100 * res.summary["pool_end"] / pool0,
        inflow_pct_pool0=100 * res.summary["inflow"] / pool0,
        inflow_lp_share=res.summary["inflow_lp"] / max(res.summary["inflow"], 1e-12),
        paid_pct_available=100 * paid_total / (pool0 + res.summary["inflow"]),
        paid_pct_supply=100 * paid_total / supply_tokens,
        days_to_pool_below_10pct=float(res.ts_time[below[0]]) if len(below) else np.nan,
        abuse_paid_pct=100 * (pbw[SPAMMER] + pbw[ROUNDTRIP]) / max(paid_total, 1e-12),
        abuse_tickets_qual=int((q & abuse).sum()),
        curve_minutes=tape.info.get("curve_minutes"),
        path=tape.info.get("path"),
    )


def aggregate(rows: list[dict]) -> dict:
    """Pool ticket counts across coins (claim-weighted shares) + per-coin distributions."""
    s = lambda k: sum(r[k] for r in rows)  # noqa: E731
    nq = s("qualifying")
    n = s("tickets")
    pct = lambda k: 100 * s(k) / nq if nq else float("nan")  # noqa: E731
    wp = np.concatenate([np.array(r["wait_paid_days"], float) for r in rows]) if rows else np.array([])
    wu = np.concatenate([np.array(r["wait_unpaid_days"], float) for r in rows]) if rows else np.array([])
    unpaid_coin = [r for r in rows if r["qualifying"] > 0]
    med = lambda k: float(np.nanmedian([r[k] for r in rows]))  # noqa: E731
    p90 = lambda k: float(np.nanpercentile([r[k] for r in rows], 90))  # noqa: E731
    return dict(
        coins=len(rows), tickets=n, qualifying=nq,
        pct_qualifying=100 * nq / n if n else float("nan"),
        pct_paid_instant=pct("paid_instant"), pct_paid_queue=pct("paid_queue"),
        pct_unpaid_queued=pct("unpaid_queued"), pct_expired_unpaid=pct("expired_unpaid"),
        pct_voided=pct("voided_after_qual"),
        pct_unpaid_total=(100 * (s("unpaid_queued") + s("expired_unpaid")) / nq) if nq else float("nan"),
        pct_claim_tokens_paid=100 * s("paid_tokens_qual") / s("owed_tokens_qual") if s("owed_tokens_qual") else float("nan"),
        coins_with_qualifying=len(unpaid_coin),
        coins_any_unpaid=sum(1 for r in unpaid_coin if r["unpaid_queued"] + r["expired_unpaid"] > 0),
        wait_paid_median_days=float(np.median(wp)) if len(wp) else float("nan"),
        wait_paid_p90_days=float(np.percentile(wp, 90)) if len(wp) else float("nan"),
        wait_paid_max_days=float(np.max(wp)) if len(wp) else float("nan"),
        n_paid_from_queue=int(len(wp)), n_unpaid_queued=int(len(wu)),
        wait_unpaid_median_days=float(np.median(wu)) if len(wu) else float("nan"),
        peak_queue_median=med("peak_queue"), peak_queue_p90=p90("peak_queue"),
        peak_queue_max=float(max(r["peak_queue"] for r in rows)),
        coins_queue_full=sum(1 for r in rows if r["queue_full_hours"] > 0),
        queue_full_hours_p90=p90("queue_full_hours"),
        min_pool_pct_median=med("min_pool_pct_pool0"), min_pool_pct_p10=float(np.nanpercentile([r["min_pool_pct_pool0"] for r in rows], 10)),
        paid_pct_available_median=med("paid_pct_available"), paid_pct_available_p90=p90("paid_pct_available"),
        inflow_pct_pool0_median=med("inflow_pct_pool0"),
        pool0_pct_supply_median=med("pool0_pct_supply"),
        expired_blocked_full=s("expired_blocked_full"), expired_blocked_d16=s("expired_blocked_d16"),
        refused_5_open=s("refused_5_open"),
        curve_qualifying=s("curve_qualifying"),
        curve_paid_pct_pool0_median=med("curve_paid_tokens_pct_pool0"),
        abuse_paid_pct_median=med("abuse_paid_pct"),
        abuse_tickets_qual=s("abuse_tickets_qual"),
    )
