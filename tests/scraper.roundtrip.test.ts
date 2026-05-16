import { afterEach, describe, expect, it } from 'vitest';
import { adaptFdrToRace, type FdrRaceUpdate } from '../lib/scraper/adapter';
import { ingestRaceUpdate } from '../lib/scraper/poller';
import { clearStore, getRace, listRaces, storeSize } from '../lib/store';
import sampleRaceUpdate from '../fixtures/sample-fdr-race-update.json';
import sampleRaceFinished from '../fixtures/sample-fdr-race-finished.json';

const liveRace = sampleRaceUpdate as unknown as FdrRaceUpdate;
const finishedRace = sampleRaceFinished as unknown as FdrRaceUpdate;

const ANALYZE_OPTIONS = {
  takeoutPlace: 0.17,
  takeoutShow: 0.17,
  leanThreshold: 0.05,
  driftThreshold: 0.5,
  now: () => '2026-05-02T22:00:00.000Z',
};

describe('scraper round-trip — FDR JSON → adapter → math.analyzeRace → store', () => {
  afterEach(() => {
    clearStore();
  });

  it('a single live FDR frame produces a cached RaceAnalysis indexed by raceId', () => {
    const analysis = ingestRaceUpdate(liveRace, ANALYZE_OPTIONS);
    expect(analysis.race.raceId).toBe('CD-7');
    expect(storeSize()).toBe(1);
    expect(getRace('CD-7')).toBe(analysis);
  });

  it('the cached analysis carries the math layer outputs (Harville + heuristic + signals)', () => {
    ingestRaceUpdate(liveRace, ANALYZE_OPTIONS);
    const cached = getRace('CD-7');
    expect(cached).not.toBeNull();
    expect(cached!.probSource).toBe('win_pool');
    expect(cached!.rows.length).toBe(9);
    for (const row of cached!.rows) {
      expect(row.heuristic).toBeDefined();
      expect(row.harville).toBeDefined();
      // Pool data is present on the live fixture, so projected payouts are populated.
      expect(row.placeProjected.floor).not.toBeNull();
      expect(row.showProjected.floor).not.toBeNull();
    }
  });

  it('Σ pWin = 1 across all rows in the cached analysis', () => {
    ingestRaceUpdate(liveRace, ANALYZE_OPTIONS);
    const cached = getRace('CD-7')!;
    const total = cached.rows.reduce((s, r) => s + r.pWin, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });

  it('a second frame for the same race overwrites the cache (last-write-wins)', () => {
    ingestRaceUpdate(liveRace, ANALYZE_OPTIONS);
    const first = getRace('CD-7')!;
    // Mutate the input slightly: bump win pool by $1000 to simulate a later frame
    const second: FdrRaceUpdate = {
      ...liveRace,
      racePools: liveRace.racePools!.map((rp) =>
        rp.wagerType.code === 'WN' ? { ...rp, amount: (rp.amount ?? 0) + 1000 } : rp,
      ),
    };
    ingestRaceUpdate(second, ANALYZE_OPTIONS);
    const cached = getRace('CD-7')!;
    expect(cached).not.toBe(first);
    expect(cached.race.totalWinPool).toBe((first.race.totalWinPool ?? 0) + 1000);
    expect(storeSize()).toBe(1);
  });

  it('a finished race round-trips with status="official" and results carried through', () => {
    ingestRaceUpdate(finishedRace, ANALYZE_OPTIONS);
    const cached = getRace('CD-1')!;
    expect(cached.race.status).toBe('official');
    expect(cached.race.results).not.toBeNull();
    expect(cached.race.results!.runners[0].name).toBe('Powershift');
    expect(cached.race.results!.runners[0].winPayoff).toBe(4.14);
  });

  it('multiple races coexist in the store, indexed independently', () => {
    ingestRaceUpdate(liveRace, ANALYZE_OPTIONS);
    ingestRaceUpdate(finishedRace, ANALYZE_OPTIONS);
    expect(storeSize()).toBe(2);
    expect(listRaces().map((a) => a.race.raceId).sort()).toEqual(['CD-1', 'CD-7']);
  });

  it('every cached row is free of NaN/Infinity (Invariant 8 carried through the pipeline)', () => {
    ingestRaceUpdate(liveRace, ANALYZE_OPTIONS);
    const cached = getRace('CD-7')!;
    function hasNaN(value: unknown): boolean {
      if (typeof value === 'number') return !Number.isFinite(value);
      if (value === null || value === undefined) return false;
      if (Array.isArray(value)) return value.some(hasNaN);
      if (typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) {
          if (hasNaN(v)) return true;
        }
      }
      return false;
    }
    expect(hasNaN(cached)).toBe(false);
  });
});

describe('adapter — direct sanity check on the live fixture', () => {
  it('produces a Race ready for analyzeRace (no nulls in critical math inputs)', () => {
    const race = adaptFdrToRace(liveRace, { now: () => '2026-05-02T22:00:00.000Z' });
    // Every horse has either a win pool, a current odds, or both — required for prob extraction.
    for (const h of race.horses) {
      const usable = h.winPoolDollars !== null || h.currentOdds !== null;
      expect(usable).toBe(true);
    }
  });
});
