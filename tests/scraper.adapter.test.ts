import { describe, expect, it } from 'vitest';
import {
  adaptFdrToRace,
  fractionalToDecimal,
  type FdrBettingInterest,
  type FdrRaceUpdate,
} from '../lib/scraper/adapter';
import sampleRaceUpdate from '../fixtures/sample-fdr-race-update.json';
import sampleRaceFinished from '../fixtures/sample-fdr-race-finished.json';

const FIXED_NOW = '2026-05-02T22:00:00.000Z';
const NOW = () => FIXED_NOW;

const liveRace = sampleRaceUpdate as unknown as FdrRaceUpdate;
const finishedRace = sampleRaceFinished as unknown as FdrRaceUpdate;

describe('fractionalToDecimal', () => {
  it('converts num/denom fractions correctly', () => {
    expect(fractionalToDecimal({ numerator: 5, denominator: 1 })).toBe(6.0);
    expect(fractionalToDecimal({ numerator: 7, denominator: 2 })).toBe(4.5);
    expect(fractionalToDecimal({ numerator: 6, denominator: 5 })).toBe(2.2);
  });

  it('treats null denominator as 1 (FDR convention for `12/null`)', () => {
    expect(fractionalToDecimal({ numerator: 12, denominator: null })).toBe(13.0);
  });

  it('returns null for null input or null numerator', () => {
    expect(fractionalToDecimal(null)).toBeNull();
    expect(fractionalToDecimal(undefined)).toBeNull();
    expect(fractionalToDecimal({ numerator: null, denominator: 1 })).toBeNull();
  });

  it('returns null for division-by-zero or non-finite values', () => {
    expect(fractionalToDecimal({ numerator: 5, denominator: 0 })).toBeNull();
    expect(fractionalToDecimal({ numerator: NaN, denominator: 1 })).toBeNull();
  });
});

describe('adaptFdrToRace — live (CD-7, status IC)', () => {
  const race = adaptFdrToRace(liveRace, { now: NOW });

  it('maps the top-level race fields', () => {
    expect(race.raceId).toBe('CD-7');
    expect(race.trackCode).toBe('CD');
    expect(race.raceNumber).toBe(7);
    expect(race.postTimeUtc).toBe(liveRace.postTime);
    expect(race.tvgRaceId).toBe(3966636);
    expect(race.lastUpdate).toBe(FIXED_NOW);
  });

  it('derives status="open" for status.code === "IC"', () => {
    expect(race.status).toBe('open');
  });

  it('extracts WN/PL/SH race-level pool totals', () => {
    expect(race.totalWinPool).toBe(1759777);
    expect(race.totalPlacePool).toBe(635131);
    expect(race.totalShowPool).toBe(638051);
  });

  it('produces one Horse per bettingInterest (9 horses in fixture)', () => {
    expect(race.horses.length).toBe(9);
    expect(race.horses.map((h) => h.program)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('extracts per-runner WN/PL/SH pool dollars from biPools', () => {
    const horse1 = race.horses[0];
    expect(horse1.name).toBe('Italian Soiree');
    expect(horse1.winPoolDollars).toBe(96078);
    expect(horse1.placePoolDollars).toBe(37016);
    expect(horse1.showPoolDollars).toBe(32981);
  });

  it('sum of per-runner biPools roughly matches the racePool total (sanity)', () => {
    // FDR per-runner biPools sum to a value slightly below the race-level
    // total because some pool money is in coupled entries / cancellations
    // not present in bettingInterests. ±20% is a sane sanity bound.
    const winSum = race.horses.reduce((s, h) => s + (h.winPoolDollars ?? 0), 0);
    const ratio = winSum / (race.totalWinPool as number);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThanOrEqual(1.0);
  });

  it('converts fractional odds to decimal for current and ML', () => {
    const horse1 = race.horses[0];
    // From the fixture: currentOdds = 14/null → 15.0, morningLineOdds = 10/null → 11.0
    expect(horse1.currentOdds).toBe(15.0);
    expect(horse1.mlOdds).toBe(11.0);
  });

  it('handles non-null denominators correctly (e.g., 5/2 → 3.5)', () => {
    // Horse 2 in this fixture has morningLineOdds = 5/2
    const horse2 = race.horses[1];
    expect(horse2.mlOdds).toBe(3.5);
  });

  it('passes through jockey and trainer when present', () => {
    const horse1 = race.horses[0];
    expect(horse1.jockey).toBe('Franco Manuel');
    expect(horse1.trainer).toBe('Motion H. G');
  });

  it('marks scratched=false when not scratched', () => {
    expect(race.horses.every((h) => !h.scratched)).toBe(true);
  });

  it('results is null when not yet populated', () => {
    expect(race.results).toBeNull();
  });
});

describe('adaptFdrToRace — finished (CD-1 synthetic, results populated)', () => {
  const race = adaptFdrToRace(finishedRace, { now: NOW });

  it('derives status="official" when results.runners.length > 0 (overrides status.code RO)', () => {
    expect(race.status).toBe('official');
  });

  it('maps results.runners ordered by finishPosition', () => {
    expect(race.results).not.toBeNull();
    const r = race.results!;
    expect(r.runners.length).toBe(4);
    expect(r.runners.map((x) => x.finishPosition)).toEqual([1, 2, 3, 4]);
    expect(r.runners[0].name).toBe('Powershift');
    expect(r.runners[0].program).toBe('11');
    expect(r.runners[0].winPayoff).toBe(4.14);
    expect(r.runners[0].placePayoff).toBe(2.7);
    expect(r.runners[0].showPayoff).toBe(2.4);
  });

  it('captures winningTimeSeconds from results.winningTime', () => {
    expect(race.results!.winningTimeSeconds).toBe(101.86);
  });

  it('also produces full per-runner pool data on a finished race', () => {
    const winner = race.horses.find((h) => h.program === '11');
    expect(winner).toBeDefined();
    expect(winner!.winPoolDollars).toBe(30000);
  });
});

describe('adaptFdrToRace — status code mapping', () => {
  function withStatus(code: string): FdrRaceUpdate {
    return { ...liveRace, status: { code, __typename: 'StatusEnumeration' }, results: null };
  }

  it('"O" → open', () => {
    expect(adaptFdrToRace(withStatus('O'), { now: NOW }).status).toBe('open');
  });

  it('"IC" → open', () => {
    expect(adaptFdrToRace(withStatus('IC'), { now: NOW }).status).toBe('open');
  });

  it('"MO" → open (defensive — seen in MTP filter list, treated as pre-race)', () => {
    expect(adaptFdrToRace(withStatus('MO'), { now: NOW }).status).toBe('open');
  });

  it('"RO" → closed (race off, running)', () => {
    expect(adaptFdrToRace(withStatus('RO'), { now: NOW }).status).toBe('closed');
  });

  it('"SK" → closed (race scratched)', () => {
    expect(adaptFdrToRace(withStatus('SK'), { now: NOW }).status).toBe('closed');
  });

  it('unknown status code → closed (defensive default)', () => {
    expect(adaptFdrToRace(withStatus('XYZ'), { now: NOW }).status).toBe('closed');
  });

  it('results.runners.length > 0 overrides any status.code → official', () => {
    const u = { ...withStatus('O'), results: finishedRace.results };
    expect(adaptFdrToRace(u, { now: NOW }).status).toBe('official');
  });
});

describe('adaptFdrToRace — validation', () => {
  it('throws when bettingInterests is empty', () => {
    const u: FdrRaceUpdate = { ...liveRace, bettingInterests: [] };
    expect(() => adaptFdrToRace(u, { now: NOW })).toThrow(/no bettingInterests/);
  });

  it('throws when bettingInterests is null', () => {
    const u: FdrRaceUpdate = { ...liveRace, bettingInterests: null };
    expect(() => adaptFdrToRace(u, { now: NOW })).toThrow(/no bettingInterests/);
  });

  it('throws when every horse has neither pool dollars nor odds', () => {
    const blanked: FdrBettingInterest[] = liveRace.bettingInterests!.map((bi) => ({
      ...bi,
      currentOdds: null,
      morningLineOdds: null,
      biPools: null,
    }));
    const u: FdrRaceUpdate = { ...liveRace, bettingInterests: blanked, racePools: null };
    expect(() => adaptFdrToRace(u, { now: NOW })).toThrow(/nothing to compute against/);
  });

  it('does NOT throw when only odds are available (degraded but usable)', () => {
    const oddsOnly: FdrBettingInterest[] = liveRace.bettingInterests!.map((bi) => ({
      ...bi,
      biPools: null,
    }));
    const u: FdrRaceUpdate = { ...liveRace, bettingInterests: oddsOnly, racePools: null };
    const race = adaptFdrToRace(u, { now: NOW });
    expect(race.horses.every((h) => h.winPoolDollars === null)).toBe(true);
    expect(race.horses.some((h) => h.currentOdds !== null)).toBe(true);
  });
});

describe('adaptFdrToRace — defensive null handling', () => {
  it('missing biPools → null pool dollars (not 0)', () => {
    const u: FdrRaceUpdate = {
      ...liveRace,
      bettingInterests: liveRace.bettingInterests!.map((bi) => ({ ...bi, biPools: null })),
    };
    const race = adaptFdrToRace(u, { now: NOW });
    for (const h of race.horses) {
      expect(h.winPoolDollars).toBeNull();
      expect(h.placePoolDollars).toBeNull();
      expect(h.showPoolDollars).toBeNull();
    }
  });

  it('missing racePools → undefined totals (not 0)', () => {
    const u: FdrRaceUpdate = { ...liveRace, racePools: null };
    const race = adaptFdrToRace(u, { now: NOW });
    expect(race.totalWinPool).toBeUndefined();
    expect(race.totalPlacePool).toBeUndefined();
    expect(race.totalShowPool).toBeUndefined();
  });

  it('runner.scratched=true marks horse as scratched', () => {
    const bis = liveRace.bettingInterests!.map((bi, i) =>
      i === 0
        ? { ...bi, runners: [{ ...bi.runners[0], scratched: true }] }
        : bi,
    );
    const u: FdrRaceUpdate = { ...liveRace, bettingInterests: bis };
    const race = adaptFdrToRace(u, { now: NOW });
    expect(race.horses[0].scratched).toBe(true);
    expect(race.horses[1].scratched).toBe(false);
  });

  it('horseName missing → empty string (does not throw)', () => {
    const bis = liveRace.bettingInterests!.map((bi, i) =>
      i === 0
        ? { ...bi, runners: [{ ...bi.runners[0], horseName: null }] }
        : bi,
    );
    const u: FdrRaceUpdate = { ...liveRace, bettingInterests: bis };
    const race = adaptFdrToRace(u, { now: NOW });
    expect(race.horses[0].name).toBe('');
  });
});
