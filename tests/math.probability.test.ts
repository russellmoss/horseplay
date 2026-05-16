import { describe, expect, it } from 'vitest';
import {
  applyFavoriteLongshotBias,
  probsFromDecimalOdds,
  probsFromWinPool,
  uniformProbs,
} from '../lib/math/probability';

const TOL = 1e-9;

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function randomPositive(rng: () => number, max: number): number {
  return rng() * max + 1;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1103515245 * s + 12345) >>> 0;
    return s / 0x100000000;
  };
}

describe('probsFromWinPool', () => {
  it('sums to 1 for the spec fixture', () => {
    const probs = probsFromWinPool([50000, 35000, 25000, 12000, 10000, 6000]);
    expect(sum(probs)).toBeCloseTo(1, 12);
    expect(probs[0]).toBeCloseTo(50000 / 138000, 6);
    expect(probs[0]).toBeCloseTo(0.3623188405, 6);
  });

  it('Invariant 1: sums to 1 ± 1e-9 across 100 random pools', () => {
    const rng = lcg(1234);
    for (let trial = 0; trial < 100; trial++) {
      const n = 2 + Math.floor(rng() * 18);
      const pools: number[] = [];
      for (let i = 0; i < n; i++) pools.push(randomPositive(rng, 100000));
      const probs = probsFromWinPool(pools);
      expect(Math.abs(sum(probs) - 1)).toBeLessThan(TOL);
    }
  });

  it('falls back to uniform when total is 0', () => {
    const probs = probsFromWinPool([0, 0, 0]);
    expect(probs).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('returns empty array for n=0', () => {
    expect(probsFromWinPool([])).toEqual([]);
  });

  it('Invariant 8: no NaN, no Infinity in output', () => {
    const probs = probsFromWinPool([1, 2, 3, 4]);
    for (const p of probs) {
      expect(Number.isFinite(p)).toBe(true);
    }
  });
});

describe('probsFromDecimalOdds', () => {
  it('strips overround (sums to 1) for the fixture', () => {
    const probs = probsFromDecimalOdds([3.0, 4.0, 6.0, 8.0, 11.0, 21.0]);
    expect(sum(probs)).toBeCloseTo(1, 12);
  });

  it('Invariant 1: sums to 1 ± 1e-9 across 100 random odds vectors', () => {
    const rng = lcg(5678);
    for (let trial = 0; trial < 100; trial++) {
      const n = 2 + Math.floor(rng() * 18);
      const odds: number[] = [];
      for (let i = 0; i < n; i++) odds.push(1.5 + rng() * 50);
      const probs = probsFromDecimalOdds(odds);
      expect(Math.abs(sum(probs) - 1)).toBeLessThan(TOL);
    }
  });

  it('falls back to uniform when all odds are non-positive', () => {
    const probs = probsFromDecimalOdds([0, 0, 0]);
    expect(probs).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('returns empty array for n=0', () => {
    expect(probsFromDecimalOdds([])).toEqual([]);
  });
});

describe('uniformProbs', () => {
  it('produces n equal probabilities summing to 1', () => {
    for (const n of [1, 2, 5, 10, 20]) {
      const probs = uniformProbs(n);
      expect(probs.length).toBe(n);
      expect(sum(probs)).toBeCloseTo(1, 12);
      for (const p of probs) expect(p).toBe(1 / n);
    }
  });
});

describe('applyFavoriteLongshotBias', () => {
  it('is the identity transform when alpha = 1', () => {
    const probs = [0.5, 0.3, 0.15, 0.05];
    const out = applyFavoriteLongshotBias(probs, 1);
    expect(out.length).toBe(probs.length);
    for (let i = 0; i < probs.length; i++) {
      expect(out[i]).toBeCloseTo(probs[i], 12);
    }
  });

  it('preserves sum to 1', () => {
    const probs = [0.4, 0.3, 0.2, 0.07, 0.03];
    const out = applyFavoriteLongshotBias(probs, 1.06);
    expect(sum(out)).toBeCloseTo(1, 12);
  });

  it('boosts the favorite and shaves the longshot at alpha > 1', () => {
    const probs = [0.5, 0.3, 0.15, 0.05];
    const out = applyFavoriteLongshotBias(probs, 1.10);
    // The biggest probability gets boosted; the smallest gets shaved.
    // (Both relative to the input.)
    expect(out[0]).toBeGreaterThan(probs[0]);
    expect(out[3]).toBeLessThan(probs[3]);
  });

  it('preserves the rank ordering of horses', () => {
    const probs = [0.5, 0.3, 0.15, 0.05];
    const out = applyFavoriteLongshotBias(probs, 1.06);
    for (let i = 0; i < probs.length - 1; i++) {
      expect(out[i]).toBeGreaterThan(out[i + 1]);
    }
  });

  it('handles zero/invalid entries gracefully (treats them as 0 weight)', () => {
    const probs = [0.5, 0, 0.5];
    const out = applyFavoriteLongshotBias(probs, 1.06);
    expect(out[1]).toBe(0);
    expect(sum(out)).toBeCloseTo(1, 12);
  });

  it('clamps alpha to >= 1 (alpha < 1 is a no-op rather than reversed)', () => {
    const probs = [0.5, 0.3, 0.2];
    const reversed = applyFavoriteLongshotBias(probs, 0.5);
    // Should equal the input (no-op), not the reversed transform.
    for (let i = 0; i < probs.length; i++) {
      expect(reversed[i]).toBeCloseTo(probs[i], 12);
    }
  });

  it('matches a known closed-form case', () => {
    // probs [0.5, 0.5] with alpha 2 → [0.25, 0.25] before normalize → [0.5, 0.5] after.
    // Symmetric input is invariant under any alpha.
    const out = applyFavoriteLongshotBias([0.5, 0.5], 2);
    expect(out[0]).toBeCloseTo(0.5, 12);
    expect(out[1]).toBeCloseTo(0.5, 12);
  });

  it('shifts mass toward favorites for an asymmetric input', () => {
    // probs [0.6, 0.4], alpha = 2:
    //   raw transform: [0.36, 0.16], total = 0.52
    //   normalized: [0.36/0.52, 0.16/0.52] ≈ [0.6923, 0.3077]
    const out = applyFavoriteLongshotBias([0.6, 0.4], 2);
    expect(out[0]).toBeCloseTo(0.36 / 0.52, 6);
    expect(out[1]).toBeCloseTo(0.16 / 0.52, 6);
  });
});
