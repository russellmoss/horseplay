import { describe, expect, it } from 'vitest';
import { summarizeRaces } from '../lib/ai/recommend';
import type { HorseAnalysis, RaceAnalysis } from '../lib/types';

function row(
  program: string,
  name: string,
  pWin: number,
  signal: HorseAnalysis['signal'] = 'none',
): HorseAnalysis {
  return {
    program,
    name,
    mlOdds: 5,
    currentOdds: 5,
    currentFractional: '4/1',
    mlDrift: 0,
    pWin,
    pWinRaw: pWin,
    heuristic: {
      pPlaceFair: 2 * pWin,
      pShowFair: 3 * pWin,
      placeFairPayout: pWin > 0 ? 1 / pWin : null,
      showFairPayout: pWin > 0 ? 0.5 / pWin : null,
    },
    harville: {
      pPlaceFair: 2 * pWin,
      pShowFair: 3 * pWin,
      placeFairPayout: pWin > 0 ? 1 / pWin : null,
      showFairPayout: pWin > 0 ? 0.5 / pWin : null,
    },
    henery: {
      pPlaceFair: 2 * pWin,
      pShowFair: 3 * pWin,
      placeFairPayout: pWin > 0 ? 1 / pWin : null,
      showFairPayout: pWin > 0 ? 0.5 / pWin : null,
    },
    placeProjected: { floor: 3.0, mid: 3.5, ceiling: 4.0 },
    showProjected: { floor: 2.4, mid: 2.8, ceiling: 3.2 },
    placeEdge: { heuristicFloor: 0, heuristicMid: 0, harvilleFloor: 0.05, harvilleMid: 0.08, heneryFloor: 0.05, heneryMid: 0.08 },
    showEdge: { heuristicFloor: 0, heuristicMid: 0, harvilleFloor: 0.02, harvilleMid: 0.06, heneryFloor: 0.02, heneryMid: 0.06 },
    winFairPayout: pWin > 0 ? 2 / pWin : null,
    winProjected: pWin > 0 ? (2 / pWin) * 0.84 : null,
    winEdge: pWin > 0 ? -0.16 : null,
    signal,
  };
}

function race(
  raceId: string,
  trackCode: string,
  rows: HorseAnalysis[],
): RaceAnalysis {
  return {
    race: {
      raceId,
      trackCode,
      raceNumber: Number(raceId.split('-')[1]),
      postTimeUtc: '2026-05-02T22:00:00Z',
      status: 'open',
      horses: [],
      lastUpdate: '2026-05-02T21:55:00Z',
    },
    probSource: 'win_pool',
    rows,
    computedAt: '2026-05-02T21:55:01Z',
  };
}

describe('summarizeRaces', () => {
  it('skips scratched horses (pWin === 0)', () => {
    const r = race('CD-7', 'CD', [
      row('1', 'Alpha', 0.3),
      row('2', 'Bravo', 0),
    ]);
    const out = summarizeRaces([r]);
    expect(out).toContain('Alpha');
    expect(out).not.toContain('Bravo');
  });

  it('always includes signaled horses + tops up to 5 by pWin', () => {
    const rows = [
      row('1', 'Alpha', 0.3),
      row('2', 'Bravo', 0.25),
      row('3', 'Charlie', 0.2),
      row('4', 'Delta', 0.15),
      row('5', 'Echo', 0.05),
      row('6', 'Foxtrot', 0.025, 'slam_dunk'),
      row('7', 'Golf', 0.025, 'lean'),
      row('8', 'Hotel', 0.001), // longshot, not signaled — should be excluded
    ];
    const out = summarizeRaces([race('CD-7', 'CD', rows)]);
    // Top 5 by pWin: Alpha, Bravo, Charlie, Delta, Echo. Plus signaled: Foxtrot, Golf.
    expect(out).toContain('Alpha');
    expect(out).toContain('Bravo');
    expect(out).toContain('Charlie');
    expect(out).toContain('Delta');
    expect(out).toContain('Echo');
    expect(out).toContain('Foxtrot');
    expect(out).toContain('Golf');
    expect(out).not.toContain('Hotel');
  });

  it('signal labels appear in the output for signaled horses', () => {
    const rows = [row('6', 'Foxtrot', 0.1, 'slam_dunk')];
    const out = summarizeRaces([race('CD-7', 'CD', rows)]);
    expect(out).toContain('[SLAM_DUNK]');
  });

  it('races with no usable horses are skipped entirely', () => {
    const empty = race('CD-9', 'CD', []);
    const r = race('CD-7', 'CD', [row('1', 'Alpha', 0.3)]);
    const out = summarizeRaces([empty, r]);
    expect(out).toContain('CD R7');
    expect(out).not.toContain('CD R9');
  });

  it('includes track + race number in headers', () => {
    const r = race('BEL-3', 'BEL', [row('1', 'Alpha', 0.3)]);
    expect(summarizeRaces([r])).toContain('BEL R3');
  });

  it('includes post time / mtp hint', () => {
    const r = race('CD-7', 'CD', [row('1', 'Alpha', 0.3)]);
    const out = summarizeRaces([r]);
    expect(out).toMatch(/post 2026-05-02T22:00:00Z/);
  });

  it('formats edges with explicit signs', () => {
    const r = race('CD-7', 'CD', [row('1', 'Alpha', 0.3, 'slam_dunk')]);
    const out = summarizeRaces([r]);
    // placeEdge.harvilleFloor = 0.05 → "+5%"
    expect(out).toMatch(/edge floor \+5%/);
  });
});
