import { describe, expect, it } from 'vitest';
import { classifySignal, computeEdge, computeMlDrift } from '../lib/math/ev';
import { harvillePlaceProbs } from '../lib/math/harville';
import { placePayoutBand, fairPayoutPer2 } from '../lib/math/payouts';
import { probsFromWinPool } from '../lib/math/probability';
import type { EdgeBundle } from '../lib/types';

const TAKEOUT = 0.17;
const LEAN = 0.05;
const DRIFT_THRESHOLD = 0.5;

const NULL_EDGES: EdgeBundle = {
  heuristicFloor: null,
  heuristicMid: null,
  harvilleFloor: null,
  harvilleMid: null,
  heneryFloor: null,
  heneryMid: null,
};

describe('computeEdge', () => {
  it('returns actual / fair − 1', () => {
    expect(computeEdge(4.0, 2.0)).toBe(1);
    expect(computeEdge(2.5, 2.0)).toBe(0.25);
    expect(computeEdge(2.0, 4.0)).toBe(-0.5);
  });

  it('Invariant 8: returns null for null/NaN/zero inputs', () => {
    expect(computeEdge(null, 2)).toBeNull();
    expect(computeEdge(2, null)).toBeNull();
    expect(computeEdge(NaN, 2)).toBeNull();
    expect(computeEdge(2, 0)).toBeNull();
    expect(computeEdge(2, -1)).toBeNull();
  });
});

describe('computeMlDrift', () => {
  it('= (current − ml) / ml', () => {
    expect(computeMlDrift(10, 5)).toBe(1);
    expect(computeMlDrift(6, 5)).toBeCloseTo(0.2, 12);
    expect(computeMlDrift(4, 5)).toBeCloseTo(-0.2, 12);
  });

  it('returns null when either is null or ml is zero', () => {
    expect(computeMlDrift(null, 5)).toBeNull();
    expect(computeMlDrift(5, null)).toBeNull();
    expect(computeMlDrift(5, 0)).toBeNull();
  });
});

describe('classifySignal — priority order', () => {
  it('slam_dunk wins when harvilleFloor > 0 anywhere', () => {
    const place: EdgeBundle = { ...NULL_EDGES, harvilleFloor: 0.001 };
    expect(classifySignal(place, NULL_EDGES, 5, LEAN, DRIFT_THRESHOLD)).toBe('slam_dunk');
  });

  it('lean when harvilleMid > leanThreshold but no slam_dunk', () => {
    const place: EdgeBundle = { ...NULL_EDGES, harvilleMid: 0.06 };
    expect(classifySignal(place, NULL_EDGES, null, LEAN, DRIFT_THRESHOLD)).toBe('lean');
  });

  it('lean threshold is strictly greater-than (= 0.05 → not lean)', () => {
    const place: EdgeBundle = { ...NULL_EDGES, harvilleMid: 0.05 };
    expect(classifySignal(place, NULL_EDGES, null, LEAN, DRIFT_THRESHOLD)).toBe('none');
  });

  it('drift when mlDrift > driftThreshold and no edge signals', () => {
    expect(classifySignal(NULL_EDGES, NULL_EDGES, 0.6, LEAN, DRIFT_THRESHOLD)).toBe('drift');
  });

  it('drift threshold is strictly greater-than (= 0.5 → not drift)', () => {
    expect(classifySignal(NULL_EDGES, NULL_EDGES, 0.5, LEAN, DRIFT_THRESHOLD)).toBe('none');
  });

  it('none when nothing triggers', () => {
    expect(classifySignal(NULL_EDGES, NULL_EDGES, 0.3, LEAN, DRIFT_THRESHOLD)).toBe('none');
  });

  it('slam_dunk beats drift when both apply', () => {
    const place: EdgeBundle = { ...NULL_EDGES, harvilleFloor: 0.5 };
    expect(classifySignal(place, NULL_EDGES, 10, LEAN, DRIFT_THRESHOLD)).toBe('slam_dunk');
  });

  it('lean beats drift when both apply', () => {
    const place: EdgeBundle = { ...NULL_EDGES, harvilleMid: 0.10 };
    expect(classifySignal(place, NULL_EDGES, 5, LEAN, DRIFT_THRESHOLD)).toBe('lean');
  });

  it('null edges everywhere + null drift → none (no false positives)', () => {
    expect(classifySignal(NULL_EDGES, NULL_EDGES, null, LEAN, DRIFT_THRESHOLD)).toBe('none');
  });
});

describe('integration — plunged-pool true positive', () => {
  it('a horse with a tiny place pool produces a positive harville edge', () => {
    // Horse 2 has a normal win prob (~10%) but barely any place money.
    // Companions all have substantial place pools, so leftover when horse 2 places is huge.
    const winPools = [10000, 10000, 50000, 20000, 10000];
    const placePools = [10000, 1000, 30000, 20000, 10000];
    const totalPlace = 71000;
    const probs = probsFromWinPool(winPools);
    const place = harvillePlaceProbs(probs);
    const fair = fairPayoutPer2(place[1]) as number;
    const band = placePayoutBand(placePools, 1, totalPlace, TAKEOUT);
    const floorEdge = computeEdge(band.floor, fair);
    expect(floorEdge).not.toBeNull();
    expect(floorEdge as number).toBeGreaterThan(0);
  });
});

describe('integration — no false positives on a "no edge" race', () => {
  it('pools proportional to win prob → no harvilleFloor edges > 0', () => {
    // Win pool == place pool ratios. Heavy favorites get clipped by the $2.10 floor;
    // longshots have lower actual than fair due to breakage. Either way: no slam_dunk false positives.
    const winPools = [50000, 35000, 25000, 12000, 10000, 6000];
    const placePools = [50000, 35000, 25000, 12000, 10000, 6000];
    const totalPlace = 138000;
    const probs = probsFromWinPool(winPools);
    const place = harvillePlaceProbs(probs);
    for (let i = 0; i < winPools.length; i++) {
      const fair = fairPayoutPer2(place[i]) as number;
      const band = placePayoutBand(placePools, i, totalPlace, TAKEOUT);
      const floorEdge = computeEdge(band.floor, fair);
      expect(floorEdge).not.toBeNull();
      expect(floorEdge as number).toBeLessThanOrEqual(0);
    }
  });
});
