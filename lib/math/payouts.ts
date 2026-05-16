import type { PayoutBand } from '../types';

const MIN_PAYOUT_PER_2 = 2.1;
const SHOW_SPLIT_FACTOR = 2 / 3;

export function breakage(returnPer2: number): number {
  const breaked = Math.floor(returnPer2 * 10) / 10;
  return Math.max(MIN_PAYOUT_PER_2, breaked);
}

export function fairPayoutPer2(p: number): number | null {
  if (!Number.isFinite(p) || p <= 0) return null;
  return 2 / p;
}

/**
 * Projected $2 win payout for a single horse. Win pool has no companion —
 * if the horse wins, all of the net pool gets distributed among the bets
 * placed on it. Returns the breaked, $2.10-floored value, or null when
 * pool data is missing/invalid.
 *
 * Note: takeout reduces the pool BEFORE distribution, so win edges
 * (actual / fair − 1) are structurally close to `-takeout` (~-15%) on
 * almost every horse. Real +EV win bets are rare and usually only show
 * up on heavy favorites where the $2.10 floor exceeds fair price.
 */
export function winPayoutPer2(
  poolHorse: number,
  totalPool: number,
  takeout: number,
): number | null {
  if (!Number.isFinite(poolHorse) || poolHorse <= 0) return null;
  if (!Number.isFinite(totalPool) || totalPool <= 0) return null;
  const net = totalPool * (1 - takeout);
  if (net <= 0) return null;
  const raw = (2 * net) / poolHorse;
  if (!Number.isFinite(raw)) return null;
  return breakage(raw);
}

function isValidCompanionPool(p: number): boolean {
  return Number.isFinite(p) && p >= 0;
}

function placeReturnRaw(
  pools: number[],
  i: number,
  j: number,
  netPool: number,
): number | null {
  const pi = pools[i];
  const pj = pools[j];
  if (!Number.isFinite(pi) || !isValidCompanionPool(pj)) return null;
  if (pi <= 0) return null;
  return 2 + (netPool - pi - pj) / pi;
}

function showReturnRaw(
  pools: number[],
  i: number,
  j: number,
  k: number,
  netPool: number,
): number | null {
  const pi = pools[i];
  const pj = pools[j];
  const pk = pools[k];
  if (!Number.isFinite(pi) || !isValidCompanionPool(pj) || !isValidCompanionPool(pk)) return null;
  if (pi <= 0) return null;
  return 2 + SHOW_SPLIT_FACTOR * ((netPool - pi - pj - pk) / pi);
}

/**
 * Harville-derived companion weight for the place mid:
 *   P(j is the OTHER top-2 horse | i is top-2) ∝ pj / (1 - pj)
 * The pi factor in the numerator cancels in normalization since it's the same
 * across all candidate j. We renormalize across valid j only.
 */
function harvillePlaceCompanionWeight(
  probs: number[],
  i: number,
  validCompanions: number[],
): Map<number, number> {
  const weights = new Map<number, number>();
  let total = 0;
  for (const j of validCompanions) {
    const pj = probs[j];
    if (!Number.isFinite(pj) || pj <= 0 || pj >= 1) continue;
    const w = pj / (1 - pj);
    weights.set(j, w);
    total += w;
  }
  // If we couldn't compute weights (no valid probs), fall back to uniform
  // by leaving an empty map — caller treats empty as "use uniform".
  if (total <= 0) return new Map();
  for (const [j, w] of weights) weights.set(j, w / total);
  return weights;
}

/**
 * Harville-derived weight for an unordered show pair (j, k):
 *   P({j,k} are the OTHER two top-3 | i top-3) — sum over the 6 permutations
 *   of (i, j, k) under Harville order-statistics, then renormalize.
 *
 * For computational simplicity we compute a single ordering's weight and
 * symmetrize. This is a defensible Harville-weighted approximation; the full
 * 6-permutation sum is proportional and would normalize to the same map.
 */
function harvilleShowPairWeight(
  probs: number[],
  i: number,
  validCompanions: number[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const pi = probs[i];
  if (!Number.isFinite(pi) || pi <= 0) return weights;
  let total = 0;
  for (let a = 0; a < validCompanions.length; a++) {
    for (let b = a + 1; b < validCompanions.length; b++) {
      const j = validCompanions[a];
      const k = validCompanions[b];
      const pj = probs[j];
      const pk = probs[k];
      if (!Number.isFinite(pj) || pj <= 0 || pj >= 1) continue;
      if (!Number.isFinite(pk) || pk <= 0 || pk >= 1) continue;
      const denomJK = 1 - pj - pk;
      if (denomJK <= 0) continue;
      // Sum the two Harville orderings of (j, k) given i top-3 in some seat:
      //   pj·pk / ((1-pj)(1-pj-pk)) + pk·pj / ((1-pk)(1-pj-pk))
      // The pi factors and the symmetry across i's seat (1st/2nd/3rd) cancel
      // out under final normalization, so we omit them here for speed.
      const w =
        (pj * pk) / ((1 - pj) * denomJK) + (pj * pk) / ((1 - pk) * denomJK);
      const key = a < b ? `${j}-${k}` : `${k}-${j}`;
      weights.set(key, w);
      total += w;
    }
  }
  if (total <= 0) return new Map();
  for (const [k, v] of weights) weights.set(k, v / total);
  return weights;
}

export function placePayoutBand(
  pools: number[],
  i: number,
  totalPool: number,
  takeout: number,
  /**
   * Optional pWin vector (over the same horses as `pools`). When provided,
   * the `mid` is a Harville-weighted average across companions instead of a
   * uniform mean — which corrects a known bias where uniform-mean overweights
   * unlikely companions. Floor and ceiling are unaffected (always use the
   * deterministic max-pool / min-pool companion).
   */
  probs?: number[],
): PayoutBand {
  const n = pools.length;
  const netPool = totalPool * (1 - takeout);
  const pi = pools[i];
  if (
    !Number.isFinite(pi) ||
    pi <= 0 ||
    !Number.isFinite(netPool) ||
    netPool <= 0 ||
    n < 2
  ) {
    return { floor: null, mid: null, ceiling: null };
  }

  const companions: number[] = [];
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const pj = pools[j];
    if (!isValidCompanionPool(pj)) continue;
    companions.push(j);
  }
  if (companions.length === 0) {
    return { floor: null, mid: null, ceiling: null };
  }

  let floorJ = companions[0];
  let ceilJ = companions[0];
  for (const j of companions) {
    if (pools[j] > pools[floorJ]) floorJ = j;
    if (pools[j] < pools[ceilJ]) ceilJ = j;
  }

  const floorRaw = placeReturnRaw(pools, i, floorJ, netPool);
  const ceilRaw = placeReturnRaw(pools, i, ceilJ, netPool);

  // Mid: break each scenario's payout, then take a (Harville-weighted, when
  // probs supplied; otherwise uniform) mean of the broken payouts.
  // Heavy favorites are far more likely to be the actual companion than
  // longshots, so weighting by P(j | i top-2) ∝ pj/(1-pj) is more accurate
  // than the uniform mean. Floor and ceiling are deliberately unweighted —
  // they bracket worst/best companion-pool scenarios, not a probability mean.
  const placeWeights = probs
    ? harvillePlaceCompanionWeight(probs, i, companions)
    : new Map<number, number>();

  let midSum = 0;
  let weightSum = 0;
  for (const j of companions) {
    const r = placeReturnRaw(pools, i, j, netPool);
    if (r === null || !Number.isFinite(r)) continue;
    const w = placeWeights.size > 0 ? (placeWeights.get(j) ?? 0) : 1;
    if (w <= 0) continue;
    midSum += w * breakage(r);
    weightSum += w;
  }
  const mid = weightSum > 0 ? midSum / weightSum : null;

  return {
    floor: floorRaw !== null && Number.isFinite(floorRaw) ? breakage(floorRaw) : null,
    mid,
    ceiling: ceilRaw !== null && Number.isFinite(ceilRaw) ? breakage(ceilRaw) : null,
  };
}

export function showPayoutBand(
  pools: number[],
  i: number,
  totalPool: number,
  takeout: number,
  /**
   * Optional pWin vector. When provided, the `mid` becomes Harville-weighted
   * across companion pairs instead of a uniform mean over all pairs. Same
   * rationale as placePayoutBand: favored pairs are more likely outcomes.
   */
  probs?: number[],
): PayoutBand {
  const n = pools.length;
  const netPool = totalPool * (1 - takeout);
  const pi = pools[i];
  if (
    !Number.isFinite(pi) ||
    pi <= 0 ||
    !Number.isFinite(netPool) ||
    netPool <= 0 ||
    n < 3
  ) {
    return { floor: null, mid: null, ceiling: null };
  }

  const companions: number[] = [];
  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const pj = pools[j];
    if (!isValidCompanionPool(pj)) continue;
    companions.push(j);
  }
  if (companions.length < 2) {
    return { floor: null, mid: null, ceiling: null };
  }

  const sortedDesc = [...companions].sort((a, b) => pools[b] - pools[a]);
  const sortedAsc = [...companions].sort((a, b) => pools[a] - pools[b]);
  const floorJ = sortedDesc[0];
  const floorK = sortedDesc[1];
  const ceilJ = sortedAsc[0];
  const ceilK = sortedAsc[1];

  const floorRaw = showReturnRaw(pools, i, floorJ, floorK, netPool);
  const ceilRaw = showReturnRaw(pools, i, ceilJ, ceilK, netPool);

  // Mid: (Harville-weighted, when probs supplied; otherwise uniform) mean of
  // broken payouts across all (j, k) companion pairs. Floor/ceiling unchanged
  // — they bracket worst/best companion-pool scenarios.
  const showWeights = probs
    ? harvilleShowPairWeight(probs, i, companions)
    : new Map<string, number>();

  let midSum = 0;
  let weightSum = 0;
  for (let a = 0; a < companions.length; a++) {
    for (let b = a + 1; b < companions.length; b++) {
      const j = companions[a];
      const k = companions[b];
      const r = showReturnRaw(pools, i, j, k, netPool);
      if (r === null || !Number.isFinite(r)) continue;
      const key = j < k ? `${j}-${k}` : `${k}-${j}`;
      const w = showWeights.size > 0 ? (showWeights.get(key) ?? 0) : 1;
      if (w <= 0) continue;
      midSum += w * breakage(r);
      weightSum += w;
    }
  }
  const mid = weightSum > 0 ? midSum / weightSum : null;

  return {
    floor: floorRaw !== null && Number.isFinite(floorRaw) ? breakage(floorRaw) : null,
    mid,
    ceiling: ceilRaw !== null && Number.isFinite(ceilRaw) ? breakage(ceilRaw) : null,
  };
}
