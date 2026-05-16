import { describe, expect, it } from 'vitest';
import { settleBetPlan } from '../lib/simulation/settle';
import type { Race, RaceResults } from '../lib/types';
import type { BetTicket, LockedBetPlan } from '../lib/simulation/types';

/**
 * Mirrors a real CD R5 finish (Yellow Card #7 won, Joe Shiesty #10 placed,
 * Litigation #9 showed) but with synthetic exotic payoffs to test the
 * settlement engine without actually wiring to real data.
 */
function fixtureRace(): Race {
  const results: RaceResults = {
    runners: [
      { finishPosition: 1, program: '7', name: 'Yellow Card', winPayoff: 7.8, placePayoff: 4.24, showPayoff: 3.02 },
      { finishPosition: 2, program: '10', name: 'Joe Shiesty', winPayoff: 0, placePayoff: 6.6, showPayoff: 4.1 },
      { finishPosition: 3, program: '9', name: 'Litigation', winPayoff: 0, placePayoff: 0, showPayoff: 2.76 },
      { finishPosition: 4, program: '3', name: 'My Boy Prince', winPayoff: 0, placePayoff: 0, showPayoff: 0 },
    ],
    winningTimeSeconds: 62.2,
    exoticPayoffs: [
      // Exacta 7-10 paid $42.50 per $2 (synthetic but realistic for short price → mid price)
      { wagerCode: 'EX', wagerAmount: 2, selection: '7-10', payoutAmount: 42.5 },
      // Trifecta 7-10-9 paid $84.30 per $0.50
      { wagerCode: 'TR', wagerAmount: 0.5, selection: '7-10-9', payoutAmount: 84.3 },
    ],
  };
  return {
    raceId: 'CD-5',
    trackCode: 'CD',
    raceNumber: 5,
    postTimeUtc: '2026-05-02T17:12:00Z',
    status: 'official',
    horses: [],
    lastUpdate: '2026-05-02T17:13:00Z',
    results,
  };
}

function makePlan(tickets: BetTicket[]): LockedBetPlan {
  return {
    raceId: 'CD-5',
    lockedAt: '2026-05-02T17:11:00Z',
    tickets,
    totalStake: tickets.reduce((a, t) => a + t.amount, 0),
    rationale: 'test plan',
  };
}

describe('settleBetPlan — Win/Place/Show', () => {
  const race = fixtureRace();

  it('cashes a win bet on the actual winner', () => {
    const settlement = settleBetPlan(makePlan([{ type: 'win', horses: ['7'], amount: 4 }]), race)!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(true);
    expect(t.payoutPerUnit).toBe(7.8);
    expect(t.returned).toBe((4 / 2) * 7.8); // $15.60
    expect(t.profit).toBeCloseTo(11.6, 6);
  });

  it('loses a win bet on a horse that did not win', () => {
    const settlement = settleBetPlan(makePlan([{ type: 'win', horses: ['10'], amount: 4 }]), race)!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(false);
    expect(t.returned).toBe(0);
    expect(t.profit).toBe(-4);
  });

  it('cashes a place bet on the runner-up', () => {
    const settlement = settleBetPlan(makePlan([{ type: 'place', horses: ['10'], amount: 4 }]), race)!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(true);
    expect(t.returned).toBe((4 / 2) * 6.6); // $13.20
  });

  it('cashes a place bet on the winner (winner gets place too)', () => {
    const settlement = settleBetPlan(makePlan([{ type: 'place', horses: ['7'], amount: 4 }]), race)!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(true);
    expect(t.returned).toBe((4 / 2) * 4.24);
  });

  it('cashes a show bet on the show finisher', () => {
    const settlement = settleBetPlan(makePlan([{ type: 'show', horses: ['9'], amount: 6 }]), race)!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(true);
    expect(t.returned).toBe((6 / 2) * 2.76); // $8.28
    expect(t.profit).toBeCloseTo(2.28, 6);
  });

  it('loses a show bet on a 4th-place horse', () => {
    const settlement = settleBetPlan(makePlan([{ type: 'show', horses: ['3'], amount: 6 }]), race)!;
    expect(settlement.tickets[0].cashed).toBe(false);
    expect(settlement.tickets[0].profit).toBe(-6);
  });
});

describe('settleBetPlan — exacta', () => {
  const race = fixtureRace();

  it('cashes an exacta straight on the exact finish', () => {
    const settlement = settleBetPlan(
      makePlan([{ type: 'exacta_straight', horses: ['7', '10'], amount: 4 }]),
      race,
    )!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(true);
    expect(t.returned).toBe((4 / 2) * 42.5); // $85
  });

  it('loses an exacta straight when order is reversed', () => {
    const settlement = settleBetPlan(
      makePlan([{ type: 'exacta_straight', horses: ['10', '7'], amount: 4 }]),
      race,
    )!;
    expect(settlement.tickets[0].cashed).toBe(false);
  });

  it('cashes an exacta box that covers either ordering', () => {
    // Box of 2 = 2 combos. $4 box → $2 per combo. Cashing combo pays $42.50/$2.
    // So returned = ($2/$2) * $42.50 = $42.50. Profit = $42.50 - $4 = $38.50.
    const settlement = settleBetPlan(
      makePlan([{ type: 'exacta_box', horses: ['7', '10'], amount: 4 }]),
      race,
    )!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(true);
    expect(t.returned).toBeCloseTo(42.5, 6);
    expect(t.profit).toBeCloseTo(38.5, 6);
  });

  it('cashes a 3-horse exacta box covering the top 2', () => {
    // Box of 3 = 6 combos. $12 box → $2 per combo. One combo cashes.
    const settlement = settleBetPlan(
      makePlan([{ type: 'exacta_box', horses: ['7', '10', '9'], amount: 12 }]),
      race,
    )!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(true);
    expect(t.returned).toBeCloseTo(42.5, 6);
    expect(t.profit).toBeCloseTo(30.5, 6);
  });

  it('loses an exacta box that misses the actual top 2', () => {
    const settlement = settleBetPlan(
      makePlan([{ type: 'exacta_box', horses: ['9', '3'], amount: 4 }]),
      race,
    )!;
    expect(settlement.tickets[0].cashed).toBe(false);
  });
});

describe('settleBetPlan — trifecta', () => {
  const race = fixtureRace();

  it('cashes a trifecta straight on the exact finish', () => {
    const settlement = settleBetPlan(
      makePlan([{ type: 'trifecta_straight', horses: ['7', '10', '9'], amount: 2 }]),
      race,
    )!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(true);
    // Trifecta unit is $0.50 → multiplier = 2/0.5 = 4 → $84.30 × 4 = $337.20
    expect(t.returned).toBeCloseTo(4 * 84.3, 6);
    expect(t.profit).toBeCloseTo(4 * 84.3 - 2, 6);
  });

  it('cashes a 3-horse trifecta box', () => {
    // Box of 3 = 6 combos. $3 box → $0.50 per combo. Matches wager unit.
    const settlement = settleBetPlan(
      makePlan([{ type: 'trifecta_box', horses: ['7', '10', '9'], amount: 3 }]),
      race,
    )!;
    const t = settlement.tickets[0];
    expect(t.cashed).toBe(true);
    // Per-combo $0.50 / wager unit $0.50 = 1 unit → returned = $84.30
    expect(t.returned).toBeCloseTo(84.3, 6);
  });

  it('loses a trifecta box missing one of the top 3', () => {
    const settlement = settleBetPlan(
      makePlan([{ type: 'trifecta_box', horses: ['7', '10', '3'], amount: 3 }]),
      race,
    )!;
    expect(settlement.tickets[0].cashed).toBe(false);
  });
});

describe('settleBetPlan — totals', () => {
  const race = fixtureRace();

  it('aggregates stake / return / profit across the whole plan', () => {
    const plan = makePlan([
      { type: 'place', horses: ['7'], amount: 4 }, // cashes $4/$2 × $4.24 = $8.48
      { type: 'show', horses: ['10'], amount: 4 }, // cashes $4/$2 × $4.10 = $8.20
      { type: 'win', horses: ['10'], amount: 4 }, // loses
      { type: 'exacta_box', horses: ['7', '10'], amount: 4 }, // cashes $42.50
      { type: 'trifecta_box', horses: ['7', '10', '3'], amount: 4 }, // loses
    ]);
    const settlement = settleBetPlan(plan, race)!;
    expect(settlement.totalStake).toBe(20);
    const expectedReturn = 8.48 + 8.2 + 0 + 42.5 + 0;
    expect(settlement.totalReturn).toBeCloseTo(expectedReturn, 6);
    expect(settlement.totalProfit).toBeCloseTo(expectedReturn - 20, 6);
  });

  it('returns null when the race has no official results yet', () => {
    const noResults: Race = { ...race, results: null };
    expect(settleBetPlan(makePlan([{ type: 'win', horses: ['7'], amount: 4 }]), noResults)).toBeNull();
  });
});

describe('settleBetPlan — void races', () => {
  /**
   * Voids fire when the race's `results` object comes back but no runner has
   * a usable finishPosition: canceled, postponed, weather, all-runners-MTO,
   * etc. The settler must NOT silently emit a -100% ROI settlement. Real
   * pari-mutuel handling is refund-in-full, so totalReturn === totalStake
   * and totalProfit === 0.
   */
  function emptyResults(): Race {
    return {
      raceId: 'CD-99',
      trackCode: 'CD',
      raceNumber: 99,
      postTimeUtc: '2026-05-02T17:12:00Z',
      status: 'official',
      horses: [],
      lastUpdate: '2026-05-02T17:13:00Z',
      results: {
        runners: [],
        winningTimeSeconds: null,
        exoticPayoffs: [],
      },
    };
  }
  function resultsWithNoFinishPositions(): Race {
    return {
      raceId: 'CD-99',
      trackCode: 'CD',
      raceNumber: 99,
      postTimeUtc: '2026-05-02T17:12:00Z',
      status: 'official',
      horses: [],
      lastUpdate: '2026-05-02T17:13:00Z',
      results: {
        // Runner records present but every finishPosition is 0/undefined —
        // shape FDR sometimes returns for canceled cards before scrubbing
        // the runner list entirely.
        runners: [
          { finishPosition: 0, program: '1', name: 'A', winPayoff: 0, placePayoff: 0, showPayoff: 0 },
          { finishPosition: 0, program: '2', name: 'B', winPayoff: 0, placePayoff: 0, showPayoff: 0 },
        ],
        winningTimeSeconds: null,
        exoticPayoffs: [],
      },
    };
  }

  it('returns a void settlement when results.runners is empty (not cashed=NO loss)', () => {
    const plan = makePlan([
      { type: 'place', horses: ['7'], amount: 4 },
      { type: 'show', horses: ['10'], amount: 4 },
      { type: 'exacta_box', horses: ['7', '10'], amount: 4 },
    ]);
    const settlement = settleBetPlan(plan, emptyResults())!;
    expect(settlement).not.toBeNull();
    expect(settlement.state).toBe('void');
    expect(settlement.totalStake).toBe(12);
    expect(settlement.totalReturn).toBe(12); // full refund
    expect(settlement.totalProfit).toBe(0);
    for (const t of settlement.tickets) {
      expect(t.cashed).toBe(false);
      expect(t.returned).toBe(t.amount);
      expect(t.profit).toBe(0);
      expect(t.note).toMatch(/void/i);
    }
  });

  it('returns a void settlement when runners exist but none have finishPosition', () => {
    const plan = makePlan([{ type: 'win', horses: ['7'], amount: 6 }]);
    const settlement = settleBetPlan(plan, resultsWithNoFinishPositions())!;
    expect(settlement.state).toBe('void');
    expect(settlement.totalReturn).toBe(6);
    expect(settlement.totalProfit).toBe(0);
    expect(settlement.tickets[0].profit).toBe(0);
  });

  it('marks a normally-settled race with state="settled"', () => {
    const settlement = settleBetPlan(
      makePlan([{ type: 'win', horses: ['7'], amount: 4 }]),
      fixtureRace(),
    )!;
    expect(settlement.state).toBe('settled');
  });
});
