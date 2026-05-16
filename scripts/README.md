# scripts/

Standalone tsx scripts for one-off and operational tasks. Run any of them with `pnpm exec tsx scripts/<name>.ts` or via `pnpm <script-alias>` when an alias exists in `package.json`.

---

## `evaluate-history.ts` — historical evaluator CSV

Joins lock-time `RaceAnalysis` snapshots to settled outcomes from `data/locked-recs.json` and emits a long-format CSV (one row per **race × horse × model**) that every downstream diagnostic consumes — calibration plot, Brier / log-loss, ROI by drift, SLAM_DUNK threshold sweep, per-track breakouts, blended-model backtest.

### Run

```bash
pnpm exec tsx scripts/evaluate-history.ts
```

No arguments. Reads `data/locked-recs.json`, writes `data/evaluations/history-YYYY-MM-DD.csv` (today's date), and prints a validation + P&L reconciliation summary to stdout.

### When to re-run

After each race day finishes settling. The CSV is a snapshot — re-running overwrites it with the latest joined state.

### CSV schema

One row per (race × horse × model). Columns in order:

| Group | Column | Type | Notes |
|---|---|---|---|
| Race identity | `race_id` | string | Composite key: `{trackCode}-{YYYY-MM-DD}-R{raceNumber}` |
| | `track_code` | string | Two- or three-letter code (CD, BEL, MTH, …) |
| | `race_date` | YYYY-MM-DD | From `race.postTimeUtc`; falls back to `lockedAt` date |
| | `race_number` | int | |
| | `surface`, `distance`, `race_class` | string | Always `null` today — not on the Race type. Reserved for when the adapter exposes them. |
| | `field_size` | int | Active runners (scratched excluded) |
| Horse identity | `horse_number` | string | Program number; coupled entries like `1A` preserved. **Null on sentinel rows** (model passed on a race that lacks an analysis snapshot). |
| | `horse_name` | string | Null when no analysis snapshot or on sentinel rows. |
| | `model` | string | `harville` or `henery`. Two rows per horse (roster path) or per ticket-touched horse (bet-driven path). |
| | `analysis_present` | 1/0 | True when the row was emitted from the roster-driven path (full analysis snapshot available); false from the bet-driven fallback path or sentinel rows. Filter to `analysis_present == 1` for any analysis that needs `p_win`/`p_place`/edge/pool data. |
| Model output | `p_win` | float | FLB-corrected win probability the model was fed |
| | `p_place`, `p_show` | float | Per-model place / show probability |
| | `win_fair_payout` | float | `2 / pWin` (per $2 bet). Same on both rows. |
| | `place_fair_payout`, `show_fair_payout` | float | Per-model (`2 / pPlace`, `2 / pShow`) |
| Projection | `win_proj_payout` | float | Projected $2 win payout from the pool. Same on both rows. |
| | `place_proj_mid`, `place_proj_floor` | float | Harville-weighted-companion mid + worst-case floor. Same on both rows — projection is a pool-state estimate, not a model output. |
| | `show_proj_mid`, `show_proj_floor` | float | Same. |
| Edges | `win_edge_mid` | float | `actual / fair − 1`. Same on both rows. |
| | `place_edge_mid`, `place_edge_floor` | float | Per-model (uses model fair price). |
| | `show_edge_mid`, `show_edge_floor` | float | Per-model. |
| Other signals | `ml_drift` | float | `(current_odds − ml_odds) / ml_odds`. Same on both rows. |
| | `signal_tag` | string | `slam_dunk` / `lean` / `drift` / `none`. **Harville-derived; identical on both model rows for a given horse.** The classifier does not run per-model in this codebase. |
| Pools | `win_pool`, `place_pool`, `show_pool` | float | Per-horse pool $ at lock |
| | `exacta_pool`, `trifecta_pool` | float | Total race pool $ at lock |
| Outcome | `finish_position` | int | From `race.results.runners`. `null` if unsettled or scratched. |
| | `won`, `placed`, `showed` | 1/0 | `placed` = finish ≤ 2, `showed` = finish ≤ 3. Null when unsettled. |
| | `realized_win_payoff`, `realized_place_payoff`, `realized_show_payoff` | float | Official $2 payouts. 0 for horses outside the relevant top-N. |
| Ticket roll-up | `tickets_count` | int | Tickets in *this model's* plan that touch this horse |
| | `total_stake_on_horse` | float | Sum of stake attributable to this horse from this model's plan |
| | `total_returned_on_horse` | float | Sum of returns attributable to this horse (null if unsettled) |
| | `pnl_on_horse` | float | `total_returned − total_stake` (null if unsettled) |
| Per bet-type | `stake_win`, `stake_place`, `stake_show`, `stake_exacta`, `stake_trifecta` | float | Same attribution, broken out by ticket type |
| | `pnl_win`, `pnl_place`, `pnl_show`, `pnl_exacta`, `pnl_trifecta` | float | Realized only; null when unsettled |
| Flags | `scratched` | 1/0 | |
| | `settlement_state` | string | `'settled'`, `'pending'`, or `'void'` — per-model. `'void'` = canceled/postponed/all-MTO race; treated as refund-in-full (totalReturn == totalStake, profit = 0). Downstream filters should use this column. |
| | `settled` | 1/0 | Back-compat boolean. True ONLY when `settlement_state == 'settled'`. Void and pending are both 0. |
| Timestamps | `lock_timestamp_utc` | ISO | When the plan was locked |
| | `settle_timestamp_utc` | ISO | When the settlement ran (from whichever model settled first) |

### Per-horse ticket attribution

A single ticket may touch multiple horses (exacta box, trifecta straight, etc.). The evaluator splits the ticket's stake and profit **evenly** across the horses it touches, so:

```
Σ_horses (stake_*)   ==  plan total stake     (reconciles exactly)
Σ_horses (pnl_on_horse) == settlement.totalProfit  (reconciles exactly)
```

This is the cleanest definition for downstream attribution and the script verifies the reconciliation at the end of every run.

### Records without analysis snapshots

`LockedRecommendation.analysis` was added recently. Records persisted *before* that change have no per-horse model probabilities or edges on disk. The evaluator handles them via the **bet-driven fallback path**: one row per ticket-touched horse per model, model-prob / edge / projection / pool columns blank. Outcome and ticket-aggregation columns are still fully populated.

For records with an analysis snapshot, the evaluator uses the **roster-driven path** instead: one row per horse in the full field, per model, regardless of whether the model bet on the horse. Tickets become a left-join — unbet horses get `tickets_count: 0` and zero stake/pnl but populated probability/edge/pool columns. This is required for calibration analysis (we need `(p_win, won)` pairs for every horse, not just bet-on ones).

The `analysis_present` column distinguishes the two paths.

The validation summary surfaces the split as `Records with analysis snapshot` / `Records missing analysis`. Newly-locked races from this point forward carry the analysis and populate all columns.

### Sentinel rows for empty plans

When a model legitimately passes on a race (returns an empty plan) AND the record has no analysis snapshot, the evaluator emits a single sentinel row with `horse_number: null`, `tickets_count: 0`, and all stake/pnl columns 0. Without this, "model passed" would look identical to "model never had a plan" downstream.

Sentinel rows are unnecessary on the roster path — every horse already gets a row, with zero stake/pnl when the model didn't bet on it.

### Validation output

Printed to stdout at the end of every run. Example:

```
=== EVALUATOR SUMMARY ===
Total locked records:           169
Settled:                        131 (77.5%)
Pending:                        38
Records with analysis snapshot: 0
Records missing analysis:       169  (older records — model-prob columns blank)
Total horse-model rows emitted: 1842
Rows with NaN p_win:            0  ← should be 0
Rows with NaN p_place_harville: 0  ← should be 0
Rows settled+no-finish (non-scratched): 0  ← should be 0
Scratched horse rows:           0
Tracks covered:                 BEL (42 races), CD (38 races), ...
Date range:                     2026-05-02 to 2026-05-10
CSV written:                    data/evaluations/history-2026-05-10.csv  (0.85 MB, 1842 rows)

=== P&L RECONCILIATION (settled races only) ===
                    Harville          Henery
Total stake         $1234.00          $1234.00
Total returned      $1100.50          $1180.25
Net P&L             $-133.50          $-53.75
ROI                 -10.8%            -4.4%

=== CSV-DERIVED CHECK (sum of per-horse pnl_on_horse) ===
Harville (rows): stake $1234.00, return $1100.50, pnl $-133.50
Henery   (rows): stake $1234.00, return $1180.25, pnl $-53.75
Row-vs-settlement max delta:    $0.00  ✓ reconciled to the penny
```

The `=== P&L RECONCILIATION ===` block is the source-of-truth check: it sums `BetSettlement.totalStake / totalReturn / totalProfit` per model across all settled records, using the same fallback logic as the day-summary xlsx export (`settlementByModel[model]` first, then legacy `settlement` for Harville). The `=== CSV-DERIVED CHECK ===` block independently re-aggregates from the emitted CSV rows. If the two ever disagree by more than a penny, the attribution math has a bug.

### Loading in pandas

```python
import pandas as pd
df = pd.read_csv("data/evaluations/history-2026-05-10.csv")
df.dtypes  # numeric columns parse as float64 / int64 cleanly
df.query("model == 'harville' and settled == 1").groupby("track_code").pnl_on_horse.sum()
```

All boolean columns emit as `1` / `0` / empty so pandas reads them as nullable numeric without dtype warnings.

---

## Other scripts in this directory

- `login.ts` — Playwright login flow (writes `auth/storageState.json` + `auth/network-capture.jsonl`). One-time setup; re-run when FDR session expires.
- `analyze-capture.ts` — Parses the captured JSONL and ranks pool-bearing endpoints. See `derby-edge-IMPLEMENTATION.md §8`.
- `backtest-day.ts` — Reads per-race xlsx exports and applies two betting policies side-by-side. Superseded by the historical evaluator for most diagnostics, but kept as a fixture-driven sanity check.
- `test-subscription.ts` — Ad-hoc developer tool for poking at FDR's live odds subscription channel.
