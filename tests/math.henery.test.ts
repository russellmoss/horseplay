import { describe, expect, it } from 'vitest';
import {
  HENERY_DEFAULT_BETA,
  HENERY_DEFAULT_GAMMA,
  heneryPlaceProbs,
  heneryShowProbs,
} from '../lib/math/henery';
import { harvillePlaceProbs, harvilleShowProbs } from '../lib/math/harville';

const TOL = 1e-6;

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

describe('heneryPlaceProbs', () => {
  it('β = 1 collapses to Harville place probs (sanity check)', () => {
    const rng = lcg(7);
    for (let trial = 0; trial < 20; trial++) {
      const n = 4 + Math.floor(rng() * 10);
      const probs = randomNormalizedProbs(rng, n);
      const henery = heneryPlaceProbs(probs, 1);
      const harville = harvillePlaceProbs(probs);
      for (let i = 0; i < n; i++) {
        expect(henery[i]).toBeCloseTo(harville[i], 9);
      }
    }
  });

  it('Invariant: place probs sum to 2.0 ± 1e-6 across 100 random vectors (n=4..15)', () => {
    const rng = lcg(101);
    for (let trial = 0; trial < 100; trial++) {
      const n = 4 + Math.floor(rng() * 12);
      const probs = randomNormalizedProbs(rng, n);
      const place = heneryPlaceProbs(probs);
      expect(Math.abs(sum(place) - 2)).toBeLessThan(TOL);
    }
  });

  it('discounts the favorite vs Harville (Henery place < Harville place for the chalk)', () => {
    // Construct a race with a clear favorite — Henery should reduce its
    // implied 2nd-place share, so its top-2 prob is LOWER than Harville's.
    const probs = [0.5, 0.2, 0.15, 0.1, 0.05];
    const henery = heneryPlaceProbs(probs);
    const harville = harvillePlaceProbs(probs);
    expect(henery[0]).toBeLessThan(harville[0]);
    // The discounted mass redistributes to the longer-priced horses.
    // Verify the smallest-probability horse gets a NUDGE UP.
    expect(henery[probs.length - 1]).toBeGreaterThan(harville[probs.length - 1]);
  });

  it('uniform 4-horse: each place prob = 0.5 (β has no effect on uniform input)', () => {
    const place = heneryPlaceProbs([0.25, 0.25, 0.25, 0.25]);
    for (const p of place) expect(p).toBeCloseTo(0.5, 9);
  });

  it('n=2 race: each horse must place', () => {
    const place = heneryPlaceProbs([0.6, 0.4]);
    expect(place[0]).toBeCloseTo(1, 12);
    expect(place[1]).toBeCloseTo(1, 12);
  });

  it('Invariant: no NaN, no Infinity (zero-prob and degenerate inputs)', () => {
    expect(heneryPlaceProbs([0.6, 0.4, 0]).every(Number.isFinite)).toBe(true);
    expect(heneryPlaceProbs([1, 0, 0]).every(Number.isFinite)).toBe(true);
    expect(heneryPlaceProbs([]).length).toBe(0);
  });
});

describe('heneryShowProbs', () => {
  it('β = γ = 1 collapses to Harville show probs', () => {
    const rng = lcg(13);
    for (let trial = 0; trial < 20; trial++) {
      const n = 4 + Math.floor(rng() * 10);
      const probs = randomNormalizedProbs(rng, n);
      const henery = heneryShowProbs(probs, 1, 1);
      const harville = harvilleShowProbs(probs);
      for (let i = 0; i < n; i++) {
        expect(henery[i]).toBeCloseTo(harville[i], 9);
      }
    }
  });

  it('Invariant: show probs sum to 3.0 ± 1e-6 across 100 random vectors (n=4..15)', () => {
    const rng = lcg(103);
    for (let trial = 0; trial < 100; trial++) {
      const n = 4 + Math.floor(rng() * 12);
      const probs = randomNormalizedProbs(rng, n);
      const show = heneryShowProbs(probs);
      expect(Math.abs(sum(show) - 3)).toBeLessThan(TOL);
    }
  });

  it('uniform 4-horse: each show prob = 0.75', () => {
    const show = heneryShowProbs([0.25, 0.25, 0.25, 0.25]);
    for (const p of show) expect(p).toBeCloseTo(0.75, 9);
  });

  it('discounts the favorite vs Harville on show (chalk top-3 < Harville chalk top-3)', () => {
    const probs = [0.5, 0.2, 0.15, 0.1, 0.05];
    const henery = heneryShowProbs(probs);
    const harville = harvilleShowProbs(probs);
    expect(henery[0]).toBeLessThan(harville[0]);
  });

  it('show ≥ place for every horse', () => {
    const probs = [0.4, 0.3, 0.15, 0.1, 0.05];
    const place = heneryPlaceProbs(probs);
    const show = heneryShowProbs(probs);
    for (let i = 0; i < probs.length; i++) {
      expect(show[i]).toBeGreaterThanOrEqual(place[i] - 1e-12);
    }
  });

  it('n=2 race: show equals place (no third position to fill)', () => {
    const place = heneryPlaceProbs([0.6, 0.4]);
    const show = heneryShowProbs([0.6, 0.4]);
    for (let i = 0; i < 2; i++) {
      expect(show[i]).toBeCloseTo(place[i], 12);
    }
  });

  it('Invariant: no NaN, no Infinity', () => {
    expect(heneryShowProbs([0.5, 0.3, 0.2]).every(Number.isFinite)).toBe(true);
    expect(heneryShowProbs([1, 0, 0]).every(Number.isFinite)).toBe(true);
    expect(heneryShowProbs([]).length).toBe(0);
  });
});

describe('Henery default exponents', () => {
  it('exposes β and γ as constants for callers that need to vary them', () => {
    expect(HENERY_DEFAULT_BETA).toBeGreaterThan(0);
    expect(HENERY_DEFAULT_BETA).toBeLessThan(1);
    expect(HENERY_DEFAULT_GAMMA).toBeGreaterThan(0);
    expect(HENERY_DEFAULT_GAMMA).toBeLessThan(HENERY_DEFAULT_BETA);
  });
});
