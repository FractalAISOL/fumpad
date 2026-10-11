# FUMPAD reward-pool mechanism simulation

Agent-based, per-coin simulation of the FUMPAD reward pool: can pools pay claims, how
long claims wait, how full queues get, how often qualifying claims go unpaid, and how
sensitive this is to the parameters. **It measures mechanism health only. It makes no
revenue, profit, P&L or EV projections.** Findings are in [`REPORT.md`](REPORT.md).

## Setup

```bash
cd sim
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..                      # run everything from the repo root (package = sim)
```

Python 3.11, numpy, matplotlib; pytest for the tests. All versions are pinned.

## Run

```bash
# one coin: prints its metrics as JSON and writes sim/out/coin_<scenario>_<seed>_<variant>.png
sim/.venv/bin/python -m sim.run --scenario run_fade --seed 3

# one coin, compare variants on the same market (common random numbers)
sim/.venv/bin/python -m sim.run --scenario moon_hold --seed 7 --variant base,cap500,qcap1024

# batch: all scenarios × seeds 1..30, base parameters, summary table on stdout
sim/.venv/bin/python -m sim.run --scenario all --seeds 30 --jobs 8

# everything behind REPORT.md (base + all sweeps + abuse mix): ~40 min on 8 cores
sim/.venv/bin/python -m sim.run --full --seeds 30 --jobs 8
#   → sim/out/tables.md, summary.json, coins.json, pool_over_time.png, outcomes.png,
#     queue_wait.png, sensitivity.png

sim/.venv/bin/python -m sim.run --list      # scenarios and variants
sim/.venv/bin/python -m pytest sim/tests -q # math port + mechanism rules
```

Results are reproducible: a coin is fully determined by (scenario, seed, variant), and
the results don't depend on `--jobs`. Variants that change only the claim side
(trigger, claim bps, per-claim cap, queue capacity, D16, attentiveness) replay the
*same* market tape, so differences between them come from the parameter alone.

## Layout

| file | what it does |
|---|---|
| `fumpad_math.py` | Exact integer ports of `math/curve.rs`, `fees.rs`, `price.rs`, `reference.rs`, `rewards/logic.rs`, plus `Params` defaults from `constants.rs` / `state/global.rs`. `derive_curve` re-derives the curve for other reward-pool sizes (SPEC §3 method, reproduces the defaults exactly). |
| `paths.py` | Post-graduation price-path scenarios (`dies`, `slow_bleed`, `run_fade`, `multi_pump`, `choppy`, `moon_hold`), seeded. |
| `market.py` | Phase A. Curve trading with exact integer math (inline buybacks, D10 reference, D12 ticket price, 10-min hold, $50 minimum, creator exclusion), then AMM trading with agents (take-profit holders, scalpers, whales, rebuyers who come back through FUMPAD within 7 days, elsewhere within 7 days, or after 7 days; optional sybil spammers and self-impact round-trippers). Produces a tape. |
| `mechanism.py` | Phase B. Reward pool, tickets, rebuy rule, 5-open-ticket limit, claims, per-claim cap, skip-ahead queue (capacity, D16 2 per wallet), expiry, buyback crank (±3% band, 0.5% depth slices), hourly LP skim. |
| `metrics.py` | Per-coin and aggregated mechanism metrics. |
| `run.py` | CLI, variants and sweeps, multiprocessing. |
| `report.py` | Charts and generated tables. |
| `tests/` | The port checked against the Rust tests and defaults (≈85 SOL at completion, 14.7x start→graduation, price continuity, 50/30/20 fee split, D12 vectors, reference blend, rebuy vectors), plus mechanism rules on hand-built tapes. |

## Main knobs

* `fumpad_math.Params`: on-chain parameters (defaults = `constants.rs`), plus
  `queue_capacity` (a constant on chain) and `max_queue_entries_per_wallet` (D16, spec).
* `market.MarketParams`: behavioural assumptions (SOL/USD, turnover, FUMPAD-routed
  share, order sizes, wallet mix, rebuy mix, abuse counts).
* `mechanism.MechOptions`: claim attentiveness, skim cadence.

Add a variant by adding an entry to `VARIANTS` (and `TAPES` if it changes the market
phase) in `run.py`.
