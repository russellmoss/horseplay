const HEURISTIC_PROB_CAP = 0.999;

export function heuristicPlaceProbs(probs: number[]): number[] {
  return probs.map((p) =>
    Number.isFinite(p) && p > 0 ? Math.min(HEURISTIC_PROB_CAP, 2 * p) : 0,
  );
}

export function heuristicShowProbs(probs: number[]): number[] {
  return probs.map((p) =>
    Number.isFinite(p) && p > 0 ? Math.min(HEURISTIC_PROB_CAP, 3 * p) : 0,
  );
}
