import { openSession } from '../lib/scraper/session';
import { fetchGraphQL, SessionExpiredError } from '../lib/scraper/fetch';
import {
  GET_GRAPH_RACE,
  GET_GRAPH_RACE_DEFAULT_PINS,
  type GetGraphRaceResponse,
} from '../lib/scraper/queries';
import {
  ingestRaceUpdate,
  mergeBootstrapResponses,
  selectSubscribableEntries,
  startKeepalive,
  subscribeRaceUpdates,
  type RaceListEntry,
} from '../lib/scraper/poller';
import { listRaces, clearStore } from '../lib/store';
import { loadConfig } from '../lib/config';

/**
 * One-shot live integration probe. Bootstraps each tracked track via
 * getGraphRace, opens a graphql-ws subscription for the closest-to-post
 * races, ingests every received frame through adapter → math → store,
 * runs for `PROBE_SECONDS` (default 90), then prints a summary.
 *
 * Usage:
 *   pnpm run test-subscription
 *
 * Env knobs:
 *   PROBE_SECONDS    : how long to listen (default 90).
 *   PROBE_MAX_RACES  : how many races to subscribe to (default 8).
 *   PROBE_HEADLESS   : "true" to run headless (default "false" so you can
 *                      see the browser if PerimeterX challenges appear).
 */

const RUN_SECONDS = Number(process.env.PROBE_SECONDS ?? 90);
const MAX_RACES = Number(process.env.PROBE_MAX_RACES ?? 8);
const HEADLESS = (process.env.PROBE_HEADLESS ?? 'false').toLowerCase() === 'true';

(async () => {
  const cfg = loadConfig();

  console.log('======================================================================');
  console.log(' derby-edge — subscription probe');
  console.log('======================================================================');
  console.log(' Tracked tracks   :', cfg.trackedTracks.join(', '));
  console.log(' Run duration     :', RUN_SECONDS, 's');
  console.log(' Max races to sub :', MAX_RACES);
  console.log(' Headless         :', HEADLESS);
  console.log('======================================================================\n');

  clearStore();

  const session = await openSession({ headless: HEADLESS }).catch((err) => {
    console.error('Failed to open session. Have you run `pnpm run login`?');
    console.error('  Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });

  console.log('[probe] Session opened.');

  // ── 1. Bootstrap each tracked track ────────────────────────────────────────
  const responses: GetGraphRaceResponse[] = [];
  for (const trackAbbr of cfg.trackedTracks) {
    process.stdout.write(`[probe] Fetching getGraphRace(${trackAbbr})... `);
    try {
      const data = await fetchGraphQL<GetGraphRaceResponse>({
        context: session.context,
        operation: GET_GRAPH_RACE,
        variables: { ...GET_GRAPH_RACE_DEFAULT_PINS, trackAbbr },
      });
      console.log(`OK (${data.races?.length ?? 0} races)`);
      responses.push(data);
    } catch (err) {
      console.log('FAILED');
      if (err instanceof SessionExpiredError) {
        console.error('  → Session expired. Re-run `pnpm run login` and try again.');
        await session.close();
        process.exit(2);
      }
      console.error('  →', err instanceof Error ? err.message : err);
    }
  }

  const allEntries = mergeBootstrapResponses(responses);
  const subscribable = selectSubscribableEntries(allEntries);
  const target: RaceListEntry[] = subscribable.slice(0, MAX_RACES);

  console.log('\n[probe] All races returned by getGraphRace:');
  for (const e of allEntries) {
    const inSub = subscribable.includes(e) ? ' ' : 'x';
    console.log(
      `  [${inSub}] ${e.raceId.padEnd(12)} mtp=${String(e.mtp).padStart(5)}  status=${e.statusCode.padEnd(3)}  postTime=${e.postTimeUtc}`,
    );
  }

  if (target.length === 0) {
    console.log(
      '\n[probe] No subscribable races at any tracked track right now (all finished or scratched).',
    );
    console.log('         Try a different time of day or change TRACKED_TRACKS in .env.\n');
    await session.close();
    process.exit(0);
  }

  console.log(`\n[probe] Will subscribe to ${target.length} races (closest to post first):`);
  for (const e of target) {
    console.log(
      `   ${e.raceId.padEnd(12)} mtp=${String(e.mtp).padStart(5)}  tvgRaceId=${e.tvgRaceId}`,
    );
  }

  // ── 2. Diagnostic: log every WS frame at the network level ─────────────────
  // This sees ALL WS traffic on the page, including connection_init/ack and
  // any other subscriptions the page itself opens.
  session.page.on('websocket', (ws) => {
    if (!ws.url().includes('cosmo/v1/graphql')) return;
    console.log(`[ws] open: ${ws.url()}`);
    ws.on('framesent', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8');
      const t = peekFrameType(text);
      if (t === 'subscribe' || t === 'connection_init' || t === 'complete') {
        console.log(`[ws] sent: ${t}${peekOperationName(text) ? ` op=${peekOperationName(text)}` : ''}`);
      }
    });
    ws.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8');
      const t = peekFrameType(text);
      if (t === 'connection_ack' || t === 'complete' || t === 'error' || t === 'ping') {
        console.log(`[ws] recv: ${t}`);
      }
    });
    ws.on('close', () => console.log('[ws] close'));
  });

  // ── 3. Open the subscription and ingest frames ─────────────────────────────
  let frameCount = 0;
  let analysisCount = 0;
  let firstFrameAt: number | null = null;
  let lastFrameAt = 0;

  const tvgRaceIds = target.map((e) => e.tvgRaceId);

  console.log('\n[probe] Opening WS subscription...');
  const unsubscribe = await subscribeRaceUpdates(
    session.page,
    tvgRaceIds,
    (update) => {
      frameCount++;
      lastFrameAt = Date.now();
      if (firstFrameAt === null) firstFrameAt = lastFrameAt;
      try {
        const a = ingestRaceUpdate(update, {
          takeoutPlace: cfg.takeoutPlace,
          takeoutShow: cfg.takeoutShow,
          leanThreshold: cfg.signalLeanThreshold,
          driftThreshold: cfg.signalDriftThreshold,
        });
        analysisCount++;
        const signals = a.rows.filter((r) => r.signal !== 'none');
        const sigSummary =
          signals.length > 0
            ? signals.map((s) => `#${s.program}:${s.signal}`).join(' ')
            : '(no signals)';
        console.log(
          `  [#${frameCount}] ${update.id.padEnd(12)} mtp=${String(update.mtp ?? '?').padStart(4)} status=${update.status?.code ?? '?'} → ${a.rows.length} rows, ${sigSummary}`,
        );
      } catch (err) {
        console.warn(
          `  [#${frameCount}] ${update.id} → ingest failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    },
  );

  // Start keepalive — without this, FDR idle-times the session within ~60s
  // and the WS stops receiving updates even though it's still connected.
  const keepalive = startKeepalive(session, 30_000);
  console.log(`[probe] Subscription open. Listening for ${RUN_SECONDS} s (keepalive every 30s)...\n`);

  // ── 4. Wait, with periodic heartbeat so the probe doesn't look hung ────────
  const heartbeatHandle = setInterval(() => {
    console.log(
      `[probe] heartbeat — frames=${frameCount}, analyses=${analysisCount}, cached races=${listRaces().length}`,
    );
  }, 15_000);
  await new Promise<void>((r) => setTimeout(r, RUN_SECONDS * 1000));
  clearInterval(heartbeatHandle);

  // ── 5. Cleanup + summary ───────────────────────────────────────────────────
  console.log('\n[probe] Unsubscribing...');
  keepalive.stop();
  await unsubscribe().catch(() => undefined);

  const cached = listRaces();
  console.log('\n======================================================================');
  console.log(' Summary');
  console.log('======================================================================');
  console.log(`  Frames received      : ${frameCount}`);
  console.log(`  Analyses cached      : ${analysisCount}`);
  console.log(`  Distinct races cached: ${cached.length}`);
  if (firstFrameAt && frameCount >= 2) {
    const span = (lastFrameAt - firstFrameAt) / 1000;
    console.log(`  Time first→last     : ${span.toFixed(1)} s`);
    console.log(`  Mean inter-frame Δt : ${(span / (frameCount - 1)).toFixed(2)} s`);
  }

  console.log('\n  Cached races:');
  for (const a of cached) {
    const signals = a.rows.filter((r) => r.signal !== 'none').length;
    console.log(
      `   ${a.race.raceId.padEnd(12)} status=${a.race.status.padEnd(8)} probSource=${a.probSource.padEnd(15)} signals=${signals}`,
    );
  }

  if (frameCount === 0) {
    console.log('\n[probe] ⚠ No frames received. Possible causes:');
    console.log('  - WS subprotocol mismatch (try editing scripts/test-subscription.ts');
    console.log('    and the page.evaluate inside lib/scraper/poller.ts to send');
    console.log('    `graphql-ws` instead of `graphql-transport-ws`).');
    console.log('  - Session expired — re-run `pnpm run login`.');
    console.log('  - Selected races have no live activity at this minute.');
  } else {
    console.log('\n[probe] ✅ Live pipeline is working end-to-end.');
  }

  await session.close();
  process.exit(0);
})();

// ── helpers ──────────────────────────────────────────────────────────────────

function peekFrameType(text: string): string | null {
  try {
    const obj = JSON.parse(text) as { type?: string };
    return typeof obj.type === 'string' ? obj.type : null;
  } catch {
    return null;
  }
}

function peekOperationName(text: string): string | null {
  try {
    const obj = JSON.parse(text) as { payload?: { operationName?: string } };
    return obj.payload?.operationName ?? null;
  } catch {
    return null;
  }
}
