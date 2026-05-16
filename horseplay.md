# Horseplay — pari-mutuel arbitrage signal math

A reference for analyzing the per-race xlsx exports from the Horseplay app. Read this before drawing conclusions about hit rates, edge realization, or model calibration. Every column in the export is defined here, with the exact formula used.

## TL;DR

- We scrape live FanDuel pari-mutuel pool dollars per horse for Win, Place, and Show.
- We turn pool dollars into a **win probability** for each horse, run that through models that estimate place and show probabilities, and back those into "fair" $2 payouts.
- We compare those fair payouts to the **projected payouts** the live pool implies and call the difference an **edge**.
- The thesis: **Win pools are large and efficient, Place/Show pools are smaller and noisy.** Sometimes the public dumps money on a horse to win that distorts the place/show pools on the *other* horses just enough that a $2 place ticket is mispriced upward. That's the +EV play.

---

## 1. Pari-mutuel basics (so the math makes sense)

### 1.1 The pool, the take, breakage, the $2.10 floor

Pari-mutuel doesn't price bets against a bookmaker. Everyone bets into a single shared pool per wager type (Win pool, Place pool, Show pool). At post time the host track:

1. Subtracts a **takeout** (commission) from the pool. Takeout varies by track and bet type. We model:
   - `takeoutWin = 0.16` (16%, default)
   - `takeoutPlace = 0.17` (17%, default)
   - `takeoutShow = 0.17` (17%, default)
   These are configurable but are the values used at compute time.
2. Distributes the remainder (the **net pool**) among winning tickets.
3. Applies **breakage** — the per-$2 payout is rounded *down* to the nearest $0.10. This is `Math.floor(x * 10) / 10`, never round-to-nearest. It's a small additional take that always benefits the house.
4. Enforces a **minimum payout of $2.10 per $2** ticket. Even if the breaked payout would be lower (e.g. on a 1/9 favorite who shows), the floor kicks in.

Combined, every projected payout in the export was produced by:

```
return = breakage(raw) = max($2.10, Math.floor(raw * 10) / 10)
```

**Implication for edge analysis**: payouts are quantized to $0.10 increments and floored at $2.10. Comparing model "fair" prices (continuous, not breaked) against actual payouts (breaked + floored) introduces a small systematic bias — fair will tend to be slightly above breaked on horses near the floor.

### 1.2 What each bet pays

- **Win**: Horse must finish 1st. Pays out only on the winner. The full Win net pool goes to the winner's bettors.
- **Place**: Horse must finish 1st OR 2nd. The Place net pool minus the dollars on the two top finishers is split between the two top finishers' bettors.
- **Show**: Horse must finish 1st, 2nd, OR 3rd. The Show net pool minus the dollars on the three top finishers is split *three ways* — but each show ticket only collects 1/3 of that excess (we use `SHOW_SPLIT_FACTOR = 2/3` because each ticket gets back its $2 stake plus 1/3 of the leftover, then we multiply leftover share by 2 since there are 2 winning tickets per scenario; effective per-ticket factor on the leftover is 2/3).

### 1.3 "Official" vs "open" vs "closed"

- **open** — pool is taking bets (FDR status `O`, `IC`, `MO`).
- **closed** — race off, no more bets, results not yet posted (FDR `RO`, `SK`).
- **official** — `results.runners` populated. Finish positions known. We treat presence of `runners.length > 0` as the official trigger.

The xlsx Summary tab includes the official `winPayoff / placePayoff / showPayoff` for the top 3 finishers when available — those are the ground truth for any post-hoc edge realization analysis.

---

## 2. The probability layer

Every downstream calculation depends on a vector `probs[i]` — the estimated probability that horse `i` wins.

### 2.1 Where `probs` comes from

We pick the first viable source from this priority list (`probSource` field in the export):

| Priority | Source | Method |
|---|---|---|
| 1 | `win_pool` | Each horse's share of the Win pool dollars: `probs[i] = winPool[i] / sum(winPool)` |
| 2 | `decimal_odds` | Inverse of decimal odds, normalized: `probs[i] = (1/odds[i]) / sum(1/odds[j])` |
| 3 | `uniform_fallback` | Flat `1/n` for n active horses (only when nothing else is usable) |

The `probSource` is in the race header section of the Summary tab. Most live races near post are `win_pool` because pool dollars are populated; pre-post or stale races may show `decimal_odds`. Treat `uniform_fallback` rows as having no real signal — the math runs but the edges are nonsense.

### 2.2 Why win-pool implied probabilities are good

The Win pool is large (often $1M+ on Derby day, $50K+ on weekday cards) and is the most-watched market. Sharps drive it. When we pull `winPool[i] / sum(winPool)` we're getting the public's collective best estimate of P(horse i wins), already corrected for takeout (since both numerator and denominator are post-take pool dollars on the same scale).

Place and Show pools are typically 1/3 the size of Win and dominated by recreational bettors who pile money on favorites because "they always show." That's exactly the inefficiency we're hunting.

### 2.3 Active vs scratched

Scratched horses are excluded from the probability calculation. The `probs` vector is built over active horses only, then scratched horses are appended to `analysis.rows` with all-null math fields and signal `'none'`. In the Full Analysis tab they appear sorted to the bottom with a `SCRATCHED` label.

---

## 3. Place and Show probability models

Once `probs[i]` (P(win)) is fixed, we estimate **P(top-2)** for place and **P(top-3)** for show using two different models. Both run for every horse; their outputs are reported in separate columns so you can compare.

### 3.1 Harville model (primary, used for signal classification)

The Harville order-statistics model assumes that, conditional on a horse not finishing first, the conditional distribution over the remaining horses is proportional to their win probabilities normalized by `1 - p_winner`. That gives closed-form expressions:

**P(horse i finishes top-2)** = `pi + Σ_{j≠i} (pj * pi) / (1 - pj)`

The first term is the probability i wins outright; the second term is the sum over j of "j wins, then i wins among the rest."

**P(horse i finishes top-3)** = P(i top-2) + `Σ_{j≠i} Σ_{k∉{i,j}} pj * (pk / (1 - pj)) * (pi / (1 - pj - pk))`

The triple sum is "j wins, k second among the rest, i third among the further rest."

These are the columns:
- `Place Fair (Harv)` — fair $2 payout from `pPlaceFair_harv`
- `Show Fair (Harv)` — fair $2 payout from `pShowFair_harv`
- `Place Edge Harv Floor / Mid` — edge using Harville fair vs floor/mid projected
- `Show Edge Harv Floor / Mid` — same for show

**The signal classifier uses Harville exclusively.** Heuristic columns are reference-only.

### 3.2 Heuristic model (sanity-check column)

A naive multiplicative rule:

- `pPlaceFair_heur = min(0.999, 2 * pWin)` — assume P(top-2) ≈ 2 × P(win)
- `pShowFair_heur = min(0.999, 3 * pWin)` — assume P(top-3) ≈ 3 × P(win)

This is wrong in interesting ways. It overstates place/show probability for big favorites (a horse with `pWin = 0.45` would get `pPlaceFair_heur = 0.90`, but Harville gives roughly `0.65–0.75` because if he doesn't win, the field is wide). It understates place/show probability for closers in slow-pace fields. The heuristic is included for two reasons:

1. **Calibration check**: if Harville and Heuristic disagree wildly on a specific horse, we want to know.
2. **Quick sanity**: in a 6-horse field with one heavy favorite, `2 × pWin` is "good enough" for back-of-envelope work.

If you're doing post-hoc analysis, **use Harville**. The Heuristic columns are there for diagnostic comparison.

### 3.3 What "fair payout" means

Once we have a probability `p` of the bet hitting (top-2 for place, top-3 for show, win for win), the **fair $2 payout** is:

```
fair = 2 / p
```

This is the break-even per-$2 payout if you had no other information than the model probability. **It is not breaked or floored** — it's a continuous theoretical price. Compare it to the actual (breaked, floored) projected payout and the difference is your model-implied edge.

In the export, fair payouts are NOT formulas — they're computed once at export time. Projected payouts and edges *are* formulas, so what-if work in the cells re-derives correctly.

---

## 4. Projected payouts (the live-money cell)

Projected payouts answer: "If horse i finishes top-N right now, what would my $2 ticket pay, given the current pool dollars?"

### 4.1 Win projected

Single-horse calculation. If horse i wins, the entire Win net pool is distributed among the bettors who hold tickets on i.

```
winProj[i] = breakage(2 * netWinPool / winPool[i])
where netWinPool = totalWinPool * (1 - takeoutWin)
```

**Win edges are structurally negative** at roughly `-takeout` (-15% to -16%) for almost every horse, because the pool already implies pWin via `winPool[i] / sum(winPool)`. Mathematically, `winProj` ≈ `2 * (1 - takeout) / pWin` while `winFair` = `2 / pWin`, so the ratio is ≈ `1 - takeout`. **Real +EV win bets are rare** and usually only show up on heavy favorites where the $2.10 minimum payout floor exceeds the breaked raw return — so the floor itself is the source of the edge.

### 4.2 Place projected — the BAND

Place payout depends on **who else** finishes top-2 alongside horse i, because the leftover (net pool minus dollars on i and j) is split between the two winning ticket pools. Different j's give different payouts. We can't know in advance who j will be, so we compute a **band**: floor, mid, ceiling.

For horse i and a candidate companion j (j ≠ i):

```
placeReturn(i, j) = 2 + (netPlacePool - placePool[i] - placePool[j]) / placePool[i]
```

That's: stake back ($2) plus i's share of the leftover, where the leftover = net pool minus the dollars on the two top-finishers. We divide by `placePool[i]` because i's share of the leftover scales inversely with how much money is on i.

We then:
- **Floor**: pair i with j = the **largest** other companion pool. Worst case for i — j is hoarding the leftover pie.
  ```
  placeProj.floor = breakage(placeReturn(i, argmax_j placePool[j]))
  ```
- **Ceiling**: pair i with j = the **smallest** other companion pool. Best case for i.
  ```
  placeProj.ceiling = breakage(placeReturn(i, argmin_j placePool[j]))
  ```
- **Mid**: arithmetic mean of `breakage(placeReturn(i, j))` over **all** valid j ≠ i. (Not a re-broken average — break each scenario, then average the broken values. Per spec.)
  ```
  placeProj.mid = mean over j ≠ i of breakage(placeReturn(i, j))
  ```

The floor/mid/ceiling are the three "Place Proj" columns in the Full Analysis tab.

### 4.3 Show projected — the BAND

Show is the same idea but we need TWO companions (j, k) for the top-3 trio:

```
showReturn(i, j, k) = 2 + (2/3) * (netShowPool - showPool[i] - showPool[j] - showPool[k]) / showPool[i]
```

The `2/3` factor is the leftover-split per ticket: leftover is divided among 3 winning ticket pools, but each ticket collects its $2 stake plus (1/3) × (leftover/showPool[i]) × 2 = (2/3) × (leftover/showPool[i]). The math has been council-reviewed.

- **Floor**: pair i with the two largest other companion pools.
- **Ceiling**: pair i with the two smallest.
- **Mid**: arithmetic mean of `breakage(showReturn(i, j, k))` over all unordered pairs (j, k), j ≠ k, j ≠ i, k ≠ i.

These are the three "Show Proj" columns.

### 4.4 What the band tells you

- **Floor positive edge** (`Edge Harv Floor > 0`): this is the strong signal. Even in the worst-case companion outcome, projected payout beats fair. → `slam_dunk`.
- **Mid positive edge with negative floor**: the bet is +EV on average but exposed to the bad-companion scenario. → `lean` (when above the threshold).
- **Both negative**: the bet is -EV.

The band is also a window into pool distortion. If the Place pool has a heavy hammered favorite, the floor for *other* horses widens dramatically — that's where slam_dunks live.

---

## 5. Edges

Edge is dimensionless — a percentage above or below fair.

```
edge = actual / fair - 1
```

| Column in xlsx | Numerator | Denominator |
|---|---|---|
| Win Edge | Win Proj | Win Fair (= 2 / pWin) |
| Place Edge Harv Floor | Place Proj Floor | Place Fair (Harv) |
| Place Edge Harv Mid | Place Proj Mid | Place Fair (Harv) |
| Place Edge Heur Floor | Place Proj Floor | Place Fair (Heur) |
| Place Edge Heur Mid | Place Proj Mid | Place Fair (Heur) |
| Show Edge Harv Floor | Show Proj Floor | Show Fair (Harv) |
| Show Edge Harv Mid | Show Proj Mid | Show Fair (Harv) |
| Show Edge Heur Floor | Show Proj Floor | Show Fair (Heur) |
| Show Edge Heur Mid | Show Proj Mid | Show Fair (Heur) |

All edge cells in the xlsx are **live formulas**, not baked numbers. Format is `0.0%`. If you tweak a projected or fair cell during what-if analysis, the edge updates automatically.

`Drift` is computed the same way: `(currentOdds / mlOdds) - 1`, displayed as a percentage. Positive = horse drifted longer (less money coming in). Negative = horse drifted shorter (more money coming in, often sharp action).

---

## 6. Signal classification

For each horse, signal is set by this priority cascade. The first matching rule wins:

| Signal | Condition |
|---|---|
| `slam_dunk` | `placeEdge.harvilleFloor > 0` OR `showEdge.harvilleFloor > 0` |
| `lean` | `placeEdge.harvilleMid > leanThreshold` OR `showEdge.harvilleMid > leanThreshold` (default threshold 0.05 = 5%) |
| `drift` | `mlDrift > driftThreshold` (default threshold 0.5 = 50%) |
| `none` | otherwise |

Defaults: `leanThreshold = 0.05`, `driftThreshold = 0.5` (env-overridable via `SIGNAL_LEAN_THRESHOLD`, `SIGNAL_DRIFT_THRESHOLD`).

**Notes for analysis**:
- The classifier uses **Harville only**. Heuristic columns are display-only.
- **`slam_dunk` requires positive FLOOR edge** (not mid), so it's the most conservative bucket.
- **`drift` is just a flag**, not a recommendation. It says "live odds moved >50% from morning line, look here." It can be confirmation (if it's *your* horse drifting shorter, money is coming in) or a warning (if it's drifting longer with no reason, the public is bailing).
- A horse can have a positive drift edge AND a positive Harville floor edge. It will be classified as `slam_dunk` (highest priority).

---

## 7. Mapping each xlsx column to its formula

This is the table for cross-referencing the export. Columns reference the **Full Analysis** tab (the wide one).

| # | Column | Definition |
|---|---|---|
| 1 | `#` | Program number (string; "1A" coupled entries possible). |
| 2 | Horse | Horse name. |
| 3 | Jockey | From FDR `bettingInterests[].runners[0].jockey`. |
| 4 | Trainer | From FDR `bettingInterests[].runners[0].trainer`. |
| 5 | Scratched | "YES" if `bettingInterests[].runners[0].scratched === true`, else blank. |
| 6 | ML (dec) | Morning-line decimal odds. From FDR fractional, converted: `dec = 1 + num/den`. |
| 7 | Cur (dec) | Live decimal odds at compute time. Same conversion. |
| 8 | Cur (frac) | Live fractional rendering of `Cur (dec)`. |
| 9 | Drift | **Formula**: `=Cur/ML - 1`. Display: `0.0%`. Positive = drifting longer; negative = shorter. |
| 10 | p(Win) | Probability of winning, from `probSource`. |
| 11 | Win pool $ | Dollars on this horse in the Win pool, from FDR `biPools` for `wagerType.code === 'WN'`. |
| 12 | Win Proj | `breakage(2 * netWinPool / winPool[i])`. Net pool = `totalWinPool * (1 - takeoutWin)`. |
| 13 | Win Fair | `2 / pWin` (continuous; not breaked). |
| 14 | Win Edge | **Formula**: `=Win Proj / Win Fair - 1`. |
| 15 | Place pool $ | Dollars on this horse in the Place pool. |
| 16 | Place Proj Floor | `breakage(2 + (netPlacePool - placePool[i] - placePool[j]) / placePool[i])` where j = argmax over other horses' place pool dollars. |
| 17 | Place Proj Mid | Mean over all valid j ≠ i of `breakage(placeReturn(i, j))`. |
| 18 | Place Proj Ceil | Same as Floor but j = argmin. |
| 19 | Place Fair (Harv) | `2 / pPlaceFair_harv` where `pPlaceFair_harv = pi + Σ_{j≠i} pj·pi/(1-pj)`. |
| 20 | Place Fair (Heur) | `2 / pPlaceFair_heur` where `pPlaceFair_heur = min(0.999, 2 * pWin)`. |
| 21 | Place Edge Harv Floor | **Formula**: `=Place Proj Floor / Place Fair (Harv) - 1`. |
| 22 | Place Edge Harv Mid | **Formula**: `=Place Proj Mid / Place Fair (Harv) - 1`. |
| 23 | Place Edge Heur Floor | **Formula**: `=Place Proj Floor / Place Fair (Heur) - 1`. |
| 24 | Place Edge Heur Mid | **Formula**: `=Place Proj Mid / Place Fair (Heur) - 1`. |
| 25 | Show pool $ | Dollars on this horse in the Show pool. |
| 26 | Show Proj Floor | `breakage(2 + (2/3)·(netShowPool - showPool[i] - showPool[j] - showPool[k]) / showPool[i])` where j, k = top-2 other show pools by size. |
| 27 | Show Proj Mid | Mean over all unordered pairs (j, k) ≠ i of `breakage(showReturn(i, j, k))`. |
| 28 | Show Proj Ceil | Same as Floor but j, k = bottom-2 other show pools. |
| 29 | Show Fair (Harv) | `2 / pShowFair_harv` (Harville triple-sum, see §3.1). |
| 30 | Show Fair (Heur) | `2 / pShowFair_heur` where `pShowFair_heur = min(0.999, 3 * pWin)`. |
| 31 | Show Edge Harv Floor | **Formula**: `=Show Proj Floor / Show Fair (Harv) - 1`. |
| 32 | Show Edge Harv Mid | **Formula**: `=Show Proj Mid / Show Fair (Harv) - 1`. |
| 33 | Show Edge Heur Floor | **Formula**: `=Show Proj Floor / Show Fair (Heur) - 1`. |
| 34 | Show Edge Heur Mid | **Formula**: `=Show Proj Mid / Show Fair (Heur) - 1`. |
| 35 | Signal | One of `SLAM DUNK`, `LEAN`, `DRIFT`, `—`, `SCRATCHED`. See §6 for rules. |

The Summary tab is a narrowed projection of the same data; cell references and formula structure are equivalent.

---

## 8. Configuration values (compute-time constants)

These are the takeouts and thresholds the export was generated under. They affect every projected payout and signal.

| Config | Default | Purpose |
|---|---|---|
| `takeoutWin` | 0.16 | Subtracted from total Win pool before distribution. |
| `takeoutPlace` | 0.17 | Subtracted from total Place pool before distribution. |
| `takeoutShow` | 0.17 | Subtracted from total Show pool before distribution. |
| `signalLeanThreshold` | 0.05 (5%) | Mid-edge above this triggers `lean`. |
| `signalDriftThreshold` | 0.50 (50%) | ML drift above this triggers `drift`. |

Breakage and the $2.10 floor are not configurable — they are encoded directly in `lib/math/payouts.ts`:

- `MIN_PAYOUT_PER_2 = 2.10`
- `breakage(x) = max(2.10, Math.floor(x * 10) / 10)`
- `SHOW_SPLIT_FACTOR = 2/3`

If a future export uses different takeouts, those will be reflected in the projected payouts, but the formulas themselves don't change.

---

## 9. Known limitations / interpretive caveats

These matter for any post-hoc analysis:

### 9.1 Pool data freshness
The `Last update` timestamp in the race header is when WE last received an FDR frame for this race. If the timestamp is stale (>~90s old) at compute time, the pool dollars in the export are the last-known values. Mid-flight projections degrade rapidly in the final 5 minutes before post; if a race went official with a 30s-stale snapshot, that's a meaningful information gap. Sanity-check by comparing `lastUpdate` to `postTimeUtc`.

### 9.2 Win-pool implied probability ≠ true probability
We use the public's win-pool money as the prior on each horse's `pWin`. The public is generally well-calibrated on liquid markets but has known biases:
- **Favorite-longshot bias**: bettors slightly overbet longshots and underbet heavy favorites. Empirically, true `pWin` for chalk is a few percentage points higher than implied.
- **Information asymmetry**: late sharp action moves the win pool but not the place/show pools at the same rate, opening the window we're hunting.
For calibration analysis, plot `pWin` (binned) vs realized win rate from the official-results column. Expect a bias correction of a few percent at the extremes.

### 9.3 The "band" assumption
The floor uses `j = argmax of pool[j ≠ i]` — this is the single worst-case companion. In reality, the actual finisher has its own pool distribution; using the max is conservative. The mid is a uniform average over all companions, which implicitly assumes equal probability of each companion being in the money — but in fact `P(j top-2 | i top-2)` is non-uniform (heavy favorites are more likely companions). A weighted-mean version using Harville-derived companion probabilities would be more accurate; we don't currently compute it. If post-hoc you find that `mid` consistently overstates realized payouts on favorites and understates on longshots, that's the source.

### 9.4 Heuristic model is not a real model
`pPlaceFair_heur = 2 × pWin` is a back-of-envelope rule. It will diverge sharply from Harville for heavy favorites (overstates) and outsiders (understates). **Do not treat the Heuristic edge columns as independent signals.** They're there to flag cases where the two diverge wildly; that often indicates pool-data issues or a probability-source fallback, not a real disagreement.

### 9.5 `decimal_odds` and `uniform_fallback` rows are noisy
If `probSource = decimal_odds` it usually means win-pool dollars hadn't propagated yet (often 30+ min from post). The decimal odds the public sees on FanDuel are derived from win-pool dollars themselves, so this fallback isn't drastically different from `win_pool` at the high level — but rounding (FanDuel displays integer or half-step decimals) introduces noise. If `probSource = uniform_fallback`, the entire row's math is meaningless. Filter those out for any aggregate analysis.

### 9.6 Win-pool inefficiency from FDR alone
The pool we see is FanDuel's window into the host track's commingled pari-mutuel pool. There's a few-second lag and occasional dollar-rounding. We trust the share `winPool[i] / sum(winPool)` more than the absolute dollar values — relative shares are more stable than absolutes during pool reconciliation moments.

### 9.7 Late scratches
A horse that scratches in the gate (after pools have built up) leaves "dead money" in the place/show pools that gets returned to bettors. Our projected payouts assume the scratched horse is removed cleanly from pool calculations; in practice there's a refund step at the host that we don't model. For post-hoc analysis on races with late scratches, expect projected payouts to be slightly off vs. realized.

---

## 10. Post-hoc analysis recipes

Things to actually look at when you ingest the xlsx:

### 10.1 Calibration of the probability source
Bin `pWin` into deciles (or 5%-wide buckets). For each bin, count: how many horses, how many actually won. The realized win rate per bin should track the bin midpoint linearly. Deviations show favorite-longshot bias or systematic miscalibration.

### 10.2 Hit rates by signal
For races where the official results are populated:
- Out of all `slam_dunk` signals (per-horse, on place or show), what fraction *hit* (finished top-2 for place, top-3 for show)?
- Same for `lean`. Same for `drift` (using whatever bet the user actually made on the drift, which isn't recorded in the xlsx — drift is just a flag).
- A well-calibrated `slam_dunk` should hit at >50% on place (since pPlaceFair > 0.5 is roughly where the floor edge becomes positive on most horses).

### 10.3 Realized edge vs. projected edge
For winning bets, compute `(realizedPayoff - 2) / 2 / fair - 1`. Compare against the `Mid` edge in the export. If the export said "+12% mid edge" and the bet returned a payout that gives "+30% realized edge", the model was conservative; if it returned a -10% realized edge, the model was overconfident. Aggregate over many bets to see the distribution.

### 10.4 Floor vs. Mid as a betting policy
Only-take-floor-positive (`slam_dunk` only) is the most conservative policy. Only-take-mid-positive-above-threshold (`lean`) is wider but accepts variance. Compute the Sharpe-like ratio (mean realized edge / std of realized edge) for each policy across the dataset to pick a sweet spot.

### 10.5 Drift outcomes
Did horses with a `drift` flag hit at a higher or lower rate than their `pWin` would predict? Drift is supposed to capture sharp action — if `drift`-flagged horses (where we'd have to know the direction of the drift; positive `Drift` = longer, negative = shorter) finish in the money at a different rate than baseline, the flag has signal. If they're indistinguishable from baseline, the threshold is too loose.

### 10.6 Signal stability across the export window
The `Computed at` timestamp marks when this snapshot was taken. If you have multiple exports for the same race at different times (e.g. 30 min, 10 min, 5 min, 1 min from post), you can plot how each horse's edge moved. Stable edges (slam_dunk all the way to post) are higher-quality signals than transient ones that flip back and forth. We don't currently store snapshots automatically — this requires manual exports at intervals.

---

## 11. Worked example: `export/CD-R5-2026-05-02.xlsx`

Concrete walk-through of one race. Use this to anchor the abstract math above to actual cells in an export. Every number quoted here can be located in the file.

### 11.1 Race header (Summary tab, rows 1–8)

```
r1  Title:               CD R5 — 2026-05-02 17:12 UTC
r2  Status:              official
r3  Probability source:  win_pool
r4  Total Win pool:      $1,849,315
r5  Total Place pool:    $630,112
r6  Total Show pool:     $569,226
r7  Computed at:         2026-05-03T12:27:30.608Z
r8  Last update:         2026-05-03T12:27:30.608Z
```

Reading these:
- `Status: official` and `Computed at` ≫ `Last update`-ish ≫ `postTime` means this snapshot was taken AFTER the race went official. Pool dollars are frozen at race-off. This is the right kind of file for post-hoc analysis: pools didn't move after the snapshot.
- `Probability source: win_pool` means pWin was computed as `winPool[i] / sum(winPool)`. This is the high-confidence path; treat the numbers as real.
- `Total Win pool $1.85M / Place $630K / Show $569K` — Place is ~34% of Win, Show is ~31% of Win. Typical ratio. The Show pool being close in size to Place is unusual; worth noting if you bin races by pool ratio.

### 11.2 Official results (Summary tab, rows 12–22)

```
Pos  Program  Horse                Win $   Place $   Show $
1    7        Yellow Card          $7.80   $4.24     $3.02
2    10       Joe Shiesty          $0.00   $6.60     $4.10
3    9        Litigation           $0.00   $0.00     $2.76
4    3        My Boy Prince        $0.00   $0.00     $0.00
... (positions 5–10 zeros)
```

So: **Yellow Card** won, **Joe Shiesty** placed (1st or 2nd), **Litigation** showed (1st, 2nd, or 3rd). These are your ground-truth payouts for any realized-vs-projected edge analysis.

### 11.3 Per-horse analysis (Summary tab, row 32 = Yellow Card #7)

This is the row most worth dissecting. From the file:

```
#=7   Horse=Yellow Card   ML=5.5   Cur=3.5   Drift=-36%
p(W)=0.21134
Win Fair=$9.46   Win Proj=$7.90   Win Edge=-16.5%
Place Fair=$4.80   Place Proj (mid)=$4.42   Place Edge=-7.8%
Show Fair=$3.30   Show Proj (mid)=$3.59   Show Edge=+8.6%
Signal=LEAN
```

Reconstructing every number from raw inputs:

#### Drift (col 5)
```
Drift = currentOdds / mlOdds - 1 = 3.5 / 5.5 - 1 = -0.3636 → -36%
```
Negative drift = horse came IN (more money on it). Sharp action confirmation.

#### p(Win) (col 6)
```
pWin = winPool[7] / totalWinPool = 390,840 / 1,849,315 ≈ 0.21134
```
Yellow Card had the second-largest Win pool of any horse in the race (Litigation's was bigger), so he's a co-favorite by money.

#### Win Fair (col 7)
```
Win Fair = 2 / pWin = 2 / 0.21134 = $9.4633
```
Continuous, not breaked. Theoretical break-even per-$2 win ticket.

#### Win Proj (col 8)
```
netWinPool = totalWinPool × (1 − takeoutWin) = 1,849,315 × 0.84 = 1,553,425
Win Proj = breakage(2 × netWinPool / winPool[7])
        = breakage(2 × 1,553,425 / 390,840)
        = breakage(7.949)
        = floor(7.949 × 10) / 10
        = $7.90
```
Matches the actual $7.80 official payout closely. (The 10¢ gap is between our projection model — using the FDR public takeout — and the host track's actual takeout/breakage at race-off.)

#### Win Edge (col 9, formula in cell)
```
Win Edge = Win Proj / Win Fair − 1 = 7.90 / 9.4633 − 1 = −0.165 = −16.5%
```
This is the structural −takeout edge that win bets always have. **NOT a +EV signal**.

#### Place Fair (Harv) (col 10)
The Harville top-2 calculation. With pWin = 0.21134 and the rest of the field:
```
pPlaceFair_Harv = pi + Σ_{j≠i} pj·pi/(1−pj)
```
Result from the export: `pPlaceFair_Harv = 2 / 4.7976 ≈ 0.4170` (Yellow Card has ~42% chance of finishing top-2 per Harville).
```
Place Fair = 2 / 0.4170 = $4.7976 ≈ $4.80
```

#### Place Proj Mid (col 11)
The arithmetic mean of breakage'd place returns over all 9 other horses. From `lib/math/payouts.ts`:

```
netPlacePool = 630,112 × (1 − 0.17) = 522,993

For each companion j ≠ Yellow Card, computed:
  placeReturn(YC, j) = 2 + (522,993 − 134,633 − placePool[j]) / 134,633
  break_j = breakage(placeReturn) = max(2.10, floor(placeReturn × 10) / 10)

j = Wendelssohn (16,276):    raw=4.7639, break=4.7
j = Bear River (22,137):     raw=4.7203, break=4.7
j = My Boy Prince (111,811): raw=4.0541, break=4.0
j = Full Disclosure (12,801):raw=4.7896, break=4.7
j = Possiblemente (30,105):  raw=4.6611, break=4.6
j = Its Bourbon Thirty (32,844): raw=4.6407, break=4.6
j = Mondogetsbuckets (40,468):   raw=4.5841, break=4.5
j = Litigation (158,304):    raw=3.7088, break=3.7  ← floor companion
j = Joe Shiesty (70,733):    raw=4.3593, break=4.3

mid = (4.7 + 4.7 + 4.0 + 4.7 + 4.6 + 4.6 + 4.5 + 3.7 + 4.3) / 9
    = 39.8 / 9
    = 4.4222
```
Matches the file value `4.4222...`. So Place Proj Mid is exactly the `(sum of broken returns) / (count of companions)`.

#### Place Proj Floor (col Full-tab 16)
The floor uses the LARGEST companion pool (Litigation at $158K):
```
Floor raw = 2 + (522,993 − 134,633 − 158,304) / 134,633 = 3.7088
breakage(3.7088) = $3.70
```
Matches.

#### Place Edge (col 12, formula)
```
Place Edge Harv Mid = Place Proj Mid / Place Fair − 1
                    = 4.4222 / 4.7976 − 1
                    = −0.0782 = −7.8%
```

#### Show Edge (col 15, formula) — the LEAN trigger
```
Show Fair (Harv) = $3.30
Show Proj Mid    = $3.59
Show Edge Harv Mid = 3.59 / 3.30 − 1 = +0.086 = +8.6%
```

This is **above the 5% lean threshold**, so the classifier sets `Signal = LEAN`. The model is saying: "In an average-companion scenario, your $2 show ticket on Yellow Card pays $3.59, which is 8.6% better than the $3.30 fair price suggested by his ~60% top-3 probability."

### 11.4 The post-hoc verdict

Now compare the LEAN signal projections to what actually happened.

**Yellow Card (#7), LEAN on Show**
- Projected Show Mid: $3.59 (Show Edge Mid: +8.6%)
- Actual Show payout: $3.02
- Realized show edge vs Show Fair: 3.02 / 3.30 − 1 = −8.5%
- **Verdict**: model said +8.6%, ticket paid −8.5%. A 17pp miss to the downside. The bet was -EV in realization despite the LEAN flag.

**Joe Shiesty (#10), LEAN on Show**
- Projected Show Mid: $5.27 (Show Edge Mid: +6.0%)
- Actual Show payout: $4.10
- Realized edge: 4.10 / 4.97 − 1 = −17.5%
- **Verdict**: −23.5pp miss. Substantially -EV.

**Litigation (#9), LEAN on Show**
- Projected Show Mid: $3.16 (Show Edge Mid: +14.7%)
- Actual Show payout: $2.76
- Realized edge: 2.76 / 2.76 − 1 = 0.0%
- **Verdict**: −14.7pp miss. Exactly fair, no edge realized.

All three LEAN-on-show signals fired in this race; all three came in *below* the projected mid. Two collected, one didn't. The realized show edges were:

| Horse | Signal | Projected Mid Edge | Realized Edge | Result |
|---|---|---|---|---|
| Yellow Card #7 | LEAN | +8.6% | −8.5% | hit (1st), but bet was -EV |
| Joe Shiesty #10 | LEAN | +6.0% | −17.5% | hit (2nd), bet was -EV |
| Litigation #9 | LEAN | +14.7% | 0.0% | hit (3rd), bet broke even |

**Read this carefully**: hit-rate was 100% (all three finished top-3) but realized edge was negative on average. The signals correctly identified horses that would *finish in the money*, but the model *over-projected* the size of the place/show pools' distortion. The mid-payout estimate was systematically too generous in this race.

This is exactly the kind of insight post-hoc analysis is for. One race is anecdotal; do this across hundreds of LEAN signals and you'll learn whether `+8.6% mid edge` actually corresponds to a positive-EV bet in expectation, or whether the threshold needs to move (e.g. `+12%` mid edge might be the real break-even).

### 11.5 What to look for in this file specifically

If you're feeding `CD-R5-2026-05-02.xlsx` to another LLM, here are concrete questions worth asking:

1. **Did any DRIFT signals deliver in the money?** Wendelssohn (#1, drift +119%), Possiblemente (#5, +100%), Mondogetsbuckets (#8, +78%) all flagged DRIFT (drifted *longer*, public bailing). None of them finished in the top 3. That's the expected outcome for "drift longer" — money leaving a horse usually means money knows something. **Negative drift** (Yellow Card −36%) wasn't flagged because DRIFT only fires on >+50% drift, but it was the most predictive signal in the race (Yellow Card won).
2. **Were the floor edges informative?** No `slam_dunk` (positive floor edge) signals fired in this race. Compare to races with `slam_dunk` signals to see whether the floor-positive bucket actually outperforms the mid-positive bucket.
3. **Pool concentration:** Litigation alone holds $545K of $1.85M Win pool (29.5%) and $158K of $630K Place pool (25%). When a single horse dominates the pool, the *other* horses' projected payouts get inflated (because the leftover compresses), which is precisely the LEAN trigger we saw on Yellow Card and Joe Shiesty. The LEAN signal is, in some sense, a transitive read on Litigation's overbet rather than a primary read on the LEAN'd horse — a useful framing for post-hoc analysis.
4. **Litigation's own LEAN was on the favorite.** A LEAN/SLAM_DUNK on the heavy chalk is a different beast than LEAN on a co-third favorite — the variance of realized payout is much smaller and the "edge" lives mostly in the breakage/$2.10-floor mechanics. Worth bucketing separately.

---

## 12. Glossary of file columns (one-line reference)

This is the cheat sheet for grepping the xlsx:

- `pWin` — implied win probability, from win-pool dollars (default).
- `Win Fair` — `2 / pWin`. Continuous.
- `Win Proj` — what the live pool would pay per $2 if this horse wins. Breaked, $2.10-floored.
- `Win Edge` — `Win Proj / Win Fair − 1`. Almost always negative ≈ -takeout.
- `Place Fair (Harv)` — `2 / pPlaceFair_Harville`. Harville top-2.
- `Place Proj Floor/Mid/Ceil` — projected per-$2 place payouts under worst/average/best companion scenario. Breaked.
- `Place Edge Harv Floor` — Floor / Fair − 1. Positive triggers `slam_dunk`.
- `Place Edge Harv Mid` — Mid / Fair − 1. Above 5% triggers `lean`.
- `Show Fair / Proj / Edge` — analogous to Place but for top-3 finish.
- `Drift` — `Cur / ML − 1`. Positive = longer odds. Above 50% triggers `drift`.
- `Signal` — first matching of: slam_dunk → lean → drift → none. Harville-only classifier.
- `Scratched` — runner has been scratched; analysis fields are nulled out.

---

## 13. The arbitrage thesis in one paragraph

Pari-mutuel Win pools are deep, tracked by sharps, and largely efficient — Win edges hover at -takeout (~-15%) for almost every horse. Place and Show pools are roughly 1/3 the size and dominated by recreational bettors who pile money on the favorite to "play it safe." When that recreational money over-concentrates on one horse, the leftover (net-pool − leaders' pool) compresses on the OTHER contenders, pushing their per-$2 projected payouts *upward* relative to what a Harville model says is fair given that horse's win probability. **The +EV bet is almost never on the heavily-bet horse — it's on the second- or third-best horse whose place/show pool is starved relative to its real top-N probability.** That's what `slam_dunk` and `lean` are flagging. Post-hoc analysis should test whether this thesis actually pays out in practice.
