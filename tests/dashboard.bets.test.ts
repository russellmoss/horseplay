import { describe, expect, it } from 'vitest';
import { resolveBet, summarizePnl, type PlacedBet } from '../app/_components/bets';
import type { Race, RaceResults } from '../lib/types';

const NOW = () => '2026-05-02T22:30:00.000Z';

function bet(
  overrides: Partial<PlacedBet> = {},
): PlacedBet {
  return {
    id: 'b1',
    raceId: 'CD-1',
    trackCode: 'CD',
    raceNumber: 1,
    program: '11',
    horseName: 'Powershift',
    betType: 'place',
    amount: 4,
    placedAt: '2026-05-02T17:00:00.000Z',
    ...overrides,
  };
}

const POWERSHIFT_RESULTS: RaceResults = {
  runners: [
    { finishPosition: 1, program: '11', name: 'Powershift', winPayoff: 4.14, placePayoff: 2.7, showPayoff: 2.4 },
    { finishPosition: 2, program: '3', name: 'Silent Way', winPayoff: 0, placePayoff: 3.06, showPayoff: 2.64 },
    { finishPosition: 3, program: '4', name: 'Ingleborough', winPayoff: 0, placePayoff: 0, showPayoff: 9.7 },
    { finishPosition: 4, program: '1', name: 'Stakeholder', winPayoff: 0, placePayoff: 0, showPayoff: 0 },
  ],
  winningTimeSeconds: 101.86,
};

function race(status: Race['status'], results: RaceResults | null): Race {
  return {
    raceId: 'CD-1',
    trackCode: 'CD',
    raceNumber: 1,
    postTimeUtc: '2026-05-02T17:00:00Z',
    status,
    horses: [],
    lastUpdate: '2026-05-02T17:05:00Z',
    results,
  };
}

describe('resolveBet — official race outcomes', () => {
  const officialRace = race('official', POWERSHIFT_RESULTS);

  it('WIN bet on the winner pays per $2 unit', () => {
    const result = resolveBet(bet({ betType: 'win', program: '11', amount: 4 }), officialRace, NOW);
    expect(result).not.toBeNull();
    expect(result!.won).toBe(true);
    expect(result!.payoffPer2).toBe(4.14);
    // 4/2 units × $4.14 = $8.28
    expect(result!.payout).toBeCloseTo(8.28, 2);
    expect(result!.profit).toBeCloseTo(4.28, 2);
  });

  it('PLACE bet on the winner pays the place payoff', () => {
    const result = resolveBet(bet({ betType: 'place', program: '11', amount: 4 }), officialRace, NOW);
    expect(result!.won).toBe(true);
    expect(result!.payoffPer2).toBe(2.7);
    expect(result!.payout).toBeCloseTo(5.4, 2);
    expect(result!.profit).toBeCloseTo(1.4, 2);
  });

  it('PLACE bet on the runner-up also wins', () => {
    const result = resolveBet(bet({ betType: 'place', program: '3', amount: 4 }), officialRace, NOW);
    expect(result!.won).toBe(true);
    expect(result!.payoffPer2).toBe(3.06);
    expect(result!.payout).toBeCloseTo(6.12, 2);
  });

  it('PLACE bet on 3rd-place finisher LOSES (placePayoff = 0)', () => {
    const result = resolveBet(bet({ betType: 'place', program: '4', amount: 4 }), officialRace, NOW);
    expect(result!.won).toBe(false);
    expect(result!.payout).toBe(0);
    expect(result!.profit).toBe(-4);
  });

  it('SHOW bet on 3rd pays the show payoff', () => {
    const result = resolveBet(bet({ betType: 'show', program: '4', amount: 6 }), officialRace, NOW);
    expect(result!.won).toBe(true);
    expect(result!.payoffPer2).toBe(9.7);
    expect(result!.payout).toBeCloseTo(29.1, 2);
    expect(result!.profit).toBeCloseTo(23.1, 2);
  });

  it('SHOW bet on 4th-place horse LOSES', () => {
    const result = resolveBet(bet({ betType: 'show', program: '1', amount: 4 }), officialRace, NOW);
    expect(result!.won).toBe(false);
    expect(result!.payout).toBe(0);
    expect(result!.profit).toBe(-4);
  });

  it('horse not in results array → loses with no payout', () => {
    const result = resolveBet(bet({ program: '99', betType: 'place', amount: 4 }), officialRace, NOW);
    expect(result!.won).toBe(false);
    expect(result!.profit).toBe(-4);
  });

  it('different bet sizes scale linearly', () => {
    // $10 place on winner (Powershift): 10/2 = 5 units × $2.70 = $13.50
    const result = resolveBet(
      bet({ betType: 'place', program: '11', amount: 10 }),
      officialRace,
      NOW,
    );
    expect(result!.payout).toBeCloseTo(13.5, 2);
    expect(result!.profit).toBeCloseTo(3.5, 2);
  });

  it('odd dollar amounts scale per $2 unit (e.g. $5 = 2.5 units)', () => {
    // $5 place on Powershift: 2.5 units × $2.70 = $6.75
    const result = resolveBet(
      bet({ betType: 'place', program: '11', amount: 5 }),
      officialRace,
      NOW,
    );
    expect(result!.payout).toBeCloseTo(6.75, 2);
    expect(result!.profit).toBeCloseTo(1.75, 2);
  });

  it('records resolvedAt timestamp from the clock', () => {
    const result = resolveBet(bet({ program: '11' }), officialRace, NOW);
    expect(result!.resolvedAt).toBe('2026-05-02T22:30:00.000Z');
  });
});

describe('resolveBet — non-resolvable states', () => {
  it('returns null when race is open', () => {
    expect(resolveBet(bet(), race('open', null), NOW)).toBeNull();
  });

  it('returns null when race is closed (running) but not yet official', () => {
    expect(resolveBet(bet(), race('closed', null), NOW)).toBeNull();
  });

  it('returns null when race is official but results array is empty', () => {
    expect(
      resolveBet(bet(), race('official', { runners: [], winningTimeSeconds: null }), NOW),
    ).toBeNull();
  });

  it('returns null when race.results is null', () => {
    expect(resolveBet(bet(), race('official', null), NOW)).toBeNull();
  });
});

describe('summarizePnl', () => {
  it('aggregates staked / returned / profit across resolved + pending bets', () => {
    const bets: PlacedBet[] = [
      // pending — counted in stake but not in returned
      bet({ id: 'p1', amount: 5 }),
      // won bet — paid $13.50 on $10
      {
        ...bet({ id: 'w1', betType: 'place', program: '11', amount: 10 }),
        resolved: {
          won: true,
          payoffPer2: 2.7,
          payout: 13.5,
          profit: 3.5,
          resolvedAt: NOW(),
        },
      },
      // lost $6
      {
        ...bet({ id: 'l1', betType: 'show', program: '1', amount: 6 }),
        resolved: {
          won: false,
          payoffPer2: 0,
          payout: 0,
          profit: -6,
          resolvedAt: NOW(),
        },
      },
    ];
    const pnl = summarizePnl(bets);
    expect(pnl.staked).toBe(21);
    expect(pnl.returned).toBeCloseTo(13.5, 2);
    expect(pnl.profit).toBeCloseTo(-7.5, 2);
    expect(pnl.pendingCount).toBe(1);
    expect(pnl.wonCount).toBe(1);
    expect(pnl.lostCount).toBe(1);
  });

  it('zero bets → all zeros', () => {
    const pnl = summarizePnl([]);
    expect(pnl.staked).toBe(0);
    expect(pnl.returned).toBe(0);
    expect(pnl.profit).toBe(0);
    expect(pnl.pendingCount).toBe(0);
    expect(pnl.wonCount).toBe(0);
    expect(pnl.lostCount).toBe(0);
  });
});
