# Council Feedback — Phase 1 Math (`harville.ts` + `payouts.ts`)

**Date**: 2026-05-02
**Files reviewed**: `lib/math/harville.ts`, `lib/math/payouts.ts`
**Reviewers**: Codex (gpt-5.4) + Gemini (gemini-3.1-pro-preview)
**Reviewer focus areas (per user)**: Harville third-place sum convention, floor/ceiling pairing direction, breakage with `Math.floor` (not `Math.round`), takeout direction.

---

## Reviewer agreement on the four focus areas

| Focus | Codex | Gemini | Verified locally |
|---|---|---|---|
| Harville third-place uses **ordered** pairs (no `j < k`) with conditional renormalization | ✅ correct | ✅ correct | ✅ — test at `tests/math.harville.test.ts:100` already catches the unordered-pairs bug |
| Floor pairs with **largest** companion pool; ceiling with **smallest** | ✅ correct | ✅ correct (hand-verified place pools=[20000…4000], i=5 → floor=9.6) | ✅ |
| Breakage uses `Math.floor(x * 10) / 10`, then `max(2.10, …)` | ✅ correct | ✅ correct order | ✅ |
| Takeout = `× (1 − takeout)` | ✅ correct | ✅ correct | ✅ |

**The four user-flagged risk areas are all clean.**

---

## Critical Issues

### 1. Show payout formula is missing a `2/3` factor (Gemini — corroborated locally)

The spec at IMPLEMENTATION.md §6.5 says:

> Show payout is the same, but with two companions `j` and `k`, **and the leftover divided three ways**:
> ```
> return_per_$2 = 2 + (net − show_i − show_j − show_k) / show_i
> ```

The **prose** ("leftover divided three ways") is correct. The **formula** is not — it has the same structure as the place formula, which only works because place's "leftover ÷ 2 (split among 2 finishers)" cancels with the per-$2 conversion (× 2). For show, the leftover is split among **3** finishers, so:

```
per_$2_return = 2 × [(show_i + leftover/3) / show_i]
              = 2 + (2/3) × leftover / show_i
```

Without the `2/3` factor, projected show payouts are inflated by 50% relative to actual pari-mutuel mechanics.

**My implementation followed the spec formula** (`lib/math/payouts.ts:40`), so the bug is in the code as well as the spec. Gemini caught it; Codex missed it.

**Hand-check**: show pool $300,000, takeout 15%, three winners' pools $50k/$40k/$30k. Real US payout for the $30k pool:
- Net = $255,000; leftover = $135,000; per-pool share = $45,000; pool returns to $75k → per-$2 return = 2 × ($75k / $30k) = **$5.00**.
- Spec/current code: 2 + 135000/30000 = **$6.50** (wrong).
- Correct: 2 + (2/3) × 135000/30000 = **$5.00** ✅.

**Action required**: this is a spec bug AND a code bug. Both `derby-edge-IMPLEMENTATION.md` §6.5 and `lib/math/payouts.ts` (`showReturnRaw`) need fixing. Tests in `tests/math.payouts.test.ts` that assert specific show payouts (lines 184–197) also need updating to the corrected expected values.

### 2. Mid breakage interpretation — spec ambiguity (Codex)

Spec §6.5 says "Mid: simple average across all valid `j ≠ i`." Two readings:

- **(a) Average raw returns, then break the average** (my current implementation, `payouts.ts:83-92`).
- **(b) Break each scenario's payout, then average the broken payouts.**

Codex prefers (b) because the spec defines `final_payout` as the broken value, so "average of the broken values" is the natural reading. Concrete divergence:

- Raw returns 2.19 and 2.41:
  - Method (a): avg=2.30 → break=2.30
  - Method (b): break each → 2.10, 2.40 → avg=2.25 → break=2.20

Both methods preserve `floor ≤ mid ≤ ceiling` (breakage is monotonic). Method (a) is mathematically smoother (averages live numbers). Method (b) matches the spec's definition of "payout" more literally.

**Action required**: design call. If you want to switch to (b), it's a 4-line change in `placePayoutBand` and `showPayoutBand`.

---

## Should Fix

### 3. Zero-pool companions excluded from band calculation (Codex)

In both `placePayoutBand` and `showPayoutBand` (`payouts.ts:62-68`, `120-126`), companions are filtered with `pj <= 0`. The spec only requires `pool_i > 0` (it's the divisor). A horse with `pool_j = 0` (known zero, not unknown/null) is a mathematically valid companion — the leftover formula still applies, just with `pool_j = 0` term contributing nothing.

Practical impact: low. Real FDR pools rarely have an active horse with literal $0. But if it happens (e.g., very early in a race's wagering window), my code would:
- silently drop a valid companion from the mid average,
- potentially miss the true ceiling (smallest companion could be 0),
- return all-null for show if exactly two non-zero companions exist alongside zero-pool ones.

**Action required**: change the filter from `pj <= 0` to `pj < 0 || !Number.isFinite(pj)` if zero pools should be valid. Or document the current behavior as "we treat zero-pool companions as scratched-equivalent" if you want to keep it.

---

## Reviewer claims I dismissed after verification

### 4. Float-precision in breakage (Gemini, dismissed)

Gemini claimed `breakage(2.30)` returns `2.20` due to IEEE 754 (`2.3 * 10` evaluating to `22.999…6`). I verified empirically on Node v24 / V8: `2.3 * 10 === 23` exactly, and `Math.floor(2.3 * 10) / 10 === 2.3`. I ran a 1M-trial fuzz of random rationals looking for `(x*10) < round(x*10) - 1e-10` — zero hits. The general theoretical concern about float precision is real for some operations, but this specific multiplication does not produce a sub-integer result for the kinds of values our payout math generates. **Not a bug.**

If you want defensive epsilon protection anyway, add `Math.floor(returnPer2 * 10 + 1e-9) / 10` to `breakage()` — but the existing 200-trial fuzz test (`Invariant 6`) would have caught any real failure.

### 5. Cap Harville at 0.999 (Gemini, dismissed)

Gemini suggested capping Harville place/show at 0.999 like the heuristic. **This would actively break Invariant 2** (Σ p_place_i = 2.0). With normalized inputs, Harville place values stay in [0, 1] mathematically; the cap is unnecessary and would silently shave the sum below 2.0 on extreme distributions. **Don't apply.**

---

## Nits

- **Codex**: Harville functions silently degrade on invalid inputs (skip terms, return zeros) instead of returning null. Matches the broader "null for unknowable" discipline imperfectly. Low impact since upstream filters scratched/invalid horses.
- **Codex**: Neither payout function validates `takeout` bounds (negative or >1 produces finite garbage). Trivial guard if you want it.
- **Gemini**: `[...companions].sort()` is called twice in `showPayoutBand`; could be a single O(n) min/max scan. Performance non-issue at n ≤ 20.

---

## Verdict

- **Codex**: BLOCKING ISSUES (zero-pool exclusion + mid interpretation)
- **Gemini**: BLOCKING ISSUES (show 2/3 factor + float precision — but the float concern is dismissed after empirical check)

**My synthesis**: One real critical (show 2/3 factor — both spec and code), one design question (mid breakage interpretation), one should-fix (zero-pool companions). Three findings I dismissed after verification (float precision, Harville cap; the latter is wrong-on-its-face).

**Per user instructions, I am NOT auto-applying any of these.** All flagged for review before Phase 2.

---

## Raw Responses

### Codex (gpt-5.4)

```
CRITICAL
- Zero-pool companions are incorrectly excluded in lib/math/payouts.ts:62 and lib/math/payouts.ts:120 via `pj <= 0`. The spec's place/show formulas only require `place_pool_i` / `show_pool_i` to be positive… Current behavior can miss the true ceiling, skew the mid, or return null for show when two valid companions exist but one/both have zero pool.

- Mid payout is computed as "average raw return, then break once" in lib/math/payouts.ts:83 and 141. If §6.5's "Mid: simple average across all valid j / {j,k}" is read against the already-defined `final_payout`, this is not the spec formula. Breakage is nonlinear, so the two methods can differ.

SHOULD FIX
- harvilleShowProbs is mathematically correct for third place: ordered pairs, no `j < k` pitfall.
- harvillePlaceProbs / harvilleShowProbs silently degrade on invalid inputs (skip bad terms, return zeros, not null).
- Neither payout function validates takeout bounds.

NITS
- Floor/ceiling pairing logic is correct where companions are included.
- Breakage is correct: Math.floor(x*10)/10, then max(2.10,…). No Math.round.
- The raw-mean-then-break approach does preserve floor ≤ mid ≤ ceiling.

VERDICT: BLOCKING ISSUES
1. Harville third-place: correct.
2. Floor/ceiling pairing: correct in direction, wrong in domain (zero-pool exclusion).
3. Breakage: correct.
4. Takeout direction: correct.
5. Mid: invariant preserved, spec compliance questionable.
6. No NaN/Infinity leaks; no payout below $2.10 after breakage. Main gap is zero-pool scenario exclusion.
7. Silent handling of invalid probability inputs in harville.ts.
```

### Gemini (gemini-3.1-pro-preview)

```
1. Harville third-place sum: Correct. For n=4 [0.4,0.3,0.2,0.1], show probs sum to 3.0.
2. Floor/ceiling pairing: Correct for Place. Show pairing is structurally correct, but the math formula has a critical flaw — see below.
3. Breakage direction: Correct order, flawed JS execution. (Gemini claimed breakage(2.30) → 2.20 due to float precision — disputed; verified false on V8.)
4. Takeout direction: Correct.
5. Mid: Sound. Strictly preserves floor ≤ mid ≤ ceiling.
6. Numerical guards: Solid.
7. Probability guards in Harville: Safe.

CRITICAL
1. Show Payout Formula violates standard pari-mutuel math.
   Spec: leftover divided three ways. Code: 2 + (netPool - pi - pj - pk) / pi.
   For Place, profit splits 2 ways → 2 + leftover/pi (the 2s cancel).
   For Show, profit splits 3 ways → 2 + (2/3) × leftover/pi.
   Current formula gives 3× the actual allocated profit pool.
   Fix: return 2 + (2/3) * ((netPool - pi - pj - pk) / pi);

2. Javascript Float Imprecision in Breakage.
   [Disputed and dismissed per local empirical test]

SHOULD FIX
1. Missing Spec Invariant: Harville should also cap at 0.999.
   [Dismissed — would break Invariant 2]

NITS
1. Unnecessary Array allocations in showPayoutBand sort.

VERDICT: BLOCKING ISSUES
The implementation translates the provided specification flawlessly. However, because the specification's Show math is structurally flawed for US standard pari-mutuel distributions, the code will output radically incorrect dollar amounts.
```
