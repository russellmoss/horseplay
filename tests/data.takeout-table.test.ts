import { describe, expect, it } from 'vitest';
import {
  TRACK_TAKEOUT,
  resolveTakeoutForTrack,
} from '../lib/data/takeout-table';
import { analyzeRace } from '../lib/math/index';
import { winPayoutPer2 } from '../lib/math/payouts';
import type { Race } from '../lib/types';
import sampleSixHorse from '../fixtures/sample-6-horse.json';

const FALLBACK = { win: 0.16, place: 0.17, show: 0.17 };

const ANALYZE_OPTIONS = {
  takeoutWin: 0.16,
  takeoutPlace: 0.17,
  takeoutShow: 0.17,
  leanThreshold: 0.05,
  driftThreshold: 0.5,
  now: () => '2026-05-02T22:00:00.000Z',
};

const fixture = sampleSixHorse as unknown as Race;

describe('resolveTakeoutForTrack', () => {
  it('returns the table entry for a known track code', () => {
    const r = resolveTakeoutForTrack('BEL', FALLBACK);
    expect(r).toEqual({
      win: TRACK_TAKEOUT.BEL.win,
      place: TRACK_TAKEOUT.BEL.place,
      show: TRACK_TAKEOUT.BEL.show,
    });
  });

  it('falls back to the supplied defaults for an unknown track code', () => {
    const r = resolveTakeoutForTrack('TST', FALLBACK);
    expect(r).toEqual(FALLBACK);
  });

  it('falls back when trackCode is empty / null / undefined', () => {
    expect(resolveTakeoutForTrack('', FALLBACK)).toEqual(FALLBACK);
    expect(resolveTakeoutForTrack(null, FALLBACK)).toEqual(FALLBACK);
    expect(resolveTakeoutForTrack(undefined, FALLBACK)).toEqual(FALLBACK);
  });

  it('NYRA tracks all share the same W/P/S takeout', () => {
    const aqu = resolveTakeoutForTrack('AQU', FALLBACK);
    const bel = resolveTakeoutForTrack('BEL', FALLBACK);
    const sar = resolveTakeoutForTrack('SAR', FALLBACK);
    expect(aqu).toEqual(bel);
    expect(bel).toEqual(sar);
  });
});

describe('analyzeRace — per-track takeout integration', () => {
  it('uses the fallback takeout for the test fixture (trackCode "TST" — not in table)', () => {
    expect(fixture.trackCode).toBe('TST');
    const result = analyzeRace(fixture, ANALYZE_OPTIONS);
    const horse1 = result.rows[0];
    // Option-supplied takeoutWin = 0.16; unknown track = use options.
    const expected = winPayoutPer2(50000, fixture.totalWinPool!, 0.16);
    expect(horse1.winProjected).toBe(expected);
  });

  it('uses the table takeout for a known track (CD = Churchill Downs, 17.5%)', () => {
    const cdRace: Race = { ...fixture, trackCode: 'CD' };
    const result = analyzeRace(cdRace, ANALYZE_OPTIONS);
    const horse1 = result.rows[0];
    // CD's win takeout is 17.5%, NOT the option-supplied 16%.
    const expectedCd = winPayoutPer2(50000, fixture.totalWinPool!, 0.175);
    expect(horse1.winProjected).toBe(expectedCd);

    // And the result must differ from the fallback path (sanity).
    const fallbackResult = analyzeRace(fixture, ANALYZE_OPTIONS);
    expect(horse1.winProjected).not.toBe(fallbackResult.rows[0].winProjected);
  });

  it('uses the table takeout for California (CHRB rate 15.4% W/P/S)', () => {
    const saRace: Race = { ...fixture, trackCode: 'SA' };
    const result = analyzeRace(saRace, ANALYZE_OPTIONS);
    const horse1 = result.rows[0];
    const expected = winPayoutPer2(50000, fixture.totalWinPool!, 0.154);
    expect(horse1.winProjected).toBe(expected);
  });
});
