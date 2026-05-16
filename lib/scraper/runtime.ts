import type { Session, OpenSessionOptions } from './session';
import type { RunningPoller, PollerOptions } from './poller';
import { openSession as defaultOpenSession } from './session';
import { runPoller as defaultRunPoller } from './poller';
import { loadConfig as defaultLoadConfig, type Config } from '../config';
import { storeSize } from '../store';
import { BotChallengeError, SessionExpiredError } from './fetch';

/**
 * Singleton manager for the live scraper. The web app wires this in
 * `instrumentation.ts` (called once on Next.js boot) and the API routes
 * read its status. Production code uses the default `scraperRuntime`
 * exported at the bottom; tests construct their own via
 * `createScraperRuntime(fakeDeps)`.
 */

export type ScraperState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'unhealthy'
  | 'session_expired';

export interface ScraperStatus {
  state: ScraperState;
  message: string;
  startedAt: string | null;
  lastFrameAt: string | null;
  framesReceived: number;
  analysesCached: number;
  lastError: string | null;
  /**
   * True when FanDuel's PerimeterX layer is currently demanding "Press & Hold"
   * verification. The user must focus the scraper's Chrome window and complete
   * the challenge — pool data goes stale until they do.
   */
  botChallengePending: boolean;
  /** ISO timestamp the challenge was first detected, or null if no challenge. */
  botChallengeDetectedAt: string | null;
  /** Track codes currently being scraped (e.g. ['CD', 'BEL']). */
  trackedTracks: string[];
}

export interface ScraperRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<ScraperStatus>;
  status(): ScraperStatus;
  /**
   * Add a track code to the live scrape set. Tears down the existing poller
   * and re-bootstraps with the merged list. Returns the updated track set.
   * No-op if the track is already present.
   */
  addTrack(code: string): Promise<string[]>;
  /**
   * Remove a track. Refuses to remove the last remaining track (we'd have
   * nothing to scrape). Returns the updated track set.
   */
  removeTrack(code: string): Promise<string[]>;
}

export interface ScraperRuntimeDeps {
  openSession: (opts?: OpenSessionOptions) => Promise<Session>;
  runPoller: (session: Session, options: PollerOptions) => Promise<RunningPoller>;
  loadConfig: () => Config;
  /** Override clock for tests. */
  now?: () => string;
}

const DEFAULT_DEPS: ScraperRuntimeDeps = {
  openSession: defaultOpenSession,
  runPoller: defaultRunPoller,
  loadConfig: defaultLoadConfig,
};

export function createScraperRuntime(
  overrides: Partial<ScraperRuntimeDeps> = {},
): ScraperRuntime {
  const deps: ScraperRuntimeDeps = { ...DEFAULT_DEPS, ...overrides };
  const now = (): string => (deps.now ? deps.now() : new Date().toISOString());

  let state: ScraperState = 'stopped';
  let message = 'Not started.';
  let startedAt: string | null = null;
  let lastFrameAt: string | null = null;
  let framesReceived = 0;
  let lastError: string | null = null;
  let botChallengePending = false;
  let botChallengeDetectedAt: string | null = null;
  /**
   * Live tracked-track set. Initialized from config on first start();
   * mutated by addTrack/removeTrack. Survives stops within the same Node
   * process so the user-added tracks aren't lost across a refresh().
   */
  let trackedTracks: string[] = [];

  let session: Session | null = null;
  let poller: RunningPoller | null = null;

  function snapshot(): ScraperStatus {
    return {
      state,
      message,
      startedAt,
      lastFrameAt,
      framesReceived,
      analysesCached: storeSize(),
      lastError,
      botChallengePending,
      botChallengeDetectedAt,
      trackedTracks: [...trackedTracks],
    };
  }

  function buildPollerOptions(cfg: Config): PollerOptions {
    return {
      trackedTracks: [...trackedTracks],
      takeoutWin: cfg.takeoutWin,
      takeoutPlace: cfg.takeoutPlace,
      takeoutShow: cfg.takeoutShow,
      leanThreshold: cfg.signalLeanThreshold,
      driftThreshold: cfg.signalDriftThreshold,
      flbAlpha: cfg.flbAlpha,
      onAnalysis: () => {
        framesReceived += 1;
        lastFrameAt = now();
        // Any successful frame means HTTP/WS are flowing again. Clear the
        // challenge flag so the dashboard banner goes away on its own once
        // the user completes the Press & Hold.
        if (botChallengePending) {
          botChallengePending = false;
          botChallengeDetectedAt = null;
          message = `Subscribed to ${trackedTracks.join(', ')} (recovered from bot challenge).`;
        }
      },
      onSessionExpired: () => {
        state = 'session_expired';
        message = 'FDR session expired. Re-run `pnpm run login` and restart `pnpm dev`.';
        lastError = message;
      },
      onBotChallenge: () => {
        if (!botChallengePending) {
          botChallengePending = true;
          botChallengeDetectedAt = now();
          message =
            "FanDuel demands 'Press & Hold'. Focus the scraper's Chrome window and complete the check.";
        }
      },
    };
  }

  async function start(): Promise<void> {
    if (state === 'starting' || state === 'running') return;
    state = 'starting';
    message = 'Opening Playwright session…';
    lastError = null;

    try {
      const cfg = deps.loadConfig();
      // Seed trackedTracks from config the first time we start. Later
      // start() / refresh() calls preserve any user-added tracks.
      if (trackedTracks.length === 0) trackedTracks = [...cfg.trackedTracks];
      // Default to headed mode so the user can complete PerimeterX "Press &
      // Hold" challenges visually. Set SCRAPER_HEADLESS=true in .env to run
      // invisibly (you'll have no way to clear bot challenges).
      const headless = process.env.SCRAPER_HEADLESS === 'true';
      session = await deps.openSession({ headless });
      poller = await deps.runPoller(session, buildPollerOptions(cfg));
      state = 'running';
      message = `Subscribed to ${trackedTracks.join(', ')}.`;
      startedAt = now();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (err instanceof SessionExpiredError) {
        state = 'session_expired';
        message = 'FDR session expired. Re-run `pnpm run login` and restart `pnpm dev`.';
      } else if (err instanceof BotChallengeError) {
        botChallengePending = true;
        botChallengeDetectedAt = now();
        state = 'unhealthy';
        message =
          "FanDuel demands 'Press & Hold' before we can start. Focus the scraper's Chrome window and complete the check, then retry.";
      } else {
        state = 'unhealthy';
        message = `Scraper failed to start: ${msg}`;
      }
      // Cleanup any partial session.
      if (poller) await poller.stop().catch(() => undefined);
      poller = null;
      if (session) await session.close().catch(() => undefined);
      session = null;
    }
  }

  async function stop(): Promise<void> {
    if (poller) {
      await poller.stop().catch(() => undefined);
      poller = null;
    }
    if (session) {
      await session.close().catch(() => undefined);
      session = null;
    }
    state = 'stopped';
    message = 'Stopped.';
    startedAt = null;
  }

  async function refresh(): Promise<ScraperStatus> {
    if (!session) {
      // Nothing running — start fresh.
      await start();
      return snapshot();
    }
    if (poller) {
      await poller.stop().catch(() => undefined);
      poller = null;
    }
    try {
      const cfg = deps.loadConfig();
      poller = await deps.runPoller(session, buildPollerOptions(cfg));
      state = 'running';
      message = `Re-subscribed at ${now()}.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (err instanceof SessionExpiredError) {
        state = 'session_expired';
        message = 'FDR session expired during refresh. Re-run `pnpm run login`.';
      } else {
        state = 'unhealthy';
        message = `Scraper refresh failed: ${msg}`;
      }
    }
    return snapshot();
  }

  function normalizeTrackCode(code: string): string {
    return String(code ?? '').trim().toUpperCase();
  }

  async function addTrack(code: string): Promise<string[]> {
    const norm = normalizeTrackCode(code);
    if (norm.length === 0) {
      throw new Error('addTrack: empty track code');
    }
    if (trackedTracks.includes(norm)) {
      // No-op — already tracked.
      return [...trackedTracks];
    }
    trackedTracks.push(norm);
    // If we haven't started yet, the next start() will pick up the new list.
    // If we're running, force a refresh so the bootstrap pulls the new track's
    // races and the WS subscription includes them.
    if (session) {
      await refresh();
    }
    return [...trackedTracks];
  }

  async function removeTrack(code: string): Promise<string[]> {
    const norm = normalizeTrackCode(code);
    if (trackedTracks.length <= 1) {
      throw new Error('removeTrack: cannot remove the last remaining track');
    }
    const idx = trackedTracks.indexOf(norm);
    if (idx === -1) return [...trackedTracks];
    trackedTracks.splice(idx, 1);
    if (session) {
      await refresh();
    }
    return [...trackedTracks];
  }

  return {
    start,
    stop,
    refresh,
    status: snapshot,
    addTrack,
    removeTrack,
  };
}

/**
 * Production singleton. Hoisted to `globalThis` so Next.js dev mode (which
 * occasionally evaluates the same module in multiple loader contexts) doesn't
 * end up with a separate runtime instance per import site.
 */
// v2: introduced addTrack/removeTrack. Bumping the key forces a fresh runtime
// instance after the upgrade so hot-reloaded dev sessions don't keep using
// the older instance that lacks the new methods.
const SINGLETON_KEY = Symbol.for('derbyEdge.scraperRuntime.v2');
type GlobalWithRuntime = { [SINGLETON_KEY]?: ScraperRuntime };
const g = globalThis as GlobalWithRuntime;
const existing = g[SINGLETON_KEY];
// Staleness guard: if a previous hot-reload left an old object that's missing
// methods we depend on, replace it. We try to stop the old one first so any
// open Playwright session gets cleaned up rather than leaking.
const isStale =
  existing !== undefined && typeof existing.addTrack !== 'function';
if (isStale && existing) {
  void existing.stop?.().catch(() => undefined);
}
if (!g[SINGLETON_KEY] || isStale) {
  g[SINGLETON_KEY] = createScraperRuntime();
}
export const scraperRuntime: ScraperRuntime = g[SINGLETON_KEY];
