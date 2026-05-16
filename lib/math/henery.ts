/**
 * Henery (Stern) finishing-order model.
 *
 * Harville's model derives Place/Show probabilities by treating subsequent
 * draws as a renormalized fresh race over the remaining horses. That
 * systematically OVERSTATES favorites' chances of finishing 2nd/3rd —
 * empirically, when the favorite doesn't win, it's more likely to under-
 * perform than to come in just behind. (Harville 1973; Henery 1981; Stern
 * 1990; Lo, Bacon-Busche calibration.)
 *
 * Henery corrects this with a power-discount on the conditional draw:
 *
 *     P(j 2nd | i 1st) = p_j^β / Σ_{k≠i} p_k^β
 *     P(k 3rd | i 1st, j 2nd) = p_k^γ / Σ_{l≠i,l≠j} p_l^γ
 *
 * with β < 1 and γ < β < 1. The compression flattens the conditional
 * distribution, reducing the favorite's implied 2nd/3rd-place share.
 *
 * Defaults β = 0.81, γ = 0.65 are mid-range from the calibration
 * literature for North American thoroughbred racing. Set both to 1 to
 * recover Harville exactly — useful as a sanity check / unit test.
 *
 * Invariants (mirrors Harville):
 *   Σ pPlace_i = 2 ± 1e-6   (always exactly two top-2 horses per race)
 *   Σ pShow_i  = 3 ± 1e-6   (always exactly three top-3 horses per race)
 *
 * Same null/zero/Infinity guards as `harville.ts`. The math layer never
 * returns NaN — guard with `Number.isFinite` and `denom > 0` everywhere.
 */

export const HENERY_DEFAULT_BETA = 0.81;
export const HENERY_DEFAULT_GAMMA = 0.65;

function powVec(probs: number[], exponent: number): number[] {
  if (exponent === 1) return probs.map((p) => (Number.isFinite(p) && p > 0 ? p : 0));
  return probs.map((p) => (Number.isFinite(p) && p > 0 ? Math.pow(p, exponent) : 0));
}

function totalPow(pPow: number[]): number {
  let total = 0;
  for (const v of pPow) total += v;
  return total;
}

/**
 * P(horse h finishes top-2) under Henery.
 *
 *   P(h top-2) = p_h + Σ_{i≠h} p_i × p_h^β / Σ_{k≠i} p_k^β
 *
 * The numerator's `p_h^β` and the denominator's `Σ_{k≠i} p_k^β` both come
 * from the same vector of `p^β` precomputed once — O(n²) overall.
 */
export function heneryPlaceProbs(
  probs: number[],
  beta: number = HENERY_DEFAULT_BETA,
): number[] {
  const n = probs.length;
  const result = new Array<number>(n).fill(0);
  if (n < 2) {
    // n = 1: a single horse "places" trivially.
    for (let i = 0; i < n; i++) {
      const p = probs[i];
      if (Number.isFinite(p) && p > 0) result[i] = p;
    }
    return result;
  }

  const pBeta = powVec(probs, beta);
  const totalBeta = totalPow(pBeta);
  if (totalBeta <= 0) return result;

  for (let h = 0; h < n; h++) {
    const ph = probs[h];
    if (!Number.isFinite(ph) || ph <= 0) continue;
    const phBeta = pBeta[h];
    let p2nd = 0;
    for (let i = 0; i < n; i++) {
      if (i === h) continue;
      const pi = probs[i];
      if (!Number.isFinite(pi) || pi <= 0) continue;
      const denom = totalBeta - pBeta[i];
      if (denom <= 0) continue;
      p2nd += pi * (phBeta / denom);
    }
    result[h] = ph + p2nd;
  }
  return result;
}

/**
 * P(horse h finishes top-3) under Henery.
 *
 *   P(h top-3) = pPlace(h) + Σ_{i≠h} Σ_{j≠h, j≠i}
 *                  p_i × (p_j^β / Σ_{l≠i} p_l^β) × (p_h^γ / Σ_{l≠i,l≠j} p_l^γ)
 *
 * Two precomputed vectors (p^β, p^γ) plus running denominators give an
 * O(n³) loop — the same shape as Harville show.
 */
export function heneryShowProbs(
  probs: number[],
  beta: number = HENERY_DEFAULT_BETA,
  gamma: number = HENERY_DEFAULT_GAMMA,
): number[] {
  const n = probs.length;
  const place = heneryPlaceProbs(probs, beta);
  if (n < 3) {
    // n ≤ 2: every horse that places also "shows" — return place values.
    return place;
  }

  const pBeta = powVec(probs, beta);
  const pGamma = powVec(probs, gamma);
  const totalBeta = totalPow(pBeta);
  const totalGamma = totalPow(pGamma);

  const result = new Array<number>(n).fill(0);
  if (totalBeta <= 0 || totalGamma <= 0) return place;

  for (let h = 0; h < n; h++) {
    const ph = probs[h];
    if (!Number.isFinite(ph) || ph <= 0) {
      result[h] = place[h];
      continue;
    }
    const phGamma = pGamma[h];

    let p3rd = 0;
    for (let i = 0; i < n; i++) {
      if (i === h) continue;
      const pi = probs[i];
      if (!Number.isFinite(pi) || pi <= 0) continue;
      const denomBeta = totalBeta - pBeta[i];
      if (denomBeta <= 0) continue;

      for (let j = 0; j < n; j++) {
        if (j === h || j === i) continue;
        const pj = probs[j];
        if (!Number.isFinite(pj) || pj <= 0) continue;
        const denomGamma = totalGamma - pGamma[i] - pGamma[j];
        if (denomGamma <= 0) continue;

        p3rd += pi * (pBeta[j] / denomBeta) * (phGamma / denomGamma);
      }
    }
    result[h] = place[h] + p3rd;
  }
  return result;
}
