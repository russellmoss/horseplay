import { describe, expect, it } from 'vitest';
import { harvillePlaceProbs, harvilleShowProbs } from '../lib/math/harville';

const TOL_PLACE = 1e-6;
const TOL_SHOW = 1e-6;

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1103515245 * s + 12345) >>> 0;
    return s / 0x100000000;
  };
}

function randomNormalizedProbs(rng: () => number, n: number): number[] {
  const raw: number[] = [];
  for (let i = 0; i < n; i++) raw.push(rng() + 0.001);
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => r / total);
}

describe('harvillePlaceProbs', () => {
  it('hand-computed [0.5, 0.3, 0.2]', () => {
    const place = harvillePlaceProbs([0.5, 0.3, 0.2]);
    // p_place_1 = 0.5 + 0.3·0.5/0.7 + 0.2·0.5/0.8
    //           = 0.5 + 0.214285714286 + 0.125
    //           = 0.839285714286
    expect(place[0]).toBeCloseTo(0.5 + 0.3 * 0.5 / 0.7 + 0.2 * 0.5 / 0.8, 12);
    // p_place_2 = 0.3 + 0.5·0.3/0.5 + 0.2·0.3/0.8 = 0.3 + 0.3 + 0.075 = 0.675
    expect(place[1]).toBeCloseTo(0.675, 12);
    // p_place_3 = 0.2 + 0.5·0.2/0.5 + 0.3·0.2/0.7 = 0.2 + 0.2 + 0.0857142857 = 0.4857142857
    expect(place[2]).toBeCloseTo(0.2 + 0.5 * 0.2 / 0.5 + 0.3 * 0.2 / 0.7, 12);
  });

  it('Invariant 2: place probs sum to 2.0 ± 1e-6 across 100 random vectors (n=4..15)', () => {
    const rng = lcg(42);
    for (let trial = 0; trial < 100; trial++) {
      const n = 4 + Math.floor(rng() * 12);
      const probs = randomNormalizedProbs(rng, n);
      const place = harvillePlaceProbs(probs);
      expect(Math.abs(sum(place) - 2)).toBeLessThan(TOL_PLACE);
    }
  });

  it('n=2 race: each horse must place', () => {
    const place = harvillePlaceProbs([0.6, 0.4]);
    expect(place[0]).toBeCloseTo(1, 12);
    expect(place[1]).toBeCloseTo(1, 12);
  });

  it('uniform 4-horse: each place prob = 0.5', () => {
    const place = harvillePlaceProbs([0.25, 0.25, 0.25, 0.25]);
    for (const p of place) expect(p).toBeCloseTo(0.5, 12);
  });

  it('Invariant 8: no NaN, no Infinity', () => {
    const probs = [0.5, 0.3, 0.2];
    for (const p of harvillePlaceProbs(probs)) {
      expect(Number.isFinite(p)).toBe(true);
    }
  });
});

describe('harvilleShowProbs', () => {
  it('hand-computed [0.5, 0.3, 0.2] — every horse shows in a 3-horse race', () => {
    const show = harvilleShowProbs([0.5, 0.3, 0.2]);
    expect(show[0]).toBeCloseTo(1, 12);
    expect(show[1]).toBeCloseTo(1, 12);
    expect(show[2]).toBeCloseTo(1, 12);
  });

  it('Invariant 3: show probs sum to 3.0 ± 1e-6 across 100 random vectors (n=4..15)', () => {
    const rng = lcg(43);
    for (let trial = 0; trial < 100; trial++) {
      const n = 4 + Math.floor(rng() * 12);
      const probs = randomNormalizedProbs(rng, n);
      const show = harvilleShowProbs(probs);
      expect(Math.abs(sum(show) - 3)).toBeLessThan(TOL_SHOW);
    }
  });

  it('uniform 4-horse: each show prob = 0.75', () => {
    const show = harvilleShowProbs([0.25, 0.25, 0.25, 0.25]);
    for (const p of show) expect(p).toBeCloseTo(0.75, 12);
  });

  it('show ≥ place for every horse (more chances to be top-3 than top-2)', () => {
    const probs = [0.4, 0.3, 0.15, 0.1, 0.05];
    const place = harvillePlaceProbs(probs);
    const show = harvilleShowProbs(probs);
    for (let i = 0; i < probs.length; i++) {
      expect(show[i]).toBeGreaterThanOrEqual(place[i] - 1e-12);
    }
  });

  it('uses ordered (j, k) pairs — does NOT iterate j < k', () => {
    // If the show implementation accidentally used unordered pairs (j < k),
    // each contribution would be halved and show probs would sum to ~1.5, not 3.
    // This test catches that pitfall directly.
    const show = harvilleShowProbs([0.4, 0.3, 0.2, 0.1]);
    expect(sum(show)).toBeCloseTo(3, 6);
  });
});
