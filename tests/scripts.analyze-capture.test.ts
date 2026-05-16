import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeRecords,
  clusterKey,
  extractGraphQLData,
  extractOperationName,
  findPoolFields,
  formatMarkdown,
  formatStdoutSummary,
  loadCaptureFile,
  urlPattern,
  type CaptureRecord,
} from '../scripts/analyze-capture';

const FIXTURE_PATH = path.resolve('fixtures/sample-capture.jsonl');

describe('urlPattern', () => {
  it('replaces multi-digit numeric path segments with :id', () => {
    expect(urlPattern('https://racing.fanduel.com/api/race/CD/12/pools')).toBe(
      'https://racing.fanduel.com/api/race/CD/:id/pools',
    );
  });

  it('replaces UUID segments with :uuid', () => {
    expect(urlPattern('https://racing.fanduel.com/api/race/abc12345-def6-7890-abcd-ef1234567890/pools')).toBe(
      'https://racing.fanduel.com/api/race/:uuid/pools',
    );
  });

  it('replaces long composite IDs with :token', () => {
    expect(urlPattern('https://racing.fanduel.com/api/race/CD-2026-05-02-12/pools')).toBe(
      'https://racing.fanduel.com/api/race/:token/pools',
    );
  });

  it('drops query strings', () => {
    expect(urlPattern('https://racing.fanduel.com/api/track?id=CD&t=12345')).toBe(
      'https://racing.fanduel.com/api/track',
    );
  });

  it('preserves short non-numeric segments (track codes etc.)', () => {
    expect(urlPattern('https://racing.fanduel.com/api/track/CD')).toBe(
      'https://racing.fanduel.com/api/track/CD',
    );
  });

  it('returns the original string when input is not a valid URL', () => {
    expect(urlPattern('not-a-url')).toBe('not-a-url');
  });
});

describe('findPoolFields', () => {
  it('detects numeric fields with pool-name keys', () => {
    const hits = findPoolFields({ winPool: 50000, placePool: 20000, name: 'Alpha' });
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.path).sort()).toEqual(['placePool', 'winPool']);
    expect(hits.every((h) => h.reason === 'name-match')).toBe(true);
  });

  it('detects per-runner arrays with consistent large numeric values', () => {
    const hits = findPoolFields({
      horses: [
        { name: 'Alpha', winPool: 50000 },
        { name: 'Bravo', winPool: 35000 },
        { name: 'Charlie', winPool: 25000 },
      ],
    });
    const arrayHit = hits.find((h) => h.reason === 'large-numeric-array');
    expect(arrayHit).toBeDefined();
    expect(arrayHit!.path).toBe('horses[].winPool');
    expect(arrayHit!.sampleValue).toBe(50000);
  });

  it('does NOT flag a runner array when numeric values are below the threshold', () => {
    const hits = findPoolFields({
      races: [{ raceNumber: 1 }, { raceNumber: 2 }, { raceNumber: 12 }],
    });
    expect(hits.filter((h) => h.reason === 'large-numeric-array').length).toBe(0);
  });

  it('ignores numeric fields not matching pool-name regexes', () => {
    const hits = findPoolFields({ balance: 12345, expires: 1234567890, unread: 3 });
    expect(hits.length).toBe(0);
  });

  it('prefers large-numeric-array over name-match for the same path', () => {
    const hits = findPoolFields({
      horses: [
        { winPool: 50000 },
        { winPool: 30000 },
      ],
    });
    const winPoolHits = hits.filter((h) => h.path === 'horses[].winPool');
    expect(winPoolHits.length).toBe(1);
    expect(winPoolHits[0].reason).toBe('large-numeric-array');
  });
});

describe('analyzeRecords — fixture integration', () => {
  const records = loadCaptureFile(FIXTURE_PATH);
  const result = analyzeRecords(records);

  it('loads exactly 20 records from the fixture', () => {
    expect(records.length).toBe(20);
    expect(result.totalRecords).toBe(20);
    expect(result.validJsonRecords).toBe(20);
  });

  it('groups records into 12 unique URL patterns', () => {
    expect(result.uniquePatterns).toBe(12);
  });

  it('top URL pattern by frequency is the pool endpoint with 6 hits', () => {
    expect(result.patternFrequency[0]).toEqual({
      pattern: 'https://racing.fanduel.com/api/race/CD/:id/pools',
      count: 6,
    });
  });

  it('top-ranked candidate is the pool endpoint', () => {
    expect(result.candidates[0].pattern).toBe(
      'https://racing.fanduel.com/api/race/CD/:id/pools',
    );
  });

  it('top candidate has at least 6 pool-bearing fields (3 array + 3 name)', () => {
    const top = result.candidates[0];
    expect(top.poolFields.length).toBeGreaterThanOrEqual(6);
    const arrayHits = top.poolFields.filter((f) => f.reason === 'large-numeric-array');
    const nameHits = top.poolFields.filter((f) => f.reason === 'name-match');
    expect(arrayHits.length).toBeGreaterThanOrEqual(3);
    expect(nameHits.length).toBeGreaterThanOrEqual(3);
    // The three runner-array fields:
    const arrayPaths = arrayHits.map((h) => h.path).sort();
    expect(arrayPaths).toEqual(['horses[].placePool', 'horses[].showPool', 'horses[].winPool']);
  });

  it('top candidate cadence is approximately 20 seconds', () => {
    const top = result.candidates[0];
    expect(top.cadenceSecondsMean).not.toBeNull();
    expect(top.cadenceSecondsMean as number).toBeCloseTo(20, 1);
  });

  it('top candidate score is meaningfully higher than every other candidate', () => {
    const top = result.candidates[0];
    expect(top.score).toBeGreaterThan(0);
    for (const other of result.candidates.slice(1)) {
      expect(other.score).toBeLessThan(top.score);
    }
  });

  it('low-noise endpoints (login, account, telemetry) have score 0', () => {
    const noise = [
      'https://racing.fanduel.com/auth/login',
      'https://racing.fanduel.com/api/account',
      'https://www.fanduel.com/api/event',
      'https://racing.fanduel.com/api/notifications',
      'https://racing.fanduel.com/api/auth/refresh',
    ];
    for (const pat of noise) {
      const c = result.candidates.find((x) => x.pattern === pat);
      expect(c, `expected candidate for ${pat}`).toBeDefined();
      expect(c!.score).toBe(0);
      expect(c!.poolFields.length).toBe(0);
    }
  });

  it('account.balance is NOT classified as a pool field (false-positive guard)', () => {
    const account = result.candidates.find(
      (c) => c.pattern === 'https://racing.fanduel.com/api/account',
    );
    expect(account).toBeDefined();
    expect(account!.poolFields).toEqual([]);
  });

  it('refresh.expires is NOT classified as a pool field (false-positive guard)', () => {
    const refresh = result.candidates.find(
      (c) => c.pattern === 'https://racing.fanduel.com/api/auth/refresh',
    );
    expect(refresh).toBeDefined();
    expect(refresh!.poolFields).toEqual([]);
  });

  it('program endpoint (no pool data) has score 0 even with horses[] runner array', () => {
    const program = result.candidates.find(
      (c) => c.pattern === 'https://racing.fanduel.com/api/program/CD/:id',
    );
    expect(program).toBeDefined();
    expect(program!.score).toBe(0);
    expect(program!.poolFields).toEqual([]);
  });
});

describe('analyzeRecords — error tolerance', () => {
  it('skips malformed JSON bodies but still counts them in totalRecords', () => {
    const malformed: CaptureRecord = {
      ts: '2026-05-02T22:00:00.000Z',
      url: 'https://racing.fanduel.com/api/oops',
      method: 'GET',
      status: 200,
      requestHeaders: {},
      responseHeaders: {},
      body: '{"raceId":"CD-12",hor', // truncated mid-JSON
      truncated: true,
    };
    const ok: CaptureRecord = { ...malformed, body: '{"ok":true}', truncated: false };
    const result = analyzeRecords([malformed, ok]);
    expect(result.totalRecords).toBe(2);
    expect(result.validJsonRecords).toBe(1);
  });

  it('handles an empty record array', () => {
    const result = analyzeRecords([]);
    expect(result.totalRecords).toBe(0);
    expect(result.validJsonRecords).toBe(0);
    expect(result.uniquePatterns).toBe(0);
    expect(result.patternFrequency).toEqual([]);
    expect(result.candidates).toEqual([]);
  });
});

describe('formatStdoutSummary / formatMarkdown', () => {
  const records = loadCaptureFile(FIXTURE_PATH);
  const result = analyzeRecords(records);

  it('stdout summary contains the top candidate pattern and the cadence', () => {
    const out = formatStdoutSummary(result);
    expect(out).toContain('Capture analysis');
    expect(out).toContain('Total records       : 20');
    expect(out).toContain('https://racing.fanduel.com/api/race/CD/:id/pools');
    expect(out).toMatch(/cadence: 20\.0s/);
  });

  it('markdown report includes URL pattern table and top-candidate section', () => {
    const md = formatMarkdown(result, '/path/to/auth/network-capture.jsonl');
    expect(md).toContain('# Capture analysis');
    expect(md).toContain('| Count | Pattern |');
    expect(md).toContain('## Candidate pool-bearing endpoints');
    expect(md).toContain('https://racing.fanduel.com/api/race/CD/:id/pools');
    expect(md).toContain('horses[].winPool');
  });
});

describe('loadCaptureFile', () => {
  it('reads the JSONL fixture file from disk', () => {
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);
    const records = loadCaptureFile(FIXTURE_PATH);
    expect(records.length).toBe(20);
    expect(records[0].url).toBe('https://racing.fanduel.com/auth/login');
    expect(records[19].url).toBe('https://racing.fanduel.com/api/race/CD/12/pools');
  });
});

describe('extractOperationName', () => {
  it('returns the GraphQL operationName when requestBody parses as a GraphQL request', () => {
    const r: CaptureRecord = {
      kind: 'http',
      ts: '2026-05-02T22:00:00.000Z',
      url: 'https://api.racing.fanduel.com/cosmo/v1/graphql',
      method: 'POST',
      status: 200,
      requestBody: '{"operationName":"RaceDetails","variables":{"id":"CD-7"},"query":"query RaceDetails(...) {...}"}',
      body: '{"data":{"races":[]}}',
      truncated: false,
    };
    expect(extractOperationName(r)).toBe('RaceDetails');
  });

  it('returns null when requestBody is absent (back-compat with existing fixture)', () => {
    const r: CaptureRecord = {
      ts: '2026-05-02T22:00:00.000Z',
      url: 'https://racing.fanduel.com/api/whatever',
      body: '{"ok":true}',
      truncated: false,
    };
    expect(extractOperationName(r)).toBeNull();
  });

  it('returns null when requestBody is not JSON', () => {
    const r: CaptureRecord = {
      kind: 'http',
      ts: '2026-05-02T22:00:00.000Z',
      url: 'https://racing.fanduel.com/api/form',
      requestBody: 'username=russell&password=...',
      body: '{"ok":true}',
      truncated: false,
    };
    expect(extractOperationName(r)).toBeNull();
  });

  it('returns null for WebSocket records', () => {
    const r: CaptureRecord = {
      kind: 'ws',
      ts: '2026-05-02T22:00:00.000Z',
      url: 'wss://api.racing.fanduel.com/ws',
      direction: 'received',
      body: '{"id":"1","type":"next","payload":{"data":{}}}',
      truncated: false,
    };
    expect(extractOperationName(r)).toBeNull();
  });
});

describe('clusterKey', () => {
  it('appends [op:<name>] for GraphQL HTTP records', () => {
    const r: CaptureRecord = {
      kind: 'http',
      ts: '2026-05-02T22:00:00.000Z',
      url: 'https://api.racing.fanduel.com/cosmo/v1/graphql',
      method: 'POST',
      status: 200,
      requestBody: '{"operationName":"RaceDetails","query":"..."}',
      body: '{}',
      truncated: false,
    };
    expect(clusterKey(r)).toBe('https://api.racing.fanduel.com/cosmo/v1/graphql [op:RaceDetails]');
  });

  it('appends [ws:<direction>] for WebSocket records', () => {
    const r: CaptureRecord = {
      kind: 'ws',
      ts: '2026-05-02T22:00:00.000Z',
      url: 'wss://api.racing.fanduel.com/ws',
      direction: 'received',
      body: '{}',
      truncated: false,
    };
    expect(clusterKey(r)).toBe('wss://api.racing.fanduel.com/ws [ws:received]');
  });

  it('falls back to URL pattern for HTTP records without operationName', () => {
    const r: CaptureRecord = {
      ts: '2026-05-02T22:00:00.000Z',
      url: 'https://racing.fanduel.com/api/race/CD/12',
      body: '{}',
      truncated: false,
    };
    expect(clusterKey(r)).toBe('https://racing.fanduel.com/api/race/CD/:id');
  });
});

describe('extractGraphQLData', () => {
  it('strips graphql-ws subscription envelope (payload.data)', () => {
    const env = { id: '1', type: 'next', payload: { data: { races: [{ id: 'CD-7' }] } } };
    expect(extractGraphQLData(env)).toEqual({ races: [{ id: 'CD-7' }] });
  });

  it('strips direct GraphQL response wrapper (data)', () => {
    const env = { data: { races: [{ id: 'CD-7' }] }, errors: [] };
    expect(extractGraphQLData(env)).toEqual({ races: [{ id: 'CD-7' }] });
  });

  it('returns plain JSON unchanged', () => {
    const obj = { foo: 'bar', baz: 1 };
    expect(extractGraphQLData(obj)).toEqual(obj);
  });

  it('returns non-objects unchanged', () => {
    expect(extractGraphQLData(42)).toBe(42);
    expect(extractGraphQLData('hello')).toBe('hello');
    expect(extractGraphQLData(null)).toBe(null);
  });
});

describe('analyzeRecords — GraphQL operation grouping', () => {
  const baseHttp = {
    kind: 'http' as const,
    method: 'POST',
    status: 200,
    body: '{}',
    truncated: false,
  };
  // Three different GraphQL operations on the same endpoint URL.
  const records: CaptureRecord[] = [
    {
      ...baseHttp,
      ts: '2026-05-02T22:00:00.000Z',
      url: 'https://api.racing.fanduel.com/cosmo/v1/graphql',
      requestBody: '{"operationName":"WalletQuery","query":"..."}',
      body: '{"data":{"wallet":{"balance":1000}}}',
    },
    {
      ...baseHttp,
      ts: '2026-05-02T22:00:01.000Z',
      url: 'https://api.racing.fanduel.com/cosmo/v1/graphql',
      requestBody: '{"operationName":"WalletQuery","query":"..."}',
      body: '{"data":{"wallet":{"balance":1010}}}',
    },
    {
      ...baseHttp,
      ts: '2026-05-02T22:00:00.500Z',
      url: 'https://api.racing.fanduel.com/cosmo/v1/graphql',
      requestBody: '{"operationName":"RaceDetails","variables":{"id":"CD-7"},"query":"..."}',
      // GraphQL response with per-runner pool dollars; analyzer should detect them.
      body: JSON.stringify({
        data: {
          races: [
            {
              id: 'CD-7',
              racePools: [
                { wagerType: { code: 'WN' }, amount: 50000 },
                { wagerType: { code: 'PL' }, amount: 20000 },
              ],
              bettingInterests: [
                { biNumber: 1, biPools: [{ wagerType: { code: 'WN' }, poolRunnersData: [{ amount: 10000 }] }] },
                { biNumber: 2, biPools: [{ wagerType: { code: 'WN' }, poolRunnersData: [{ amount: 8000 }] }] },
                { biNumber: 3, biPools: [{ wagerType: { code: 'WN' }, poolRunnersData: [{ amount: 6000 }] }] },
              ],
            },
          ],
        },
      }),
    },
  ];

  it('groups GraphQL operations separately even when sharing the same URL', () => {
    const result = analyzeRecords(records);
    const patterns = result.patternFrequency.map((p) => p.pattern);
    expect(patterns).toContain('https://api.racing.fanduel.com/cosmo/v1/graphql [op:WalletQuery]');
    expect(patterns).toContain('https://api.racing.fanduel.com/cosmo/v1/graphql [op:RaceDetails]');
    expect(result.uniquePatterns).toBe(2);
  });

  it('finds pool fields on the GraphQL data payload (after stripping the data wrapper)', () => {
    const result = analyzeRecords(records);
    const raceDetails = result.candidates.find((c) => c.pattern.includes('[op:RaceDetails]'));
    expect(raceDetails).toBeDefined();
    expect(raceDetails!.poolFields.length).toBeGreaterThan(0);
    // After extractGraphQLData, paths are relative to `data`, NOT `data.…`
    const paths = raceDetails!.poolFields.map((f) => f.path);
    expect(paths).toContain('races[].racePools[].amount');
  });

  it('the wallet operation has no pool-bearing fields and scores 0', () => {
    const result = analyzeRecords(records);
    const wallet = result.candidates.find((c) => c.pattern.includes('[op:WalletQuery]'));
    expect(wallet).toBeDefined();
    expect(wallet!.score).toBe(0);
  });

  it('RaceDetails ranks above WalletQuery by score', () => {
    const result = analyzeRecords(records);
    expect(result.candidates[0].pattern).toContain('[op:RaceDetails]');
  });
});

describe('analyzeRecords — WebSocket records', () => {
  const wsRecords: CaptureRecord[] = [
    {
      kind: 'ws',
      ts: '2026-05-02T22:00:00.000Z',
      url: 'wss://api.racing.fanduel.com/cosmo/v1/graphql',
      direction: 'received',
      // graphql-ws subscription frame carrying live pool updates.
      body: JSON.stringify({
        id: 'sub-1',
        type: 'next',
        payload: {
          data: {
            races: [
              {
                id: 'CD-7',
                racePools: [
                  { wagerType: { code: 'WN' }, amount: 51000 },
                  { wagerType: { code: 'PL' }, amount: 20500 },
                ],
              },
            ],
          },
        },
      }),
      truncated: false,
    },
    {
      kind: 'ws',
      ts: '2026-05-02T22:00:15.000Z',
      url: 'wss://api.racing.fanduel.com/cosmo/v1/graphql',
      direction: 'received',
      body: JSON.stringify({
        id: 'sub-1',
        type: 'next',
        payload: {
          data: {
            races: [
              {
                id: 'CD-7',
                racePools: [
                  { wagerType: { code: 'WN' }, amount: 52500 },
                  { wagerType: { code: 'PL' }, amount: 21000 },
                ],
              },
            ],
          },
        },
      }),
      truncated: false,
    },
    {
      kind: 'ws',
      ts: '2026-05-02T22:00:00.100Z',
      url: 'wss://api.racing.fanduel.com/cosmo/v1/graphql',
      direction: 'sent',
      // Subscription-init frame; no useful payload.
      body: JSON.stringify({ type: 'connection_init' }),
      truncated: false,
    },
  ];

  it('clusters WS records by URL + direction', () => {
    const result = analyzeRecords(wsRecords);
    const patterns = result.patternFrequency.map((p) => p.pattern);
    expect(patterns).toContain('wss://api.racing.fanduel.com/cosmo/v1/graphql [ws:received]');
    expect(patterns).toContain('wss://api.racing.fanduel.com/cosmo/v1/graphql [ws:sent]');
  });

  it('detects pool fields inside graphql-ws subscription frames', () => {
    const result = analyzeRecords(wsRecords);
    const recv = result.candidates.find((c) => c.pattern.includes('[ws:received]'));
    expect(recv).toBeDefined();
    expect(recv!.poolFields.length).toBeGreaterThan(0);
    const paths = recv!.poolFields.map((f) => f.path);
    expect(paths).toContain('races[].racePools[].amount');
  });

  it('cadence on WS frames reflects the inter-frame gap', () => {
    const result = analyzeRecords(wsRecords);
    const recv = result.candidates.find((c) => c.pattern.includes('[ws:received]'));
    expect(recv!.cadenceSecondsMean).toBeCloseTo(15, 1);
  });

  it('WS records expose null status (no HTTP status code)', () => {
    const result = analyzeRecords(wsRecords);
    const recv = result.candidates.find((c) => c.pattern.includes('[ws:received]'));
    expect(recv!.sampleStatus).toBeNull();
  });
});

describe('back-compat — existing fixture (no kind field) still ranks correctly', () => {
  // The pre-existing fixture has no `kind` / `requestBody` / `direction` —
  // analyzer should treat all records as plain HTTP and produce identical
  // results to the pre-update analyzer.
  const records = loadCaptureFile(FIXTURE_PATH);
  const result = analyzeRecords(records);

  it('still groups into 12 unique URL patterns and ranks the pool endpoint #1', () => {
    expect(result.uniquePatterns).toBe(12);
    expect(result.candidates[0].pattern).toBe(
      'https://racing.fanduel.com/api/race/CD/:id/pools',
    );
  });
});
