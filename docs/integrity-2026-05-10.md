# Evaluator integrity report — 2026-05-10

Investigation triggered by the first historical-evaluator CSV
(`data/evaluations/history-2026-05-10.csv`, 618 rows). Three issues
surfaced; this document records the root cause and action taken for
each.

---

## Issue 1 — BEL-2026-05-10 missing from CSV

**Finding:** The data is **genuinely absent from disk.** Not an evaluator
bug.

Direct inspection of `data/locked-recs.json`:

| Track | Date | Records |
|---|---|---|
| BEL | 2026-05-03 | 12 |
| BEL | 2026-05-10 | **0** |

Zero records anywhere in the JSON have `lockedAt` starting with
`2026-05-10` and `raceId` starting with `BEL-`. The `export/` directory
also contains no files matching `BEL.*2026-05-10`.

**Likely causes** (ranked by plausibility, none verifiable from the data):

1. The user has a `BEL-2026-05-10-summary.xlsx` that was generated
   in-memory at the time and never round-tripped through the
   `lockedRecs` persistence layer. The day-summary export reads from
   the in-memory store; if Excel was written before persistence flushed
   (or a server restart wiped the in-memory map), the xlsx would exist
   without a corresponding JSON entry. *Most likely.*
2. BEL was not in `TRACKED_TRACKS` on 2026-05-10 — the dashboard saw
   the races but no lock endpoints fired.
3. A write to `locked-recs.json` was corrupted/truncated on 2026-05-10,
   replacing BEL records with whatever the in-memory map held at the
   moment of the failed write.

**Action taken:** None. Per the spec, we do **not** attempt to backfill
from the Excel summaries — the round-trip is lossy (Excel doesn't
preserve `analysis`, per-horse pools, or any of the structure we need)
and risks corrupting the working JSON. The data is gone for downstream
analysis. The evaluator's new `=== INTEGRITY POST-FIX ===` block
reports `BEL-2026-05-10 races in CSV: 0` so any future drift in this
metric is immediately visible.

**Preventive recommendation** (out of scope for this PR): the
day-summary xlsx export should refuse to write if the locked-rec for
any race in the day is missing or has not yet been persisted to disk.
That would have made this discrepancy a hard error at the time, not
a silent data-loss event.

---

## Issue 2 — CD R10 settled with NaN finish_position

**Finding:** The hypothesis (auto-settler turning canceled races into
silent −100% ROI) was **wrong for this specific record**, but the
underlying defensive change is still worth shipping.

Investigation of `CD-10` (lockedAt `2026-05-10T21:25:31.411Z`):

| Ticket | Outcome | Note |
|---|---|---|
| show #7 | lost | `#7 finished out of the top 3.` |
| show #10 | lost | `#10 finished out of the top 3.` |
| exacta straight 7-8 | lost | `Selection 7-8 ≠ official 12-6.` |
| exacta straight 8-7 | lost | `Selection 8-7 ≠ official 12-6.` |

CD R10 ran. Official finish order: 12-6. Tickets legitimately lost.
The "NaN finish_position" in the original CSV was an artifact of CD R10
being a **legacy record without an `analysis` snapshot** — the
race.results data only lives on the analysis snapshot, and legacy
records lack it. The settlement engine HAD the results at the moment
it settled (otherwise it wouldn't know that #12 beat #6), but those
results were not persisted to the locked-rec.

I also scanned all 169 records for tickets carrying "no result entry"
notes (the canonical void signal):

```
Records with at least one no-result-entry ticket: 0
```

And ran a broader scan for "every ticket on every settlement lost"
to catch any race that might be a void in disguise. Sample inspection
(PHI-1, PHI-2, PHI-3, TDN-2, etc.) shows all of these were real losses
with documented finish orders ("official 5-7", "official 4-1", etc.) —
just unlucky days where every wagered horse missed.

**Conclusion:** zero genuine void races exist in the current
`locked-recs.json`. The user's hypothesis was incorrect for the
observed data.

**Action taken (defensive):** Even though no record qualifies today, the
risk is real for future canceled / postponed / all-MTO races. We
shipped:

1. New `SettlementState = 'settled' | 'void'` type on `BetSettlement`.
2. `settleBetPlan()` now detects voids and returns a settlement with
   `state: 'void'`, every ticket carrying `returned == amount` (full
   refund), `profit: 0`, and a `note` containing "void". Previously the
   function returned `null` when `runners.length === 0`, and any path
   where runner records existed without `finishPosition` would have
   yielded `cashed: false` ticket-level losses summed to a clean −100%
   ROI.
3. The evaluator now emits a `settlement_state` column (`'settled' |
   'pending' | 'void'`). The legacy `settled` boolean column remains
   for back-compat but is true ONLY when `settlement_state ==
   'settled'`. Void settlements are excluded from the P&L
   reconciliation totals (refunds aren't bet outcomes).
4. `tests/simulation.settle.test.ts` has three new unit tests covering:
   empty `runners`, runners with no `finishPosition`, and the normal
   settled path producing `state: 'settled'`.

**Backfill scan output (no-op):**

```
Races with settlement_state='void': 0
```

If a void race ever shows up in future data, the auto-settler will mark
it correctly; the evaluator will surface it in the integrity block;
no manual backfill is needed.

---

## Issue 3 — 51 races with 0 Henery rows

**Finding:** Pre-feature legacy data, not a current persistence bug.

Classification of the 169 records by plan structure:

| Plan structure | Count |
|---|---|
| `betPlanByModel` present, both `harville` AND `henery` plans | 101 |
| `betPlanByModel` present, only one model | **0** |
| `betPlan` (legacy field) present, no `betPlanByModel` field at all | **49** |
| No structured plan (voice-pick-only or full-text-only) | 19 |

**Distribution of the 49 legacy-only records by date:**

| Date | Count |
|---|---|
| 2026-05-03 | 3 (BEL-10, BEL-11, BEL-12) |
| 2026-05-04 | 46 (SA, WBS, NFL, MR, etc.) |

The Henery model and `betPlanByModel` feature shipped some time
between 2026-05-04 and 2026-05-10. Records from before that change
have only the legacy `betPlan` field, populated by the original
single-model code path. There is NO record where `betPlanByModel`
exists but the `henery` slot is missing — the persistence path is
working correctly for current records.

The 2 records with `betPlanByModel.henery: { tickets: [] }` (PRC-4 on
2026-05-04, CD-3 on 2026-05-10) reflect the model legitimately passing
on the race.

**Action taken:**

1. **No code fix to the persistence path** — there's no current bug.
2. **No backfill** of the 49 legacy records — the analysis snapshots
   are also missing for those races, so we can't regenerate Henery
   plans. Lost to history.
3. **Evaluator change**: sentinel-row emission for records where a
   model has an empty plan AND no analysis snapshot. Without this,
   PRC-4 (Henery passed) and CD-3 (Henery passed) would have looked
   identical to "Henery never had a plan" in the CSV — both states
   produced zero rows. The sentinel row makes "passed" visible:

   ```
   PRC-2026-05-04-R4,PRC,2026-05-04,4,,,,,,,henery,0,...,0,0,0,...,settled,1,...
   ```

   `horse_number` and `horse_name` are null on sentinel rows; all
   stake/pnl columns are 0; `tickets_count` is 0.

4. **Issue 4 refactor** (below): once future races accumulate with
   `analysis` snapshots, the roster-driven path will emit a row per
   horse per model regardless of whether the model bet on the horse,
   which makes "Harville bet, Henery passed" automatically visible
   without sentinel rows.

---

## Issue 4 — roster-driven row emission

**Pre-fix behavior:** evaluator iterated bet plans and emitted one
row per (horse-with-tickets × model). Result: 230 of 424
race-horse pairs had only one model's row (the one with a plan
touching that horse), and horses neither model bet on were absent
from the CSV entirely.

**Post-fix behavior:** when the record has an `analysis` snapshot,
the evaluator iterates `analysis.rows` (the full roster). Every horse
gets two rows (one per model), regardless of whether either model
bet on it. Tickets become a left-join — horses without tickets get
`tickets_count: 0`, all stake/pnl columns 0, but
`p_win` / `p_place` / `p_show` / edge / pool / signal columns fully
populated from the analysis snapshot.

This unlocks calibration analysis: we need
`(p_win, won)` pairs for every horse in the field, not just bet-on
horses, to assess whether predicted 5%-pWin horses actually win 5% of
the time.

**New column: `analysis_present`** (boolean). True when the row was
emitted from the roster path; false from the bet-driven fallback path
or from a sentinel row. Downstream code can filter on this to scope
analyses that require complete roster data.

Records WITHOUT an `analysis` snapshot keep the bet-driven path. They
contribute ticket aggregation + outcome columns but blank
probability/edge/pool columns.

**Current data impact:** none of the 169 existing records carry an
analysis snapshot (snapshot persistence shipped in the previous PR), so
the roster-driven path doesn't fire on today's CSV. The "Race-horse
pairs with only one model: 230" counter in the integrity block will
shift as new analysis-bearing races accumulate.

---

## Summary

| Issue | Cause | Code change | Data change |
|---|---|---|---|
| 1. BEL-2026-05-10 missing | Data not in `locked-recs.json`. Origin unknown — likely in-memory-only state lost before a write. | None (data unrecoverable; no fix that doesn't risk JSON corruption). | None. |
| 2. CD R10 NaN finish_position | NOT a void race. CD R10 ran and tickets legitimately lost. NaN was an artifact of legacy records lacking `race.results`. | Defensive: added `'void'` settlement state + `settlement_state` column + 3 unit tests. Future void races (canceled / postponed / all-MTO) will refund properly. | None (zero records qualify as voids today). |
| 3. Henery missing on 49 races | Pre-feature legacy data — Henery shipped between 2026-05-04 and 2026-05-10. Records from before lack `betPlanByModel`. | Evaluator sentinel-row emission for empty plans without analysis. | None (cannot backfill — analysis also missing). |
| 4. Roster-driven rows | Evaluator was bet-driven; calibration requires roster-driven. | Refactored evaluator. Added `analysis_present` column. | None for existing data; future analysis-bearing races will populate the missing roster. |
