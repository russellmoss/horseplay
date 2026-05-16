import type { Page } from 'playwright';
import type { Race, RaceAnalysis } from '../types';
import { analyzeRace, type AnalyzeRaceOptions } from '../math/index';
import { upsertRace } from '../store';
import { adaptFdrToRace, type FdrRaceUpdate } from './adapter';
import { recordIfFinishing } from './finish-recorder';
import { BotChallengeError, fetchGraphQL, SessionExpiredError } from './fetch';
import { maybeSettleAndNarrate } from '../simulation/auto-settle';
import {
  FDR_GRAPHQL_WS_URL,
  GET_GRAPH_RACE,
  GET_GRAPH_RACE_DEFAULT_PINS,
  RACE_UPDATE_BY_TVG_RACE_IDS,
  RACE_UPDATE_DEFAULT_PINS,
  type GetGraphRaceResponse,
} from './queries';
import type { Session } from './session';
import { loadConfig } from '../config';

/**
 * Pure pipeline: a single FDR race-update GraphQL fragment becomes a cached
 * RaceAnalysis. This is the ONLY pipeline path — the orchestration shells
 * below feed every received frame through this function.
 *
 * Exposed as its own export for unit-testing the round-trip without spinning
 * up Playwright.
 */
export function ingestRaceUpdate(
  update: FdrRaceUpdate,
  options: AnalyzeRaceOptions,
): RaceAnalysis {
  recordIfFinishing(update);
  const race: Race = adaptFdrToRace(update);
  const analysis = analyzeRace(race, options);
  upsertRace(analysis);
  // If this update brought results AND a bet plan was previously locked
  // for the race, run settlement and generate the post-race narrative once.
  // Idempotent: already-settled races are a no-op.
  if (race.results && race.results.runners.length > 0) {
    void maybeSettleAndNarrate(analysis).catch((err) => {
      console.warn(
        'auto-settle failed for',
        race.raceId,
        ':',
        err instanceof Error ? err.message : err,
      );
    });
  }
  return analysis;
}

export interface RaceListEntry {
  raceId: string;
  tvgRaceId: number;
  trackCode: string;
  raceNumber: number;
  postTimeUtc: string;
  mtp: number;
  statusCode: string;
}

/** Status codes we'll subscribe to via the WS feed. */
const SUBSCRIBABLE_STATUS_CODES = new Set(['O', 'IC', 'MO', 'RO']);

/**
 * Pure: merge any number of getGraphRace responses (one per tracked track)
 * into a flat, mtp-sorted RaceListEntry list. Exported separately so the
 * bootstrap path is testable without mocking Playwright.
 */
export function mergeBootstrapResponses(
  responses: GetGraphRaceResponse[],
): RaceListEntry[] {
  const out: RaceListEntry[] = [];
  for (const data of responses) {
    for (const r of data.races ?? []) {
      const dash = r.id.indexOf('-');
      const trackCode =
        r.track?.trackCode ?? (dash > 0 ? r.id.slice(0, dash) : r.id);
      const raceNumber = Number(r.raceNumber);
      out.push({
        raceId: r.id,
        tvgRaceId: r.tvgRaceId,
        trackCode,
        raceNumber: Number.isFinite(raceNumber) ? raceNumber : 0,
        postTimeUtc: r.postTime,
        mtp: typeof r.mtp === 'number' ? r.mtp : Number.MAX_SAFE_INTEGER,
        statusCode: r.status?.code ?? 'O',
      });
    }
  }
  out.sort((a, b) => a.mtp - b.mtp);
  return out;
}

/**
 * Pure: filter to races we want to listen to via the WS subscription —
 * upcoming or running, not scratched.
 */
export function selectSubscribableEntries(
  entries: RaceListEntry[],
): RaceListEntry[] {
  return entries.filter(
    (e) => SUBSCRIBABLE_STATUS_CODES.has(e.statusCode) && e.tvgRaceId > 0,
  );
}

/**
 * HTTP bootstrap: call getGraphRace once per tracked track. Each response
 * carries every race on that day's card (including finished races with
 * `results` populated) and crucially includes `tvgRaceId` for every race —
 * which getRacesMtpStatus does NOT.
 *
 * Returns BOTH the lightweight selection list AND the full FdrRaceUpdate[]
 * for each race. The full updates are suitable for direct ingestion into
 * the store (so far-from-post races appear in the dashboard immediately
 * instead of waiting for the WS subscription to push them, which can take
 * minutes for races with mtp > 60).
 */
export interface BootstrapResult {
  entries: RaceListEntry[];
  fullRaces: FdrRaceUpdate[];
}

export async function bootstrapRaceList(
  session: Session,
  trackedTracks: string[],
): Promise<BootstrapResult> {
  const responses: GetGraphRaceResponse[] = [];
  for (const track of trackedTracks) {
    const data = await fetchGraphQL<GetGraphRaceResponse>({
      context: session.context,
      operation: GET_GRAPH_RACE,
      variables: { ...GET_GRAPH_RACE_DEFAULT_PINS, trackAbbr: track },
    });
    responses.push(data);
  }
  return {
    entries: mergeBootstrapResponses(responses),
    fullRaces: responses.flatMap(
      (r) => (r.races ?? []) as unknown as FdrRaceUpdate[],
    ),
  };
}

/**
 * Open a graphql-ws subscription INSIDE the page context, so cookies and
 * origin headers are sent automatically. Each `next` frame is handed back to
 * Node via `page.exposeFunction`. The returned function unsubscribes.
 *
 * Implementation note: the subprotocol negotiated with FDR's server is
 * `graphql-transport-ws` (the modern subprotocol name despite the older lib
 * having claimed it — frame types `subscribe`/`next`/`complete` confirm
 * the modern wire format).
 */
/**
 * Per-page registry of the *currently active* frame handler. The bridge
 * function (page.exposeFunction) is registered ONCE per page lifetime and
 * routes through whatever handler is in this map. On refresh (e.g. when a
 * track is added and runPoller is re-invoked) we just swap the handler
 * here; we don't re-register the bridge, which Playwright forbids.
 */
const PAGE_FRAME_HANDLERS = new WeakMap<
  Page,
  (update: FdrRaceUpdate) => void
>();
const PAGE_BRIDGE_REGISTERED = new WeakSet<Page>();

export async function subscribeRaceUpdates(
  page: Page,
  tvgRaceIds: number[],
  onUpdate: (update: FdrRaceUpdate) => void,
  bridgeName = '__derbyEdgeOnSubscriptionFrame',
): Promise<() => Promise<void>> {
  // Always update the active handler — this is what the bridge calls into.
  PAGE_FRAME_HANDLERS.set(page, onUpdate);

  // Register the bridge function only once per page lifetime. Re-registering
  // throws "Function ... has been already registered" in Playwright.
  if (!PAGE_BRIDGE_REGISTERED.has(page)) {
    await page.exposeFunction(bridgeName, (frameJson: string) => {
      try {
        const env = JSON.parse(frameJson) as { type?: string; id?: string; payload?: { data?: { raceUpdateByTvgRaceIds?: FdrRaceUpdate } } };
        if (env.type === 'next' && env.payload?.data?.raceUpdateByTvgRaceIds) {
          // Dispatch to the *current* handler at frame time, not the one
          // captured when this bridge was registered.
          const handler = PAGE_FRAME_HANDLERS.get(page);
          handler?.(env.payload.data.raceUpdateByTvgRaceIds);
        }
      } catch {
        // Malformed frame — skip silently rather than abort the stream.
      }
    });
    PAGE_BRIDGE_REGISTERED.add(page);
  }

  const variables = {
    ...RACE_UPDATE_DEFAULT_PINS,
    tvgRaceIds,
  };

  await page.evaluate(
    ({ url, query, operationName, variables, bridgeName }) => {
      const ws = new WebSocket(url, 'graphql-transport-ws');
      // Stash so the unsubscribe path can close it.
      (window as unknown as { __derbyEdgeWS?: WebSocket }).__derbyEdgeWS = ws;
      const subId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? (crypto as { randomUUID(): string }).randomUUID()
        : `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      (window as unknown as { __derbyEdgeSubId?: string }).__derbyEdgeSubId = subId;

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
      });

      ws.addEventListener('message', (ev: MessageEvent) => {
        const data = typeof ev.data === 'string' ? ev.data : '';
        // Always relay to Node; Node-side filters by type.
        const bridge = (window as unknown as Record<string, unknown>)[bridgeName];
        if (typeof bridge === 'function') {
          (bridge as (s: string) => void)(data);
        }
        try {
          const msg = JSON.parse(data) as { type?: string };
          if (msg.type === 'connection_ack') {
            ws.send(
              JSON.stringify({
                id: subId,
                type: 'subscribe',
                payload: { operationName, variables, query },
              }),
            );
          } else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          // ignore parse errors on non-JSON frames
        }
      });
    },
    {
      url: FDR_GRAPHQL_WS_URL,
      query: RACE_UPDATE_BY_TVG_RACE_IDS.query,
      operationName: RACE_UPDATE_BY_TVG_RACE_IDS.operationName,
      variables,
      bridgeName,
    },
  );

  return async () => {
    await page.evaluate(() => {
      const w = window as unknown as { __derbyEdgeWS?: WebSocket; __derbyEdgeSubId?: string };
      if (w.__derbyEdgeWS && w.__derbyEdgeSubId) {
        try {
          w.__derbyEdgeWS.send(JSON.stringify({ id: w.__derbyEdgeSubId, type: 'complete' }));
        } catch {
          // ignore
        }
        try {
          w.__derbyEdgeWS.close();
        } catch {
          // ignore
        }
      }
    });
  };
}

/**
 * Keepalive: humanized activity to keep the FDR session warm AND avoid
 * tripping PerimeterX behavioral scoring.
 *
 * Why this exists: FDR aggressively logs out idle users (~1 min); without
 * a periodic touch the WS subscription dies mid-card. The naive version of
 * this (HEAD-fetch on a fixed 30s interval, no input events) is what got
 * the user's profile flagged as bot. PerimeterX's behavioral model lights
 * up on regular tick patterns with zero accompanying mouse/scroll events.
 *
 * What this does instead — two independent jittered loops:
 *   1. ACTIVITY LOOP  (every 30–90s, jittered): tiny mouse movement to a
 *      nearby random position, with a 25% chance of also doing a small
 *      scroll. Generates the input-event signal PerimeterX wants to see
 *      on a real session.
 *   2. COOKIE LOOP    (every 90–180s, jittered): low-frequency HEAD touch
 *      on `/` so the server-side session timeout doesn't expire. Much less
 *      obvious than the old 30s tick.
 *
 * Stops cleanly when stop() is called. Errors during page operations are
 * swallowed so a transient navigate/detach doesn't kill the loops.
 */
export function startKeepalive(
  session: Session,
  // Legacy param. Ignored — kept for backward-compat with existing callers.
  _intervalMsLegacy?: number,
): { stop: () => void } {
  let stopped = false;

  // Track last cursor position so movements look continuous, not teleporty.
  let lastX = 200 + Math.floor(Math.random() * 400);
  let lastY = 200 + Math.floor(Math.random() * 200);

  function jitterMs(baseSec: number, varianceSec: number): number {
    const min = (baseSec - varianceSec) * 1000;
    const max = (baseSec + varianceSec) * 1000;
    return min + Math.random() * (max - min);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function activityLoop(): Promise<void> {
    // Initial random delay so we don't fire two activity ticks at the same
    // moment across multiple poller restarts (e.g. addTrack refreshes).
    await sleep(jitterMs(30, 15));
    while (!stopped) {
      try {
        // Move mouse to a nearby random position.
        const dx = (Math.random() - 0.5) * 200;
        const dy = (Math.random() - 0.5) * 200;
        const newX = Math.max(50, Math.min(1100, lastX + dx));
        const newY = Math.max(50, Math.min(700, lastY + dy));
        const steps = 4 + Math.floor(Math.random() * 8);
        await session.page.mouse.move(newX, newY, { steps });
        lastX = newX;
        lastY = newY;

        // 25% of the time, also do a small scroll.
        if (Math.random() < 0.25) {
          const scrollDy =
            (Math.random() < 0.5 ? -1 : 1) * (60 + Math.floor(Math.random() * 200));
          await session.page.evaluate((amount: number) => {
            window.scrollBy(0, amount);
          }, scrollDy);
        }
      } catch {
        // Page might be mid-navigation or detached during a refresh; ignore.
      }
      await sleep(jitterMs(60, 30)); // 30–90s between activity ticks
    }
  }

  async function cookieLoop(): Promise<void> {
    // Stagger the cookie loop ahead of the activity loop so they don't pulse
    // together every cycle.
    await sleep(jitterMs(75, 30));
    while (!stopped) {
      try {
        await session.page.evaluate(() => {
          void fetch('/', { method: 'HEAD', cache: 'no-store' }).catch(
            () => undefined,
          );
        });
      } catch {
        // ignore
      }
      await sleep(jitterMs(135, 45)); // 90–180s between cookie touches
    }
  }

  void activityLoop();
  void cookieLoop();

  return {
    stop: () => {
      stopped = true;
    },
  };
}

/** Strings that appear on the PerimeterX / HUMAN challenge page. */
const PAGE_CHALLENGE_MARKERS: readonly string[] = [
  'Please verify you are a human',
  'Access to this page has been denied because we believe you are using automation',
  'Press & Hold',
  'press and hold',
  'px-captcha',
  '_pxAppId',
];

/**
 * Periodically inspect the scraper's Chrome page itself for the bot-challenge
 * HTML. The fetch-side detection in lib/scraper/fetch.ts only fires when a
 * GraphQL request trips the challenge — but PerimeterX often swaps the page
 * to a challenge BEFORE we make our next HTTP call, so the dashboard banner
 * would lag until the bootstrap refresh finally caught it.
 *
 * This watcher closes that gap: every ~10s it asks the page whether its body
 * text or title contains a challenge marker, and fires onChallenge() the
 * instant it sees one. The flag clears itself when the next analysis frame
 * lands (see runtime.onAnalysis).
 */
export function startBotChallengeWatcher(
  session: Session,
  onChallenge: () => void,
  intervalMs = 10_000,
): { stop: () => void } {
  const handle = setInterval(() => {
    void (async () => {
      try {
        const found = await session.page.evaluate((markers: string[]) => {
          const haystack = `${document.title}\n${document.body?.innerText ?? ''}`;
          return markers.some((m) => haystack.includes(m));
        }, PAGE_CHALLENGE_MARKERS as unknown as string[]);
        if (found) onChallenge();
      } catch {
        // Page might be navigating or the context torn down; ignore.
      }
    })();
  }, intervalMs);
  return {
    stop: () => clearInterval(handle),
  };
}

/**
 * Top-level orchestrator. Stitches together: bootstrap → subscribe → ingest →
 * keepalive. Errors during ingestion are logged but don't abort the stream;
 * SessionExpiredError aborts the whole loop and surfaces to the caller.
 *
 * Not unit-tested — exercised manually with a real FDR session.
 */
export interface PollerOptions extends AnalyzeRaceOptions {
  trackedTracks: string[];
  /**
   * Legacy: ignored. The keepalive is now a self-jittering humanized loop.
   * Kept on the type for backward compat with existing call sites.
   */
  keepaliveMs?: number;
  /**
   * Periodic HTTP re-bootstrap interval. The WS subscription pushes updates
   * aggressively for the close-to-post race only; far-from-post races would
   * sit on stale bootstrap snapshots otherwise. We re-run getGraphRace at
   * this cadence so every race's pool data and odds stay reasonably fresh.
   * Default 60s. Set to 0 to disable.
   */
  bootstrapRefreshMs?: number;
  /** Called whenever a race-update results in a fresh RaceAnalysis. */
  onAnalysis?: (a: RaceAnalysis) => void;
  /** Called when the session is detected as expired. */
  onSessionExpired?: () => void;
  /**
   * Called when an HTTP query is intercepted by FanDuel's PerimeterX
   * "Press & Hold" challenge. The runtime turns this into a dashboard
   * banner instructing the user to complete the check manually.
   */
  onBotChallenge?: () => void;
}

export interface RunningPoller {
  stop(): Promise<void>;
}

export async function runPoller(
  session: Session,
  options: PollerOptions,
): Promise<RunningPoller> {
  const cfg = loadConfig();
  // keepaliveMs is no longer consumed — startKeepalive self-jitters now.
  // Reading cfg here so the loadConfig() call still happens for future use.
  void cfg;

  let raceList: RaceListEntry[];
  let fullRaces: FdrRaceUpdate[];
  try {
    const bootstrap = await bootstrapRaceList(session, options.trackedTracks);
    raceList = bootstrap.entries;
    fullRaces = bootstrap.fullRaces;
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      options.onSessionExpired?.();
      throw err;
    }
    if (err instanceof BotChallengeError) {
      options.onBotChallenge?.();
      throw err;
    }
    throw err;
  }

  // Prime the store with full data from getGraphRace BEFORE opening the WS.
  // Otherwise far-from-post races (mtp > 60) take minutes to appear in
  // the dashboard while we wait for FDR to push them. With pre-population,
  // every race on the card shows up immediately; WS frames overwrite as
  // pool dollars and odds tick up.
  const ingestOpts: AnalyzeRaceOptions = {
    takeoutPlace: options.takeoutPlace,
    takeoutShow: options.takeoutShow,
    leanThreshold: options.leanThreshold,
    driftThreshold: options.driftThreshold,
  };
  for (const update of fullRaces) {
    try {
      const analysis = ingestRaceUpdate(update, ingestOpts);
      options.onAnalysis?.(analysis);
    } catch (err) {
      // Bad/incomplete data on initial bootstrap is OK — WS will fill in.
      console.warn(
        'poller: skipped initial ingest for',
        update.id,
        ':',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // bootstrapRaceList now uses getGraphRace per tracked track, which always
  // returns tvgRaceId. Filter to subscribable statuses before subscribing.
  const subscribable = selectSubscribableEntries(raceList);
  const tvgRaceIds = subscribable.map((e) => e.tvgRaceId);

  let unsubscribe: (() => Promise<void>) | null = null;
  if (tvgRaceIds.length > 0) {
    unsubscribe = await subscribeRaceUpdates(
      session.page,
      tvgRaceIds,
      (update) => {
        try {
          const analysis = ingestRaceUpdate(update, ingestOpts);
          options.onAnalysis?.(analysis);
        } catch (err) {
          // One bad frame doesn't kill the stream.
          console.warn(
            'poller: failed to ingest race update for',
            update.id,
            ':',
            err instanceof Error ? err.message : err,
          );
        }
      },
    );
  }

  const ka = startKeepalive(session);

  // Direct page-level challenge watcher. Fires onBotChallenge the moment the
  // scraper's Chrome page renders the PerimeterX challenge, even if no HTTP
  // GraphQL call has tripped over it yet.
  const challengeWatcher = options.onBotChallenge
    ? startBotChallengeWatcher(session, options.onBotChallenge)
    : null;

  // Periodic HTTP re-bootstrap. Keeps far-from-post races fresh — FDR's WS
  // subscription only pushes updates aggressively for the active race;
  // others would otherwise stay on the stale bootstrap snapshot indefinitely.
  const bootstrapMs = options.bootstrapRefreshMs ?? 60_000;
  let bootstrapTimer: ReturnType<typeof setInterval> | null = null;
  if (bootstrapMs > 0) {
    bootstrapTimer = setInterval(() => {
      void (async () => {
        try {
          const refresh = await bootstrapRaceList(session, options.trackedTracks);
          for (const update of refresh.fullRaces) {
            try {
              const analysis = ingestRaceUpdate(update, ingestOpts);
              options.onAnalysis?.(analysis);
            } catch {
              // skip individual ingest failures
            }
          }
        } catch (err) {
          if (err instanceof SessionExpiredError) {
            options.onSessionExpired?.();
          } else if (err instanceof BotChallengeError) {
            options.onBotChallenge?.();
          } else {
            console.warn(
              'poller: bootstrap refresh failed:',
              err instanceof Error ? err.message : err,
            );
          }
        }
      })();
    }, bootstrapMs);
  }

  return {
    stop: async () => {
      if (bootstrapTimer) clearInterval(bootstrapTimer);
      ka.stop();
      challengeWatcher?.stop();
      if (unsubscribe) await unsubscribe();
    },
  };
}
