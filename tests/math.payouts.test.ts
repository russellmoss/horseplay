import { describe, expect, it } from 'vitest';
import {
  breakage,
  fairPayoutPer2,
  placePayoutBand,
  showPayoutBand,
  winPayoutPer2,
} from '../lib/math/payouts';

const TAKEOUT = 0.17;

function endsInTenths(x: number): boolean {
  // Payouts must end in .x0 — i.e., (x * 10) is an integer.
  return Math.abs(x * 10 - Math.round(x * 10)) < 1e-9;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1103515245 * s + 12345) >>> 0;
    return s / 0x100000000;
  };
}

describe('breakage (Invariants 5 and 6)', () => {
  it('Math.floor not Math.round — breakage(3.49) = 3.40, not 3.50', () => {
    expect(breakage(3.49)).toBe(3.4);
  });

  it('rounds DOWN to the nearest $0.10', () => {
    expect(breakage(3.91)).toBe(3.9);
    expect(breakage(3.99999)).toBe(3.9);
    expect(breakage(10.0)).toBe(10.0);
    expect(breakage(10.05)).toBe(10.0);
  });

  it('Invariant 5: never returns less than 2.10', () => {
    expect(breakage(2.0)).toBe(2.1);
    expect(breakage(2.09)).toBe(2.1);
    expect(breakage(0.5)).toBe(2.1);
    expect(breakage(-100)).toBe(2.1);
  });

  it('Invariant 6: output always ends in .x0', () => {
    const rng = lcg(99);
    for (let i = 0; i < 200; i++) {
      const x = rng() * 100;
      expect(endsInTenths(breakage(x))).toBe(true);
    }
  });
});

describe('fairPayoutPer2', () => {
  it('= 2/p', () => {
    expect(fairPayoutPer2(0.5)).toBe(4);
    expect(fairPayoutPer2(0.25)).toBe(8);
    expect(fairPayoutPer2(1)).toBe(2);
  });

  it('Invariant 8: returns null for unknowable, never 0 or NaN', () => {
    expect(fairPayoutPer2(0)).toBeNull();
    expect(fairPayoutPer2(-0.5)).toBeNull();
    expect(fairPayoutPer2(NaN)).toBeNull();
    expect(fairPayoutPer2(Infinity)).toBeNull();
  });
});

describe('placePayoutBand', () => {
  // Standard fixture: 6 horses, place pools [20000, 15000, 12000, 8000, 7000, 4000], total 66000
  const pools = [20000, 15000, 12000, 8000, 7000, 4000];
  const totalPool = 66000;

  it('Invariant 4: floor ≤ mid ≤ ceiling for every horse', () => {
    for (let i = 0; i < pools.length; i++) {
      const band = placePayoutBand(pools, i, totalPool, TAKEOUT);
      expect(band.floor).not.toBeNull();
      expect(band.mid).not.toBeNull();
      expect(band.ceiling).not.toBeNull();
      expect(band.floor as number).toBeLessThanOrEqual(band.mid as number);
      expect(band.mid as number).toBeLessThanOrEqual(band.ceiling as number);
    }
  });

  it('Invariant 5: every payout ≥ 2.10', () => {
    for (let i = 0; i < pools.length; i++) {
      const band = placePayoutBand(pools, i, totalPool, TAKEOUT);
      for (const v of [band.floor, band.mid, band.ceiling]) {
        expect(v).not.toBeNull();
        expect(v as number).toBeGreaterThanOrEqual(2.1 - 1e-12);
      }
    }
  });

  it('Invariant 6: floor and ceiling end in .x0 (mid is the mean of broken payouts and may not)', () => {
    for (let i = 0; i < pools.length; i++) {
      const band = placePayoutBand(pools, i, totalPool, TAKEOUT);
      expect(endsInTenths(band.floor as number)).toBe(true);
      expect(endsInTenths(band.ceiling as number)).toBe(true);
    }
  });

  it('floor pairs with the LARGEST companion pool', () => {
    // For horse 5 (smallest, 4000), the floor companion is horse 0 (20000).
    // raw_return = 2 + (66000*0.83 - 4000 - 20000) / 4000
    //           = 2 + (54780 - 24000) / 4000
    //           = 2 + 30780 / 4000
    //           = 2 + 7.695 = 9.695
    // breakage = 9.6
    const band = placePayoutBand(pools, 5, totalPool, TAKEOUT);
    expect(band.floor).toBe(9.6);
  });

  it('ceiling pairs with the SMALLEST companion pool', () => {
    // For horse 0 (largest, 20000), the ceiling companion is horse 5 (4000).
    // raw_return = 2 + (54780 - 20000 - 4000) / 20000 = 2 + 30780/20000 = 3.539
    // breakage = 3.5
    const band = placePayoutBand(pools, 0, totalPool, TAKEOUT);
    expect(band.ceiling).toBe(3.5);
  });

  it('a tiny place pool relative to total produces a high projected payout', () => {
    // Plunge: horse 1 has 1000, others have 50000+
    const plungedPools = [50000, 1000, 40000, 30000];
    const total = 121000;
    const band = placePayoutBand(plungedPools, 1, total, TAKEOUT);
    // For horse 1: net = 121000 * 0.83 = 100430, leftover with any companion is ≥ 30000
    // With smallest companion (30000): raw = 2 + (100430 - 1000 - 30000) / 1000 = 2 + 69.43 = 71.43
    expect((band.ceiling as number)).toBeGreaterThan(50);
  });

  it('returns nulls when the horse has zero/negative pool', () => {
    const band = placePayoutBand([0, 1000, 2000], 0, 3000, TAKEOUT);
    expect(band.floor).toBeNull();
    expect(band.mid).toBeNull();
    expect(band.ceiling).toBeNull();
  });

  it('includes a non-scratched companion with $0 pool in band calc', () => {
    // Horse 2 has $0 pool — mathematically still a valid companion (only the
    // focal horse's pool, pi, must be > 0). With pj === 0, leftover stays
    // unchanged by that subtraction, so horse 2 should be the ceiling-pair
    // for horse 0 (smallest companion pool).
    const pools = [10000, 5000, 0, 3000];
    const total = 18000;
    // net = 18000 * 0.83 = 14940
    // ceiling pair (smallest j) = horse 2 (0):
    //   raw = 2 + (14940 - 10000 - 0) / 10000 = 2 + 4940/10000 = 2.494
    //   broken = 2.4
    const band = placePayoutBand(pools, 0, total, TAKEOUT);
    expect(band.ceiling).toBe(2.4);
    // The mid average should include all three companion scenarios (j=1, j=2, j=3),
    // so it's > 2.10 (some scenarios pay more than the floor).
    expect(band.mid as number).toBeGreaterThan(2.1);
  });

  it('returns nulls for n < 2', () => {
    const band = placePayoutBand([5000], 0, 5000, TAKEOUT);
    expect(band.floor).toBeNull();
  });

  it('Invariant 4 fuzz: floor ≤ mid ≤ ceiling across 50 random pool vectors', () => {
    const rng = lcg(7);
    for (let trial = 0; trial < 50; trial++) {
      const n = 4 + Math.floor(rng() * 10);
      const ps: number[] = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const v = 1000 + rng() * 100000;
        ps.push(v);
        total += v;
      }
      for (let i = 0; i < n; i++) {
        const band = placePayoutBand(ps, i, total, TAKEOUT);
        if (band.floor === null) continue;
        expect(band.floor as number).toBeLessThanOrEqual(band.mid as number);
        expect(band.mid as number).toBeLessThanOrEqual(band.ceiling as number);
      }
    }
  });

  it('weighted mid: identical mid for uniform probs vs. no probs', () => {
    // When all horses have equal pWin, the Harville companion weights collapse
    // to uniform, so the weighted mid should match the unweighted mid.
    const uniform = pools.map(() => 1 / pools.length);
    for (let i = 0; i < pools.length; i++) {
      const unweighted = placePayoutBand(pools, i, totalPool, TAKEOUT);
      const weighted = placePayoutBand(pools, i, totalPool, TAKEOUT, uniform);
      expect(weighted.mid).toBeCloseTo(unweighted.mid as number, 9);
    }
  });

  it('weighted mid: shifts toward favorite-companion scenario when probs are skewed', () => {
    // Heavily favor horse 0 in the win prior. Looking at horse 5 (the smallest
    // pool), the favorite-weighted mid should weight the (i=5, j=0) scenario
    // heavily — and that pairing is also the FLOOR (largest companion pool).
    // So weighted mid should slide DOWN toward the floor relative to uniform.
    const skewed = [0.6, 0.15, 0.1, 0.07, 0.05, 0.03];
    const i = 5;
    const unweighted = placePayoutBand(pools, i, totalPool, TAKEOUT);
    const weighted = placePayoutBand(pools, i, totalPool, TAKEOUT, skewed);
    expect(weighted.mid as number).toBeLessThan(unweighted.mid as number);
    // Floor and ceiling are unaffected by weighting.
    expect(weighted.floor).toBe(unweighted.floor);
    expect(weighted.ceiling).toBe(unweighted.ceiling);
  });

  it('weighted mid stays within [floor, ceiling]', () => {
    const skewed = [0.4, 0.25, 0.15, 0.1, 0.07, 0.03];
    for (let i = 0; i < pools.length; i++) {
      const band = placePayoutBand(pools, i, totalPool, TAKEOUT, skewed);
      expect(band.mid as number).toBeGreaterThanOrEqual(band.floor as number - 1e-12);
      expect(band.mid as number).toBeLessThanOrEqual(band.ceiling as number + 1e-12);
    }
  });
});

describe('showPayoutBand', () => {
  const pools = [10000, 8000, 7000, 6000, 5500, 3500];
  const totalPool = 40000;

  it('Invariant 4: floor ≤ mid ≤ ceiling for every horse', () => {
    for (let i = 0; i < pools.length; i++) {
      const band = showPayoutBand(pools, i, totalPool, TAKEOUT);
      expect(band.floor).not.toBeNull();
      expect(band.mid).not.toBeNull();
      expect(band.ceiling).not.toBeNull();
      expect(band.floor as number).toBeLessThanOrEqual(band.mid as number);
      expect(band.mid as number).toBeLessThanOrEqual(band.ceiling as number);
    }
  });

  it('Invariant 5: every payout ≥ 2.10', () => {
    for (let i = 0; i < pools.length; i++) {
      const band = showPayoutBand(pools, i, totalPool, TAKEOUT);
      for (const v of [band.floor, band.mid, band.ceiling]) {
        expect(v).not.toBeNull();
        expect(v as number).toBeGreaterThanOrEqual(2.1 - 1e-12);
      }
    }
  });

  it('Invariant 6: floor and ceiling end in .x0 (mid is the mean of broken payouts and may not)', () => {
    for (let i = 0; i < pools.length; i++) {
      const band = showPayoutBand(pools, i, totalPool, TAKEOUT);
      expect(endsInTenths(band.floor as number)).toBe(true);
      expect(endsInTenths(band.ceiling as number)).toBe(true);
    }
  });

  it('floor pairs with the TWO LARGEST companion pools (with 2/3 split factor)', () => {
    // For horse 5 (smallest, 3500), the floor companions are horse 0 (10000) and horse 1 (8000).
    // net = 40000 * 0.83 = 33200
    // leftover = 33200 - 3500 - 10000 - 8000 = 11700
    // raw = 2 + (2/3) × (11700 / 3500) = 2 + (2/3) × 3.342857 = 2 + 2.228571 = 4.228571
    // breakage = floor(42.286)/10 = 4.2
    const band = showPayoutBand(pools, 5, totalPool, TAKEOUT);
    expect(band.floor).toBe(4.2);
  });

  it('ceiling pairs with the TWO SMALLEST companion pools (with 2/3 split factor)', () => {
    // For horse 0 (largest, 10000), the ceiling companions are horse 5 (3500) and horse 4 (5500).
    // leftover = 33200 - 10000 - 5500 - 3500 = 14200
    // raw = 2 + (2/3) × (14200 / 10000) = 2 + (2/3) × 1.42 = 2 + 0.946667 = 2.946667
    // breakage = floor(29.467)/10 = 2.9
    const band = showPayoutBand(pools, 0, totalPool, TAKEOUT);
    expect(band.ceiling).toBe(2.9);
  });

  it('show payout matches the Gemini hand-derivation: $300k pool / $50k/$40k/$30k winners → $5.00 on $30k horse', () => {
    // 3-horse race, all bet to show. Pool $300k, takeout 15%.
    // Net = 255000. Per-pool profit share = (255000 - 50000 - 40000 - 30000)/3 = 45000.
    // For the $30k pool: pool returns to 75000. Per-$2 return = 2 × 75000/30000 = 5.0.
    const showPools = [50000, 40000, 30000];
    const total = 300000;
    const takeout = 0.15;
    const band = showPayoutBand(showPools, 2, total, takeout);
    expect(band.floor).toBe(5.0);
    expect(band.ceiling).toBe(5.0);
  });

  it('returns nulls for n < 3', () => {
    const band = showPayoutBand([5000, 3000], 0, 8000, TAKEOUT);
    expect(band.floor).toBeNull();
  });
});

describe('winPayoutPer2', () => {
  it('basic case: $1000 in winner pool of $10000 net pool, no takeout', () => {
    // pure formula check: 2 * net / pool = 2 * 8400 / 1000 = 16.8 → broken to 16.8
    expect(winPayoutPer2(1000, 10_000, 0.16)).toBe(16.8);
  });

  it('takeout reduces the payout proportionally', () => {
    // Without takeout, 2 * 10_000 / 5000 = 4.0. With 16% takeout, = 3.36 → 3.30 broken
    expect(winPayoutPer2(5000, 10_000, 0.16)).toBe(3.3);
    // 0% takeout: full 4.0
    expect(winPayoutPer2(5000, 10_000, 0)).toBe(4.0);
  });

  it('returns null when the horse has no money in the pool', () => {
    expect(winPayoutPer2(0, 10_000, 0.16)).toBeNull();
    expect(winPayoutPer2(-1, 10_000, 0.16)).toBeNull();
    expect(winPayoutPer2(NaN, 10_000, 0.16)).toBeNull();
  });

  it('returns null when total pool is zero', () => {
    expect(winPayoutPer2(1000, 0, 0.16)).toBeNull();
  });

  it('honors $2.10 minimum payout floor', () => {
    // huge favorite with most of the pool: heavy takeout still holds floor
    expect(winPayoutPer2(9000, 10_000, 0.16)).toBe(2.1);
  });

  it('output always ends in .x0 (breakage rounds DOWN)', () => {
    const v = winPayoutPer2(1234, 10_000, 0.16);
    expect(v).not.toBeNull();
    const tenths = (v as number) * 10;
    expect(Math.abs(tenths - Math.round(tenths))).toBeLessThan(1e-9);
  });
});

describe('takeout direction (pitfall: net = total × (1 − takeout))', () => {
  it('higher takeout produces SMALLER net pool, hence smaller payouts', () => {
    const pools = [10000, 8000, 6000];
    const total = 24000;
    const lowTakeout = placePayoutBand(pools, 0, total, 0.05);
    const highTakeout = placePayoutBand(pools, 0, total, 0.30);
    expect(lowTakeout.ceiling as number).toBeGreaterThan(highTakeout.ceiling as number);
  });
});
