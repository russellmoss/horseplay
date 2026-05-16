import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../lib/math/index';
import type { Horse, Race } from '../lib/types';
import sampleSixHorse from '../fixtures/sample-6-horse.json';

const OPTIONS = {
  takeoutPlace: 0.17,
  takeoutShow: 0.17,
  leanThreshold: 0.05,
  driftThreshold: 0.5,
  now: () => '2026-05-02T22:00:00.000Z',
};

const fixture = sampleSixHorse as unknown as Race;

function hasNaNOrInfinity(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(hasNaNOrInfinity);
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (hasNaNOrInfinity(v)) return true;
    }
  }
  return false;
}

describe('analyzeRace — fixture integration (sample-6-horse.json)', () => {
  it('selects probSource = "win_pool" when all winPoolDollars are non-null and total > 0', () => {
    const result = analyzeRace(fixture, OPTIONS);
    expect(result.probSource).toBe('win_pool');
  });

  it('emits one row per horse (no horses scratched in fixture)', () => {
    const result = analyzeRace(fixture, OPTIONS);
    expect(result.rows.length).toBe(fixture.horses.length);
    expect(result.rows.length).toBe(6);
  });

  it('preserves program order from input race', () => {
    const result = analyzeRace(fixture, OPTIONS);
    expect(result.rows.map((r) => r.program)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('pWin sums to 1 ± 1e-9', () => {
    const result = analyzeRace(fixture, OPTIONS);
    const total = result.rows.reduce((s, r) => s + r.pWin, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  it('every row has heuristic, harville, AND henery model output (non-null fair payouts when p > 0)', () => {
    const result = analyzeRace(fixture, OPTIONS);
    for (const row of result.rows) {
      expect(row.heuristic).toBeDefined();
      expect(row.harville).toBeDefined();
      expect(row.henery).toBeDefined();
      expect(row.heuristic.placeFairPayout).not.toBeNull();
      expect(row.heuristic.showFairPayout).not.toBeNull();
      expect(row.harville.placeFairPayout).not.toBeNull();
      expect(row.harville.showFairPayout).not.toBeNull();
      expect(row.henery.placeFairPayout).not.toBeNull();
      expect(row.henery.showFairPayout).not.toBeNull();
    }
  });

  it('Henery and Harville produce different fair prices on a non-uniform race (model-comparison sanity)', () => {
    const result = analyzeRace(fixture, OPTIONS);
    // Sample 6-horse fixture has a real favorite, so the two models MUST disagree.
    let anyDiffPlace = false;
    let anyDiffShow = false;
    for (const row of result.rows) {
      if (row.harville.placeFairPayout !== row.henery.placeFairPayout) anyDiffPlace = true;
      if (row.harville.showFairPayout !== row.henery.showFairPayout) anyDiffShow = true;
    }
    expect(anyDiffPlace).toBe(true);
    expect(anyDiffShow).toBe(true);
  });

  it('Henery edges are populated alongside Harville edges in EdgeBundle', () => {
    const result = analyzeRace(fixture, OPTIONS);
    for (const row of result.rows) {
      expect(row.placeEdge.heneryFloor).not.toBeNull();
      expect(row.placeEdge.heneryMid).not.toBeNull();
      expect(row.showEdge.heneryFloor).not.toBeNull();
      expect(row.showEdge.heneryMid).not.toBeNull();
    }
  });

  it('every row has projected place and show bands populated (pools known)', () => {
    const result = analyzeRace(fixture, OPTIONS);
    for (const row of result.rows) {
      expect(row.placeProjected.floor).not.toBeNull();
      expect(row.placeProjected.mid).not.toBeNull();
      expect(row.placeProjected.ceiling).not.toBeNull();
      expect(row.showProjected.floor).not.toBeNull();
      expect(row.showProjected.mid).not.toBeNull();
      expect(row.showProjected.ceiling).not.toBeNull();
    }
  });

  it('Invariant 8: no NaN, no Infinity anywhere in the output', () => {
    const result = analyzeRace(fixture, OPTIONS);
    expect(hasNaNOrInfinity(result)).toBe(false);
  });

  it('Invariant 4: floor ≤ mid ≤ ceiling on every band of every row', () => {
    const result = analyzeRace(fixture, OPTIONS);
    for (const row of result.rows) {
      for (const band of [row.placeProjected, row.showProjected]) {
        expect(band.floor as number).toBeLessThanOrEqual(band.mid as number);
        expect(band.mid as number).toBeLessThanOrEqual(band.ceiling as number);
      }
    }
  });

  it('computedAt is set via the injected clock (deterministic in tests)', () => {
    const result = analyzeRace(fixture, OPTIONS);
    expect(result.computedAt).toBe('2026-05-02T22:00:00.000Z');
  });

  it('reports probSource = "uniform_fallback" when all win pools are zero', () => {
    const zeroedHorses: Horse[] = fixture.horses.map((h) => ({
      ...h,
      winPoolDollars: 0,
      currentOdds: null,
    }));
    const zeroed: Race = { ...fixture, horses: zeroedHorses };
    const result = analyzeRace(zeroed, OPTIONS);
    expect(result.probSource).toBe('uniform_fallback');
    // Every horse gets equal weight.
    for (const row of result.rows) {
      expect(row.pWin).toBeCloseTo(1 / zeroed.horses.length, 12);
    }
  });

  it('falls through to decimal_odds when win pools are unknown but odds are', () => {
    const oddsOnlyHorses: Horse[] = fixture.horses.map((h) => ({
      ...h,
      winPoolDollars: null,
    }));
    const oddsOnly: Race = { ...fixture, horses: oddsOnlyHorses };
    const result = analyzeRace(oddsOnly, OPTIONS);
    expect(result.probSource).toBe('decimal_odds');
  });

  it('appends scratched horses with null bands at the end', () => {
    const withScratch: Race = {
      ...fixture,
      horses: [
        ...fixture.horses.slice(0, 5),
        { ...fixture.horses[5], scratched: true },
      ],
    };
    const result = analyzeRace(withScratch, OPTIONS);
    expect(result.rows.length).toBe(6);
    const scratchedRow = result.rows[result.rows.length - 1];
    expect(scratchedRow.program).toBe('6');
    expect(scratchedRow.pWin).toBe(0);
    expect(scratchedRow.signal).toBe('none');
    expect(scratchedRow.placeProjected.floor).toBeNull();
    expect(scratchedRow.showProjected.ceiling).toBeNull();
  });
});
