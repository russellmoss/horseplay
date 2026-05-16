import { describe, expect, it } from 'vitest';
import { heuristicPlaceProbs, heuristicShowProbs } from '../lib/math/heuristic';

describe('heuristicPlaceProbs (Invariant 7: capped at 0.999)', () => {
  it('caps at 0.999 for high p_win', () => {
    const out = heuristicPlaceProbs([0.6, 0.5, 0.49999, 0.4]);
    expect(out[0]).toBe(0.999);
    expect(out[1]).toBe(0.999);
    expect(out[2]).toBe(0.999);
    expect(out[3]).toBeCloseTo(0.8, 12);
  });

  it('returns 2 × p for sub-half p_win', () => {
    expect(heuristicPlaceProbs([0.1, 0.2, 0.3])).toEqual([0.2, 0.4, 0.6]);
  });

  it('returns 0 for p_win = 0', () => {
    expect(heuristicPlaceProbs([0, 0])).toEqual([0, 0]);
  });
});

describe('heuristicShowProbs (Invariant 7: capped at 0.999)', () => {
  it('caps at 0.999 when 3 × p ≥ 1', () => {
    const out = heuristicShowProbs([0.4, 0.34, 0.333334]);
    expect(out[0]).toBe(0.999);
    expect(out[1]).toBe(0.999);
    expect(out[2]).toBe(0.999);
  });

  it('returns 3 × p for p_win < 1/3', () => {
    expect(heuristicShowProbs([0.1, 0.2, 0.3])).toEqual([
      0.30000000000000004,
      0.6000000000000001,
      0.8999999999999999,
    ]);
  });
});
