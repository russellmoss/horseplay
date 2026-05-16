import { afterEach, describe, expect, it } from 'vitest';
import {
  clearStore,
  getRace,
  listRaces,
  listRacesByTrack,
  removeRace,
  storeSize,
  upsertRace,
} from '../lib/store';
import type { RaceAnalysis } from '../lib/types';

function makeAnalysis(raceId: string, trackCode: string): RaceAnalysis {
  return {
    race: {
      raceId,
      trackCode,
      raceNumber: Number(raceId.split('-')[1] ?? 0),
      postTimeUtc: '2026-05-02T22:00:00Z',
      status: 'open',
      horses: [],
      lastUpdate: '2026-05-02T21:55:00Z',
    },
    probSource: 'win_pool',
    rows: [],
    computedAt: '2026-05-02T21:55:01Z',
  };
}

describe('store', () => {
  afterEach(() => {
    clearStore();
  });

  it('upsert + get round-trip', () => {
    const a = makeAnalysis('CD-7', 'CD');
    upsertRace(a);
    expect(getRace('CD-7')).toBe(a);
    expect(storeSize()).toBe(1);
  });

  it('upsert is last-write-wins per raceId', () => {
    upsertRace(makeAnalysis('CD-7', 'CD'));
    const second = makeAnalysis('CD-7', 'CD');
    upsertRace(second);
    expect(getRace('CD-7')).toBe(second);
    expect(storeSize()).toBe(1);
  });

  it('getRace returns null for unknown raceId', () => {
    expect(getRace('NOPE-1')).toBeNull();
  });

  it('listRaces returns all entries', () => {
    upsertRace(makeAnalysis('CD-7', 'CD'));
    upsertRace(makeAnalysis('CD-8', 'CD'));
    upsertRace(makeAnalysis('BEL-3', 'BEL'));
    const all = listRaces();
    expect(all.length).toBe(3);
    expect(all.map((a) => a.race.raceId).sort()).toEqual(['BEL-3', 'CD-7', 'CD-8']);
  });

  it('listRacesByTrack filters by trackCode', () => {
    upsertRace(makeAnalysis('CD-7', 'CD'));
    upsertRace(makeAnalysis('CD-8', 'CD'));
    upsertRace(makeAnalysis('BEL-3', 'BEL'));
    expect(listRacesByTrack('CD').map((a) => a.race.raceId).sort()).toEqual(['CD-7', 'CD-8']);
    expect(listRacesByTrack('BEL').length).toBe(1);
    expect(listRacesByTrack('NOPE').length).toBe(0);
  });

  it('removeRace deletes by id and returns whether it was present', () => {
    upsertRace(makeAnalysis('CD-7', 'CD'));
    expect(removeRace('CD-7')).toBe(true);
    expect(removeRace('CD-7')).toBe(false);
    expect(getRace('CD-7')).toBeNull();
  });

  it('clearStore removes everything', () => {
    upsertRace(makeAnalysis('CD-7', 'CD'));
    upsertRace(makeAnalysis('BEL-3', 'BEL'));
    clearStore();
    expect(storeSize()).toBe(0);
    expect(listRaces()).toEqual([]);
  });
});
