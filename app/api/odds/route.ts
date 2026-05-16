import { NextResponse } from 'next/server';
import { listRacesFromDb, listTrackedTracks } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const scraperEnabled = process.env.ENABLE_SCRAPER === 'true';

export async function GET() {
  if (scraperEnabled) {
    const { listRaces } = await import('../../../lib/store');
    const { scraperRuntime } = await import('../../../lib/scraper/runtime');
    const races = listRaces();
    const status = scraperRuntime.status();
    return NextResponse.json({ status, races, count: races.length });
  }

  const [races, trackedTracks] = await Promise.all([
    listRacesFromDb(),
    listTrackedTracks(),
  ]);

  const trackCounts: Record<string, number> = {};
  for (const r of races) {
    const tc = r?.race?.trackCode ?? 'UNKNOWN';
    trackCounts[tc] = (trackCounts[tc] ?? 0) + 1;
  }

  return NextResponse.json(
    {
      status: {
        state: 'remote',
        message: 'Viewer mode — data from operator scraper',
        startedAt: null,
        lastFrameAt: null,
        framesReceived: 0,
        analysesCached: races.length,
        lastError: null,
        botChallengePending: false,
        botChallengeDetectedAt: null,
        trackedTracks,
      },
      races,
      count: races.length,
      _debug: { trackCounts },
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'CDN-Cache-Control': 'no-store',
        'Vercel-CDN-Cache-Control': 'no-store',
      },
    },
  );
}
