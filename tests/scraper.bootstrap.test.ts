import { describe, expect, it } from 'vitest';
import {
  mergeBootstrapResponses,
  selectSubscribableEntries,
  type RaceListEntry,
} from '../lib/scraper/poller';
import type { GetGraphRaceResponse } from '../lib/scraper/queries';

function race(
  id: string,
  tvgRaceId: number,
  raceNumber: string,
  mtp: number,
  statusCode: string,
  postTime = '2026-05-02T22:00:00Z',
  trackCodeOverride?: string,
): GetGraphRaceResponse['races'][number] {
  return {
    id,
    tvgRaceId,
    raceNumber,
    postTime,
    mtp,
    status: { code: statusCode },
    track: trackCodeOverride ? { trackCode: trackCodeOverride } : undefined,
  };
}

describe('mergeBootstrapResponses', () => {
  it('merges races from N getGraphRace responses into one mtp-sorted list', () => {
    const cd: GetGraphRaceResponse = {
      races: [
        race('CD-3', 100, '3', 35, 'O'),
        race('CD-1', 101, '1', -120, 'RO'),
        race('CD-2', 102, '2', 5, 'IC'),
      ],
    };
    const bel: GetGraphRaceResponse = {
      races: [
        race('BEL-5', 200, '5', 12, 'IC'),
        race('BEL-6', 201, '6', 50, 'O'),
      ],
    };
    const merged = mergeBootstrapResponses([cd, bel]);
    expect(merged.length).toBe(5);
    // Sorted by mtp ascending — CD-1 (mtp=-120) comes first, then CD-2, BEL-5, CD-3, BEL-6.
    expect(merged.map((e) => e.raceId)).toEqual(['CD-1', 'CD-2', 'BEL-5', 'CD-3', 'BEL-6']);
  });

  it('parses raceNumber from string to number', () => {
    const r: GetGraphRaceResponse = { races: [race('CD-7', 100, '7', 5, 'IC')] };
    expect(mergeBootstrapResponses([r])[0].raceNumber).toBe(7);
  });

  it('uses track.trackCode when present, falls back to id prefix otherwise', () => {
    const withTrack: GetGraphRaceResponse = {
      races: [race('XYZ-1', 100, '1', 5, 'IC', undefined, 'CD')],
    };
    expect(mergeBootstrapResponses([withTrack])[0].trackCode).toBe('CD');

    const withoutTrack: GetGraphRaceResponse = {
      races: [race('BEL-3', 200, '3', 5, 'IC')],
    };
    expect(mergeBootstrapResponses([withoutTrack])[0].trackCode).toBe('BEL');
  });

  it('handles missing/empty races array safely', () => {
    expect(mergeBootstrapResponses([{ races: [] }])).toEqual([]);
    expect(mergeBootstrapResponses([])).toEqual([]);
  });

  it('preserves tvgRaceId for the WS subscription variables', () => {
    const r: GetGraphRaceResponse = { races: [race('CD-7', 3966636, '7', 3, 'IC')] };
    expect(mergeBootstrapResponses([r])[0].tvgRaceId).toBe(3966636);
  });
});

describe('selectSubscribableEntries', () => {
  const entries: RaceListEntry[] = [
    { raceId: 'CD-1', tvgRaceId: 1001, trackCode: 'CD', raceNumber: 1, postTimeUtc: '...', mtp: -180, statusCode: 'RO' },
    { raceId: 'CD-2', tvgRaceId: 1002, trackCode: 'CD', raceNumber: 2, postTimeUtc: '...', mtp: -60, statusCode: 'SK' },
    { raceId: 'CD-3', tvgRaceId: 1003, trackCode: 'CD', raceNumber: 3, postTimeUtc: '...', mtp: 5, statusCode: 'IC' },
    { raceId: 'CD-4', tvgRaceId: 1004, trackCode: 'CD', raceNumber: 4, postTimeUtc: '...', mtp: 25, statusCode: 'O' },
    { raceId: 'CD-5', tvgRaceId: 1005, trackCode: 'CD', raceNumber: 5, postTimeUtc: '...', mtp: 50, statusCode: 'MO' },
    { raceId: 'CD-6', tvgRaceId: 1006, trackCode: 'CD', raceNumber: 6, postTimeUtc: '...', mtp: 90, statusCode: 'XYZ' },
    { raceId: 'CD-7', tvgRaceId: 0,    trackCode: 'CD', raceNumber: 7, postTimeUtc: '...', mtp: 100, statusCode: 'O' },
  ];

  it('includes O / IC / MO / RO statuses', () => {
    const result = selectSubscribableEntries(entries).map((e) => e.raceId);
    expect(result).toContain('CD-1'); // RO
    expect(result).toContain('CD-3'); // IC
    expect(result).toContain('CD-4'); // O
    expect(result).toContain('CD-5'); // MO
  });

  it('excludes SK (race scratched)', () => {
    const result = selectSubscribableEntries(entries).map((e) => e.raceId);
    expect(result).not.toContain('CD-2');
  });

  it('excludes unknown status codes (defensive)', () => {
    const result = selectSubscribableEntries(entries).map((e) => e.raceId);
    expect(result).not.toContain('CD-6');
  });

  it('excludes entries with missing tvgRaceId (= 0)', () => {
    const result = selectSubscribableEntries(entries).map((e) => e.raceId);
    expect(result).not.toContain('CD-7');
  });

  it('preserves the input ordering of survivors', () => {
    const result = selectSubscribableEntries(entries).map((e) => e.raceId);
    expect(result).toEqual(['CD-1', 'CD-3', 'CD-4', 'CD-5']);
  });
});
