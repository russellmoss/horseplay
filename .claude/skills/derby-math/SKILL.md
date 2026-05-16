---
name: derby-math
description: Use this skill whenever editing, reviewing, or generating code in lib/math/ — including probability extraction, the heuristic and Harville fair-price models, projected Place/Show payout calculations, edge calculation, and signal classification. Trigger on any file path matching lib/math/*.ts. Also trigger when reasoning about race-level fixtures, when writing tests in tests/math.*, or when validating outputs against fixtures/sample-6-horse.json. The math is the foundation of derby-edge — if it is wrong the rest of the tool is noise. This skill lists every known pitfall and required invariant.
---

# Derby-edge math — pitfalls and invariants

The math layer is the most error-prone part of this codebase. Subtle bugs in any of these formulas produce signals that look plausible but are systematically wrong. This skill exists to catch those bugs before they ship.

## Required invariants (every PR touching `lib/math/` must verify these)

1. **Probabilities sum to 1.** After `probsFromWinPool` or `probsFromDecimalOdds`, `Σ p_i` must be within `1 ± 1e-9`. Violation = overround not stripped.
2. **Harville place probabilities sum to 2.** Across all horses in a race, `Σ p_place_i ≈ 2.0` (because exactly two horses place per race). Within `2 ± 1e-6`.
3. **Harville show probabilities sum to 3.** Same reasoning. Within `3 ± 1e-6`.
4. **Floor ≤ Mid ≤ Ceiling** for every horse on every projected payout calculation. Violation = the floor/ceiling pairing logic is inverted.
5. **No payout falls below $2.10.** The `max(2.10, breaked)` guard must be applied after breakage, not before.
6. **All payouts end in `.x0`** (last digit always 0 after the decimal). Violation = breakage applied incorrectly. Use `Math.floor(x * 10) / 10`, not `Math.round`.
7. **Heuristic place prob is capped at 0.999.** A horse with p_win = 0.6 gives 2 × 0.6 = 1.2, which is nonsense.
8. **No NaN, no Infinity in any output.** Add explicit guards for `denom <= 0` and `pool === 0`. Return `null` for unknowable, not `0`.

## Pitfalls — each of these has bitten someone before

### Pitfall: Harville third-place sum convention

The third-place probability has two formulations in the literature. The correct one for our purposes iterates *ordered* pairs `(j, k)` with conditional renormalization:

```
P(3rd_i) = Σ_{j ≠ i} Σ_{k ≠ i, k ≠ j}  p_j × (p_k / (1 − p_j)) × (p_i / (1 − p_j − p_k))
```

The `j` loop and `k` loop are both unconditional (no `j < k` constraint) because we're modeling sequential draws: j wins, k comes 2nd, i comes 3rd. The conditional probabilities `p_k / (1 − p_j)` and `p_i / (1 − p_j − p_k)` enforce no double-counting.

If you see `for (let k = j + 1; ...)` in the show-probability code, that's the unordered-pairs convention — it's wrong here. Use `for (let k = 0; k < n; k++) if (k !== i && k !== j)`.

### Pitfall: floor vs. ceiling pairing

Place pool, horse `i`, finishing companion `j`:

```
return_per_$2 = 2 + (net_pool − place_pool_i − place_pool_j) / place_pool_i
```

To compute the **floor** (worst payout for i), pick the `j` that **maximizes** `place_pool_j` — because a larger `place_pool_j` shrinks the leftover. Conversely, **ceiling** = pick the `j` with the **smallest** `place_pool_j`.

This is counterintuitive. The intuition: a big-pool companion drains the leftover, leaving less for horse i's bettors to split. Verify this with one hand-computed example before declaring done.

### Pitfall: probability source priority

Order matters. Always:

1. Win pool dollars (most accurate — it's the actual market)
2. Decimal odds (after overround stripping)
3. Uniform fallback (only if everything else is null)

Track which source was used in `RaceAnalysis.probSource`. The dashboard surfaces this. Don't silently fall through.

### Pitfall: takeout direction

Takeout is a percentage *removed* from the pool before paying out. So:

```
net_pool = total_pool × (1 − takeout)
```

NOT `total_pool × takeout`, and NOT `total_pool / (1 + takeout)`. Default US Place/Show takeout is ~17% (parameterize via config). Win takeout doesn't enter the math because we're using win pool as a probability indicator, not computing win payouts.

### Pitfall: morning line as source of truth for fair price

ML drift is a *signal*, not an input to fair pricing. The fair Place/Show prices come from the live Win pool (or live decimal odds), never from morning line. ML is just the baseline for the drift comparison.

### Pitfall: scratched horses

Scratched horses must be filtered out of the probability calculation entirely — they don't get redistributed across the remaining horses by the math layer; the win pool data already reflects the redistribution.

In the UI, scratched horses are shown but greyed out, and excluded from probability sums.

## Required tests (in `tests/math.*`)

Before declaring math done, all of these must pass:

- `probsFromWinPool` outputs sum to 1 within 1e-9 (fuzz with 100 random pools).
- `probsFromDecimalOdds` outputs sum to 1 within 1e-9 after overround removal (fuzz with 100 random odds vectors).
- Harville place probs sum to 2 ± 1e-6 (fuzz across 100 random prob vectors).
- Harville show probs sum to 3 ± 1e-6 (fuzz across 100 random prob vectors).
- 3-horse hand-computed Harville test: probs `[0.5, 0.3, 0.2]` produce specific known place/show values; assert within 1e-9.
- All payout outputs satisfy `floor ≤ mid ≤ ceiling`.
- All payouts ≥ 2.10.
- All payouts end in `.x0` after breakage.
- A "no edge" race (all pools proportional to win probability) produces edges close to 0 across all horses — proves no false positives.
- A "plunged" race (one horse's place pool artificially small) produces a positive edge on that horse — proves true positives.

## After math is implemented — cross-validation step

The math is critical enough to warrant external review before building the rest of the tool. Run:

```
council-of-models lib/math/harville.ts lib/math/payouts.ts
```

Cross-check the implementation against GPT and Gemini's reading of the same files. Discrepancies in the formulas — especially around the Harville third-place sum — are the highest-risk bugs in this codebase. Fix any discrepancies before proceeding to Phase 4.

## When in doubt

The `IMPLEMENTATION.md` §6 is the authoritative source. If this skill and `IMPLEMENTATION.md` ever disagree, `IMPLEMENTATION.md` wins and this skill should be updated.
