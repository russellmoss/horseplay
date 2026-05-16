import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildRaceDayWorkbook } from '../lib/export/race-day-xlsx';
import { analyzeRace } from '../lib/math/index';
import type { LockedRecommendation } from '../lib/store';
import type {
  BetSettlement,
  LockedBetPlan,
  SettledTicket,
} from '../lib/simulation/types';
import type { Race, RaceAnalysis } from '../lib/types';
import sampleSixHorse from '../fixtures/sample-6-horse.json';

const ANALYZE_OPTIONS = {
  takeoutPlace: 0.17,
  takeoutShow: 0.17,
  leanThreshold: 0.05,
  driftThreshold: 0.5,
  now: () => '2026-05-02T22:00:00.000Z',
};

function makeAnalysis(overrides: Partial<Race> = {}): RaceAnalysis {
  const fixture = sampleSixHorse as unknown as Race;
  const race: Race = { ...fixture, ...overrides };
  return analyzeRace(race, ANALYZE_OPTIONS);
}

function makePlan(
  raceId: string,
  model: 'harville' | 'henery',
  rationale: string,
): LockedBetPlan {
  return {
    raceId,
    lockedAt: '2026-05-02T21:59:00Z',
    rationale,
    model,
    tickets: [
      {
        type: 'place',
        horses: ['1'],
        amount: 10,
        reason: `${model} liked #1's place edge`,
      },
      {
        type: 'show',
        horses: ['2'],
        amount: 10,
        reason: `${model} liked #2's show edge`,
      },
    ],
    totalStake: 20,
  };
}

function makeSettlement(
  raceId: string,
  plan: LockedBetPlan,
  cashedTicketIdx: number[] = [],
): BetSettlement {
  const tickets: SettledTicket[] = plan.tickets.map((t, i) => {
    const cashed = cashedTicketIdx.includes(i);
    return {
      ...t,
      cashed,
      payoutPerUnit: cashed ? 6.0 : 0,
      wagerUnit: 2,
      returned: cashed ? (t.amount / 2) * 6.0 : 0,
      profit: cashed ? (t.amount / 2) * 6.0 - t.amount : -t.amount,
    };
  });
  const totalStake = plan.totalStake;
  const totalReturn = tickets.reduce((a, t) => a + t.returned, 0);
  return {
    raceId,
    settledAt: '2026-05-02T22:05:00Z',
    tickets,
    totalStake,
    totalReturn,
    totalProfit: totalReturn - totalStake,
  };
}

describe('buildRaceDayWorkbook — model comparison', () => {
  it('builds a workbook with the Day Summary tab and per-race tabs for races with plans', async () => {
    const r1 = makeAnalysis({ raceId: 'TST-1', raceNumber: 1 });
    const harvPlan = makePlan('TST-1', 'harville', 'Harville rationale');
    const henPlan = makePlan('TST-1', 'henery', 'Henery rationale');
    const harvSettle = makeSettlement('TST-1', harvPlan, [0]); // place wins
    const henSettle = makeSettlement('TST-1', henPlan, [0, 1]); // both win

    const lockedRec: LockedRecommendation = {
      raceId: 'TST-1',
      lockedAt: '2026-05-02T21:59:00Z',
      betPlan: harvPlan, // legacy alias
      settlement: harvSettle,
      betPlanByModel: { harville: harvPlan, henery: henPlan },
      settlementByModel: { harville: harvSettle, henery: henSettle },
    };

    const buf = await buildRaceDayWorkbook({
      trackCode: 'TST',
      postDate: '2026-05-02',
      races: [{ analysis: r1, lockedRec }],
    });
    expect(buf.byteLength).toBeGreaterThan(1000);

    // Read it back to confirm sheets exist.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const summarySheet = wb.getWorksheet('Day Summary');
    expect(summarySheet).toBeDefined();
    const raceSheet = wb.getWorksheet('TST R1');
    expect(raceSheet).toBeDefined();

    // Confirm the comparison strip is present in the summary.
    const summaryText = JSON.stringify(summarySheet!.getSheetValues());
    expect(summaryText).toMatch(/MODEL COMPARISON/);
    expect(summaryText).toMatch(/Harville/);
    expect(summaryText).toMatch(/Henery/);
    // Henery cashed both tickets (profit=$40), Harville cashed one ($10).
    // So winner should be Henery.
    expect(summaryText).toMatch(/HENERY/);

    // Confirm both plan blocks rendered on the per-race sheet.
    const raceText = JSON.stringify(raceSheet!.getSheetValues());
    expect(raceText).toMatch(/HARVILLE — Plan & Settlement/);
    expect(raceText).toMatch(/HENERY — Plan & Settlement/);
  });

  it('handles legacy lockedRec (no betPlanByModel) by treating betPlan as Harville', async () => {
    const r1 = makeAnalysis({ raceId: 'TST-1', raceNumber: 1 });
    const harvPlan = makePlan('TST-1', 'harville', 'Legacy plan');
    const harvSettle = makeSettlement('TST-1', harvPlan, [0]);

    const legacyRec: LockedRecommendation = {
      raceId: 'TST-1',
      lockedAt: '2026-05-02T21:59:00Z',
      betPlan: harvPlan,
      settlement: harvSettle,
      // No betPlanByModel / settlementByModel fields — pre-feature data.
    };

    const buf = await buildRaceDayWorkbook({
      trackCode: 'TST',
      postDate: '2026-05-02',
      races: [{ analysis: r1, lockedRec: legacyRec }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const summarySheet = wb.getWorksheet('Day Summary');
    expect(summarySheet).toBeDefined();
    const raceSheet = wb.getWorksheet('TST R1');
    expect(raceSheet).toBeDefined();

    // The Harville block should render; Henery block should be absent.
    const raceText = JSON.stringify(raceSheet!.getSheetValues());
    expect(raceText).toMatch(/HARVILLE — Plan & Settlement/);
    expect(raceText).not.toMatch(/HENERY — Plan & Settlement/);
  });

  it('multi-race day: cumulative P&L per model accumulates row-by-row', async () => {
    // Race 1: Harville wins +$10, Henery loses -$20
    // Race 2: Harville loses -$20, Henery wins +$40
    // Day total: Harville = -$10, Henery = +$20 → Henery wins
    const r1 = makeAnalysis({ raceId: 'TST-1', raceNumber: 1 });
    const r2 = makeAnalysis({ raceId: 'TST-2', raceNumber: 2 });

    const r1Harv = makePlan('TST-1', 'harville', 'r1 harv');
    const r1Hen = makePlan('TST-1', 'henery', 'r1 hen');
    const r1HarvSettle = makeSettlement('TST-1', r1Harv, [0]); // +$10
    const r1HenSettle = makeSettlement('TST-1', r1Hen, []); // -$20

    const r2Harv = makePlan('TST-2', 'harville', 'r2 harv');
    const r2Hen = makePlan('TST-2', 'henery', 'r2 hen');
    const r2HarvSettle = makeSettlement('TST-2', r2Harv, []); // -$20
    const r2HenSettle = makeSettlement('TST-2', r2Hen, [0, 1]); // +$40

    const buf = await buildRaceDayWorkbook({
      trackCode: 'TST',
      postDate: '2026-05-02',
      races: [
        {
          analysis: r1,
          lockedRec: {
            raceId: 'TST-1',
            lockedAt: '2026-05-02T21:59:00Z',
            betPlan: r1Harv,
            settlement: r1HarvSettle,
            betPlanByModel: { harville: r1Harv, henery: r1Hen },
            settlementByModel: { harville: r1HarvSettle, henery: r1HenSettle },
          },
        },
        {
          analysis: r2,
          lockedRec: {
            raceId: 'TST-2',
            lockedAt: '2026-05-02T22:29:00Z',
            betPlan: r2Harv,
            settlement: r2HarvSettle,
            betPlanByModel: { harville: r2Harv, henery: r2Hen },
            settlementByModel: { harville: r2HarvSettle, henery: r2HenSettle },
          },
        },
      ],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const summary = wb.getWorksheet('Day Summary');
    expect(summary).toBeDefined();

    // The "WINNER" strip should call out HENERY since +20 > -10.
    const text = JSON.stringify(summary!.getSheetValues());
    expect(text).toMatch(/WINNER \(so far\): HENERY/);
  });
});
