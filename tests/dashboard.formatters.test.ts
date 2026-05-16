import { describe, expect, it } from 'vitest';
import {
  formatDecimalOdds,
  formatMtp,
  formatPayout,
  formatPercent,
  formatProb,
  nextRaceIdIfDue,
  pickDefaultRaceId,
  secondsToPostTime,
} from '../app/_components/formatters';

describe('formatDecimalOdds', () => {
  it('shows two decimals for short prices (< 2.0)', () => {
    expect(formatDecimalOdds(1.5)).toBe('1.50');
    expect(formatDecimalOdds(1.95)).toBe('1.95');
  });

  it('shows one decimal for mid prices (2-9.9)', () => {
    expect(formatDecimalOdds(2.5)).toBe('2.5');
    expect(formatDecimalOdds(9.9)).toBe('9.9');
  });

  it('shows whole numbers for long prices (≥ 10)', () => {
    expect(formatDecimalOdds(11)).toBe('11');
    expect(formatDecimalOdds(26)).toBe('26');
    expect(formatDecimalOdds(80.4)).toBe('80');
  });

  it('returns em-dash for null / non-finite', () => {
    expect(formatDecimalOdds(null)).toBe('—');
    expect(formatDecimalOdds(NaN)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('signs positive values explicitly', () => {
    expect(formatPercent(0.05)).toBe('+5.0%');
    expect(formatPercent(0.4)).toBe('+40.0%');
  });

  it('shows negative without explicit sign (already there)', () => {
    expect(formatPercent(-0.1)).toBe('-10.0%');
  });

  it('zero is just 0.0% (no plus sign)', () => {
    expect(formatPercent(0)).toBe('0.0%');
  });

  it('honors digits override', () => {
    expect(formatPercent(0.123, 0)).toBe('+12%');
    expect(formatPercent(0.123, 2)).toBe('+12.30%');
  });

  it('returns em-dash for null', () => {
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatPayout', () => {
  it('always two decimals', () => {
    expect(formatPayout(2.1)).toBe('2.10');
    expect(formatPayout(10)).toBe('10.00');
    expect(formatPayout(3.456)).toBe('3.46');
  });
  it('null → em-dash', () => {
    expect(formatPayout(null)).toBe('—');
  });
});

describe('formatProb', () => {
  it('three decimals', () => {
    expect(formatProb(0.5)).toBe('0.500');
    expect(formatProb(0.123456)).toBe('0.123');
  });
});

describe('formatMtp', () => {
  it('formats positive seconds as M:SS', () => {
    expect(formatMtp(0)).toBe('0:00');
    expect(formatMtp(5)).toBe('0:05');
    expect(formatMtp(125)).toBe('2:05');
    expect(formatMtp(3600)).toBe('60:00');
  });

  it('marks past-post negative values', () => {
    expect(formatMtp(-30)).toBe('+0:30 past');
    expect(formatMtp(-125)).toBe('+2:05 past');
  });

  it('null → em-dash', () => {
    expect(formatMtp(null)).toBe('—');
  });
});

describe('secondsToPostTime', () => {
  it('positive when post is in the future', () => {
    const post = '2026-05-02T22:00:00Z';
    const now = Date.parse('2026-05-02T21:55:00Z');
    expect(secondsToPostTime(post, now)).toBe(300);
  });

  it('negative when post is in the past', () => {
    const post = '2026-05-02T22:00:00Z';
    const now = Date.parse('2026-05-02T22:01:00Z');
    expect(secondsToPostTime(post, now)).toBe(-60);
  });
});

interface TestRace {
  race: { raceId: string; status: string; postTimeUtc: string };
}

function r(raceId: string, status: string, postTimeUtc: string): TestRace {
  return { race: { raceId, status, postTimeUtc } };
}

describe('pickDefaultRaceId', () => {
  it('picks the closest-to-post OPEN race', () => {
    const races = [
      r('CD-1', 'official', '2026-05-02T17:00:00Z'),
      r('CD-7', 'open', '2026-05-02T19:00:00Z'),
      r('CD-8', 'open', '2026-05-02T18:30:00Z'),
      r('CD-9', 'open', '2026-05-02T19:30:00Z'),
    ];
    expect(pickDefaultRaceId(races)).toBe('CD-8');
  });

  it('falls back to MOST RECENT official when no open races', () => {
    const races = [
      r('CD-1', 'official', '2026-05-02T17:00:00Z'),
      r('CD-2', 'official', '2026-05-02T18:00:00Z'),
      r('CD-3', 'closed', '2026-05-02T19:00:00Z'),
    ];
    expect(pickDefaultRaceId(races)).toBe('CD-2');
  });

  it('falls back to first race when no open or official', () => {
    const races = [r('CD-3', 'closed', '2026-05-02T19:00:00Z')];
    expect(pickDefaultRaceId(races)).toBe('CD-3');
  });

  it('returns null for empty list', () => {
    expect(pickDefaultRaceId([])).toBeNull();
  });
});

describe('nextRaceIdIfDue', () => {
  it('keeps the current race when it is still open', () => {
    const races = [
      r('CD-7', 'open', '2026-05-02T19:00:00Z'),
      r('CD-8', 'open', '2026-05-02T19:30:00Z'),
    ];
    const now = Date.parse('2026-05-02T18:55:00Z');
    expect(nextRaceIdIfDue(races, 'CD-7', now)).toBe('CD-7');
  });

  it('advances when current race goes official AND another open race is within window', () => {
    const races = [
      r('CD-7', 'official', '2026-05-02T19:00:00Z'),
      r('CD-8', 'open', '2026-05-02T19:30:00Z'),
    ];
    const now = Date.parse('2026-05-02T19:25:00Z');
    expect(nextRaceIdIfDue(races, 'CD-7', now)).toBe('CD-8');
  });

  it('does NOT advance when no open race is within the window', () => {
    const races = [
      r('CD-7', 'official', '2026-05-02T19:00:00Z'),
      r('CD-8', 'open', '2026-05-02T20:30:00Z'), // > 600s away
    ];
    const now = Date.parse('2026-05-02T19:25:00Z');
    expect(nextRaceIdIfDue(races, 'CD-7', now)).toBe('CD-7');
  });

  it('falls back to default pick when current race is no longer in the list', () => {
    const races = [
      r('CD-9', 'open', '2026-05-02T20:00:00Z'),
    ];
    const now = Date.parse('2026-05-02T19:55:00Z');
    expect(nextRaceIdIfDue(races, 'CD-7', now)).toBe('CD-9');
  });

  it('null when there are no races', () => {
    expect(nextRaceIdIfDue([], 'CD-7', Date.now())).toBeNull();
  });
});
