import type { EdgeBundle, Signal } from '../types';

export function computeEdge(actual: number | null, fair: number | null): number | null {
  if (actual === null || fair === null) return null;
  if (!Number.isFinite(actual) || !Number.isFinite(fair) || fair <= 0) return null;
  return actual / fair - 1;
}

export function computeMlDrift(
  currentOdds: number | null,
  mlOdds: number | null,
): number | null {
  if (currentOdds === null || mlOdds === null) return null;
  if (!Number.isFinite(currentOdds) || !Number.isFinite(mlOdds) || mlOdds <= 0) return null;
  return (currentOdds - mlOdds) / mlOdds;
}

export function classifySignal(
  placeEdge: EdgeBundle,
  showEdge: EdgeBundle,
  mlDrift: number | null,
  leanThreshold: number,
  driftThreshold: number,
): Signal {
  if (
    (placeEdge.harvilleFloor !== null && placeEdge.harvilleFloor > 0) ||
    (showEdge.harvilleFloor !== null && showEdge.harvilleFloor > 0)
  ) {
    return 'slam_dunk';
  }
  if (
    (placeEdge.harvilleMid !== null && placeEdge.harvilleMid > leanThreshold) ||
    (showEdge.harvilleMid !== null && showEdge.harvilleMid > leanThreshold)
  ) {
    return 'lean';
  }
  if (mlDrift !== null && mlDrift > driftThreshold) {
    return 'drift';
  }
  return 'none';
}
