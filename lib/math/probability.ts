/**
 * Apply a favorite-longshot-bias (FLB) correction to a probability vector.
 *
 * Public pari-mutuel pools systematically overprice longshots and underprice
 * heavy favorites. Forty years of empirical work (Asch & Quandt 1986;
 * Snowberg & Wolfers 2010; many others) consistently finds the corrected
 * probability is well-approximated by a power transform of the raw share:
 *
 *     p_calibrated[i] ∝ p_raw[i] ^ alpha
 *
 * Then renormalize so the vector sums to 1.
 *
 * Alpha values from the literature cluster around 1.05–1.10. We default to
 * 1.06 (mid-literature, conservative). This compresses extremes:
 * - A 30% favorite gets nudged up a couple of percentage points.
 * - A 3% longshot gets shaved down by a similar fraction of its share.
 *
 * For alpha = 1, this is a no-op (preserves the raw vector).
 * For alpha > 1, the transform is correct-direction. For alpha < 1, it would
 * INCREASE longshot weight — only useful for synthetic sims; we clamp to >=1
 * to make accidental misuse a no-op rather than a backwards correction.
 */
export function applyFavoriteLongshotBias(
  probs: number[],
  alpha: number,
): number[] {
  const a = Math.max(1, alpha);
  if (a === 1) return [...probs];
  const transformed = probs.map((p) =>
    Number.isFinite(p) && p > 0 ? Math.pow(p, a) : 0,
  );
  let total = 0;
  for (const t of transformed) total += t;
  if (total <= 0) return [...probs];
  return transformed.map((t) => t / total);
}

export function probsFromWinPool(pools: number[]): number[] {
  const n = pools.length;
  if (n === 0) return [];
  let total = 0;
  for (const p of pools) {
    if (Number.isFinite(p) && p > 0) total += p;
  }
  if (total <= 0) return uniformProbs(n);
  return pools.map((p) => (Number.isFinite(p) && p > 0 ? p / total : 0));
}

export function probsFromDecimalOdds(odds: number[]): number[] {
  const n = odds.length;
  if (n === 0) return [];
  const raw = odds.map((d) => (Number.isFinite(d) && d > 0 ? 1 / d : 0));
  let total = 0;
  for (const r of raw) total += r;
  if (total <= 0) return uniformProbs(n);
  return raw.map((r) => r / total);
}

export function uniformProbs(n: number): number[] {
  if (n <= 0) return [];
  return new Array(n).fill(1 / n);
}
