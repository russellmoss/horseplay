# math-verifier — Phase 1 audit

## Baseline

`pnpm test` → **5 files, 60 tests passed, 0 failed**. Duration ~680ms. No flakies, no warnings. Baseline is green.

## Formula re-derivation vs. IMPLEMENTATION.md §6

| Section | Spec | Implementation | Verdict |
|---|---|---|---|
| §6.1 win pool | `p_i = pool_i / Σ pool` | `probability.ts:1-10` | OK; uniform fallback when `total <= 0` |
| §6.1 decimal odds | `(1/d_i) / Σ(1/d_j)` (overround stripped) | `probability.ts:12-20` | OK |
| §6.2 heuristic | `min(0.999, k·p)` for k=2,3 | `heuristic.ts:3-13` | OK; cap is `HEURISTIC_PROB_CAP = 0.999` |
| §6.3 Harville place | `p_i + Σ_{j≠i} p_j p_i / (1−p_j)` | `harville.ts:1-19` | OK |
| §6.3 Harville show | ordered (j,k), no `j<k` constraint | `harville.ts:32-46` — `for j…; for k=0;k<n;k++ if (k!==i&&k!==j)` | **OK — pitfall avoided.** Hand-check on [0.5,0.3,0.2]: P(3rd_0) = 0.0857143 + 0.075 = 0.1607143; show[0] = 0.8393 + 0.1607 = 1.000 |
| §6.4 fair payout | `2/p` | `payouts.ts:10-13` | OK; `null` for `p ≤ 0` or non-finite |
| §6.5 net pool | `total × (1 − takeout)` | `payouts.ts:50, 108` | OK — takeout direction correct |
| §6.5 floor pairing | LARGEST companion | `payouts.ts:75-78`, `131-134` (sortDesc[0..1]) | OK — hand-check: pools=[20000,…,4000], i=5 → floor=9.6 ✓ |
| §6.5 ceiling pairing | SMALLEST companion | `payouts.ts:75-78`, `135-136` (sortAsc[0..1]) | OK — hand-check: i=0 → ceiling=3.5 ✓ |
| §6.5 breakage | `Math.floor(x*10)/10` then `max(2.10,_)` | `payouts.ts:5-8` | OK — `Math.floor`, not `Math.round`; floor applied before the $2.10 max as required |
| §6.6 edge | `actual/fair − 1` | `ev.ts:3-7` | OK; `null` propagation correct |
| §6.7 signal | slam_dunk → lean → drift → none, strictly `>` | `ev.ts:18-41` | OK; only Harville edges drive slam_dunk/lean, heuristic ignored as spec'd |
| §6.8 ML drift | `(current − ml) / ml` | `ev.ts:9-16` | OK |

## Eight invariants

1. **Probs sum to 1 ± 1e-9** — enforced by normalization; verified by `tests/math.probability.test.ts` `Invariant 1: sums to 1 ± 1e-9 across 100 random pools` and the matching odds-vector test.
2. **Place probs sum to 2 ± 1e-6** — verified `tests/math.harville.test.ts > harvillePlaceProbs > Invariant 2`.
3. **Show probs sum to 3 ± 1e-6** — verified `harvilleShowProbs > Invariant 3` and the explicit `uses ordered (j, k) pairs — does NOT iterate j < k` test.
4. **Floor ≤ mid ≤ ceiling** — verified `placePayoutBand > Invariant 4` (deterministic + 50-trial fuzz) and `showPayoutBand > Invariant 4`.
5. **No payout < $2.10** — enforced in `breakage()` via `Math.max(2.10, breaked)`; verified `placePayoutBand > Invariants 5+6` and equivalents.
6. **Payouts end in `.x0`** — enforced by `Math.floor(x*10)/10`; verified by both `breakage > Invariant 6` (200-sample fuzz) and the Place/Show `Invariants 5+6` tests.
7. **Heuristic capped at 0.999** — enforced by `Math.min(0.999, k*p)`; verified `tests/math.heuristic.test.ts` (`Invariant 7: capped at 0.999`).
8. **No NaN/Infinity, `null` for unknowable** — enforced via 70+ `Number.isFinite` / `null` guards across `lib/math/*`; verified `Invariant 8` tests in probability, harville, ev, payouts.

All eight invariants are both enforced in code AND covered by named tests.

## Pitfalls

| Pitfall | Status |
|---|---|
| Harville third-place ordered-pair convention | **Avoided.** `harville.ts:38` uses `for (let k = 0; k < n; k++) if (k !== i && k !== j)` — not `k = j+1`. Test on lines 100-106 specifically catches the unordered-pair bug. |
| Floor pairs with LARGEST, ceiling with SMALLEST | **Avoided.** Hand-verified for both place (1 companion) and show (2 companions); deterministic tests at `payouts.ts` test lines 94-111 and 182-197. |
| Probability source priority (win_pool → odds → uniform) | **Mostly correct.** `index.ts:38-50` follows the priority. **Nit:** if every horse has `winPoolDollars !== null` but they're all zero, code reports `probSource: 'win_pool'` while `probsFromWinPool` internally falls back to uniform — slight reporting mismatch the dashboard could surface as misleading. |
| Takeout direction (`× (1−t)`, not `÷ (1+t)` or `× t`) | **Correct.** Verified at `payouts.ts:50,108` and tested by the `higher takeout produces SMALLER net pool` direction test. |
| ML as fair-price source | **Avoided.** Fair payouts derive only from Harville/heuristic on the live-prob vector; ML feeds only `computeMlDrift`. |
| Scratched horses | **Handled correctly.** `index.ts:32-33` filters scratched out before any prob/payout math; scratched rows are appended as null-bearing rows for UI rendering. |

## Concrete bugs / blocking issues

None found. The only observation worth flagging:

- **Nit (non-blocking):** `analyzeRace` in `lib/math/index.ts:41-43` reports `probSource: 'win_pool'` whenever every horse has a non-null `winPoolDollars` — even if the pool sum is 0, in which case `probsFromWinPool` silently falls back to uniform. The dashboard would show "win_pool" while actually using a uniform fallback. Suggest either propagating the source from `probsFromWinPool` or adding a positive-sum check before claiming `win_pool`. Not in §6 strictly, but matches the spirit of the SKILL.md priority pitfall.

- **Nit (non-blocking):** No fixture-driven integration test for the `analyzeRace` facade against `fixtures/sample-6-horse.json` exists yet (the facade itself has no dedicated test file). The unit tests cover every leaf function, but the spec calls out fixture validation. Add `tests/math.analyzeRace.test.ts` next phase.

## Verdict

**APPROVED WITH NITS.** All 60 tests pass, every formula matches IMPLEMENTATION.md §6 to hand-checked precision, every invariant is enforced and tested, and every known pitfall is explicitly avoided (the Harville ordered-pairs check is unambiguous). The two nits above are reporting/coverage gaps, not math bugs — Phase 1 is safe to ship as the foundation. Council review of `harville.ts` / `payouts.ts` per the SKILL.md "cross-validation step" is still recommended before relying on signals in production.
