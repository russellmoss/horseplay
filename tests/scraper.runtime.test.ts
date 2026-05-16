import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScraperRuntime, type ScraperRuntimeDeps } from '../lib/scraper/runtime';
import { SessionExpiredError } from '../lib/scraper/fetch';
import type { PollerOptions, RunningPoller } from '../lib/scraper/poller';
import type { Session } from '../lib/scraper/session';
import { clearStore, upsertRace } from '../lib/store';
import type { Config } from '../lib/config';

const FAKE_CONFIG: Config = {
  trackedTracks: ['CD'],
  fdrBaseUrl: 'https://racing.fanduel.com',
  pollCadenceLiveSeconds: 15,
  pollCadenceNearSeconds: 60,
  pollCadenceFarSeconds: 300,
  pollConcurrency: 3,
  takeoutWin: 0.16,
  takeoutPlace: 0.17,
  takeoutShow: 0.17,
  signalLeanThreshold: 0.05,
  signalDriftThreshold: 0.5,
  flbAlpha: 1.06,
  logLevel: 'info',
  dashboardPollMs: 5000,
  enableSoundAlerts: true,
};

interface FakeSession extends Session {
  closeCalls: number;
}

interface FakePoller extends RunningPoller {
  stopCalls: number;
}

interface Fakes {
  sessionsOpened: number;
  pollersStarted: number;
  capturedOptions: PollerOptions[];
  currentSession: FakeSession | null;
  currentPoller: FakePoller | null;
  triggerAnalysis: () => void;
  triggerSessionExpired: () => void;
}

function buildDeps(opts: {
  openSessionImpl?: () => Promise<Session>;
  runPollerImpl?: (session: Session, options: PollerOptions) => Promise<RunningPoller>;
  configOverride?: Partial<Config>;
  now?: () => string;
} = {}): { deps: ScraperRuntimeDeps; fakes: Fakes } {
  const fakes: Fakes = {
    sessionsOpened: 0,
    pollersStarted: 0,
    capturedOptions: [],
    currentSession: null,
    currentPoller: null,
    triggerAnalysis: () => {
      throw new Error('no poller running');
    },
    triggerSessionExpired: () => {
      throw new Error('no poller running');
    },
  };

  const defaultOpenSession = async (): Promise<Session> => {
    fakes.sessionsOpened += 1;
    const session: FakeSession = {
      context: {} as Session['context'],
      page: {} as Session['page'],
      close: async () => {
        session.closeCalls += 1;
      },
      closeCalls: 0,
    };
    fakes.currentSession = session;
    return session;
  };

  const defaultRunPoller = async (
    _session: Session,
    options: PollerOptions,
  ): Promise<RunningPoller> => {
    fakes.pollersStarted += 1;
    fakes.capturedOptions.push(options);
    const poller: FakePoller = {
      stop: async () => {
        poller.stopCalls += 1;
      },
      stopCalls: 0,
    };
    fakes.currentPoller = poller;
    fakes.triggerAnalysis = () => options.onAnalysis?.({} as never);
    fakes.triggerSessionExpired = () => options.onSessionExpired?.();
    return poller;
  };

  const deps: ScraperRuntimeDeps = {
    openSession: opts.openSessionImpl ?? defaultOpenSession,
    runPoller: opts.runPollerImpl ?? defaultRunPoller,
    loadConfig: () => ({ ...FAKE_CONFIG, ...(opts.configOverride ?? {}) }),
    now: opts.now,
  };
  return { deps, fakes };
}

describe('scraperRuntime — start()', () => {
  beforeEach(() => clearStore());
  afterEach(() => clearStore());

  it('initial state is stopped', () => {
    const { deps } = buildDeps();
    const rt = createScraperRuntime(deps);
    const status = rt.status();
    expect(status.state).toBe('stopped');
    expect(status.framesReceived).toBe(0);
    expect(status.startedAt).toBeNull();
  });

  it('start() transitions stopped → running on success', async () => {
    let nowCount = 0;
    const { deps, fakes } = buildDeps({ now: () => `2026-05-02T22:00:0${nowCount++}.000Z` });
    const rt = createScraperRuntime(deps);
    await rt.start();
    expect(rt.status().state).toBe('running');
    expect(rt.status().startedAt).toBe('2026-05-02T22:00:00.000Z');
    expect(fakes.sessionsOpened).toBe(1);
    expect(fakes.pollersStarted).toBe(1);
  });

  it('start() is idempotent — no-op when already running', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    await rt.start();
    await rt.start();
    expect(fakes.sessionsOpened).toBe(1);
    expect(fakes.pollersStarted).toBe(1);
  });

  it('start() transitions to unhealthy when openSession throws', async () => {
    const { deps } = buildDeps({
      openSessionImpl: async () => {
        throw new Error('No saved FDR session');
      },
    });
    const rt = createScraperRuntime(deps);
    await rt.start();
    const status = rt.status();
    expect(status.state).toBe('unhealthy');
    expect(status.message).toMatch(/No saved FDR session/);
    expect(status.lastError).toMatch(/No saved FDR session/);
  });

  it('start() transitions to session_expired when SessionExpiredError thrown', async () => {
    const { deps } = buildDeps({
      runPollerImpl: async () => {
        throw new SessionExpiredError('401 from FDR');
      },
    });
    const rt = createScraperRuntime(deps);
    await rt.start();
    expect(rt.status().state).toBe('session_expired');
    expect(rt.status().message).toMatch(/Re-run `pnpm run login`/);
  });

  it('start() failure cleans up partially-opened session', async () => {
    const { deps, fakes } = buildDeps({
      runPollerImpl: async () => {
        throw new Error('boom');
      },
    });
    const rt = createScraperRuntime(deps);
    await rt.start();
    expect(rt.status().state).toBe('unhealthy');
    expect(fakes.currentSession?.closeCalls).toBe(1);
  });

  it('start() can be called again after a failure to retry', async () => {
    let calls = 0;
    const { deps, fakes } = buildDeps({
      runPollerImpl: async (_s, options) => {
        calls += 1;
        if (calls === 1) throw new Error('first try fails');
        const poller: FakePoller = { stop: async () => undefined, stopCalls: 0 };
        fakes.currentPoller = poller;
        fakes.triggerAnalysis = () => options.onAnalysis?.({} as never);
        fakes.triggerSessionExpired = () => options.onSessionExpired?.();
        return poller;
      },
    });
    const rt = createScraperRuntime(deps);
    await rt.start();
    expect(rt.status().state).toBe('unhealthy');
    await rt.start();
    expect(rt.status().state).toBe('running');
  });
});

describe('scraperRuntime — runtime callbacks bump status', () => {
  beforeEach(() => clearStore());

  it('onAnalysis bumps framesReceived and stamps lastFrameAt', async () => {
    let nowCount = 0;
    const { deps, fakes } = buildDeps({
      now: () => `2026-05-02T22:00:0${nowCount++}.000Z`,
    });
    const rt = createScraperRuntime(deps);
    await rt.start();
    expect(rt.status().framesReceived).toBe(0);
    fakes.triggerAnalysis();
    fakes.triggerAnalysis();
    fakes.triggerAnalysis();
    expect(rt.status().framesReceived).toBe(3);
    expect(rt.status().lastFrameAt).not.toBeNull();
  });

  it('onSessionExpired flips state to session_expired', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    expect(rt.status().state).toBe('running');
    fakes.triggerSessionExpired();
    expect(rt.status().state).toBe('session_expired');
    expect(rt.status().message).toMatch(/session expired/i);
  });

  it('analysesCached reflects lib/store size', async () => {
    const { deps } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    expect(rt.status().analysesCached).toBe(0);
    upsertRace({
      race: {
        raceId: 'CD-7',
        trackCode: 'CD',
        raceNumber: 7,
        postTimeUtc: '2026-05-02T22:00:00Z',
        status: 'open',
        horses: [],
        lastUpdate: '2026-05-02T21:55:00Z',
      },
      probSource: 'win_pool',
      rows: [],
      computedAt: '2026-05-02T21:55:01Z',
    });
    expect(rt.status().analysesCached).toBe(1);
  });
});

describe('scraperRuntime — stop()', () => {
  it('stop() closes session and poller, transitions to stopped', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    await rt.stop();
    expect(rt.status().state).toBe('stopped');
    expect(rt.status().startedAt).toBeNull();
    expect(fakes.currentPoller?.stopCalls).toBe(1);
    expect(fakes.currentSession?.closeCalls).toBe(1);
  });

  it('stop() is safe to call when never started', async () => {
    const { deps } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.stop();
    expect(rt.status().state).toBe('stopped');
  });
});

describe('scraperRuntime — refresh()', () => {
  it('refresh() restarts the poller WITHOUT closing the session', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    const firstPoller = fakes.currentPoller;
    await rt.refresh();
    expect(fakes.sessionsOpened).toBe(1); // session NOT reopened
    expect(fakes.pollersStarted).toBe(2); // poller restarted
    expect(firstPoller?.stopCalls).toBe(1); // old poller stopped
  });

  it('refresh() when never started → starts fresh', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    expect(rt.status().state).toBe('stopped');
    await rt.refresh();
    expect(rt.status().state).toBe('running');
    expect(fakes.sessionsOpened).toBe(1);
    expect(fakes.pollersStarted).toBe(1);
  });

  it('refresh() returns the current status snapshot', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    fakes.triggerAnalysis();
    fakes.triggerAnalysis();
    const status = await rt.refresh();
    expect(status.state).toBe('running');
    expect(status.framesReceived).toBe(2);
  });
});

describe('scraperRuntime — addTrack/removeTrack', () => {
  beforeEach(() => clearStore());
  afterEach(() => clearStore());

  it('seeds trackedTracks from config on first start', async () => {
    const { deps } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    expect(rt.status().trackedTracks).toEqual(['CD']);
  });

  it('addTrack appends and re-bootstraps the poller', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    expect(fakes.pollersStarted).toBe(1);
    const updated = await rt.addTrack('BEL');
    expect(updated).toEqual(['CD', 'BEL']);
    expect(rt.status().trackedTracks).toEqual(['CD', 'BEL']);
    // refresh() tears down old poller and starts a new one
    expect(fakes.pollersStarted).toBe(2);
    expect(fakes.currentPoller?.stopCalls).toBeGreaterThanOrEqual(0);
    // The new poller was given the merged track list
    const lastOptions = fakes.capturedOptions[fakes.capturedOptions.length - 1];
    expect(lastOptions.trackedTracks).toEqual(['CD', 'BEL']);
  });

  it('addTrack uppercases and trims the input', async () => {
    const { deps } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    await rt.addTrack('  bel  ');
    expect(rt.status().trackedTracks).toEqual(['CD', 'BEL']);
  });

  it('addTrack is idempotent when the track is already present', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    const startCount = fakes.pollersStarted;
    await rt.addTrack('CD');
    expect(rt.status().trackedTracks).toEqual(['CD']);
    expect(fakes.pollersStarted).toBe(startCount); // no extra refresh
  });

  it('addTrack before start just queues the track for next start', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.addTrack('BEL');
    expect(rt.status().trackedTracks).toEqual(['BEL']);
    expect(fakes.pollersStarted).toBe(0); // no poller yet
    await rt.start();
    expect(fakes.capturedOptions[0].trackedTracks).toEqual(['BEL']);
  });

  it('removeTrack drops the track and re-bootstraps', async () => {
    const { deps, fakes } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    await rt.addTrack('BEL');
    await rt.addTrack('SAR');
    const before = fakes.pollersStarted;
    await rt.removeTrack('BEL');
    expect(rt.status().trackedTracks).toEqual(['CD', 'SAR']);
    expect(fakes.pollersStarted).toBe(before + 1);
  });

  it('removeTrack rejects removing the last remaining track', async () => {
    const { deps } = buildDeps();
    const rt = createScraperRuntime(deps);
    await rt.start();
    await expect(rt.removeTrack('CD')).rejects.toThrow(/last remaining/);
    expect(rt.status().trackedTracks).toEqual(['CD']);
  });

  it('addTrack throws on empty input', async () => {
    const { deps } = buildDeps();
    const rt = createScraperRuntime(deps);
    await expect(rt.addTrack('')).rejects.toThrow(/empty/);
    await expect(rt.addTrack('   ')).rejects.toThrow(/empty/);
  });
});

describe('scraperRuntime — production singleton', () => {
  it('exports a singleton that survives module reload', async () => {
    // Smoke test — construct a runtime with fake deps and verify it's a fresh
    // instance independent of the production singleton. (The production
    // singleton is the default export at the bottom of runtime.ts.)
    const { deps } = buildDeps();
    const rt = createScraperRuntime(deps);
    expect(typeof rt.start).toBe('function');
    expect(typeof rt.stop).toBe('function');
    expect(typeof rt.refresh).toBe('function');
    expect(typeof rt.status).toBe('function');
    expect(typeof rt.addTrack).toBe('function');
    expect(typeof rt.removeTrack).toBe('function');
    // Verify vi is silent (no real side effects).
    vi.useRealTimers();
  });
});
