import { NextResponse } from 'next/server';

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

  const db = await import('../../../lib/db');
  const [races, trackedTracks] = await Promise.all([
    db.listRacesFromDb(),
    db.listTrackedTracks(),
  ]);
  const debugTrackedTracks = await db.listTrackedTracks();
  return NextResponse.json({
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
    _debug: {
      trackedTracks,
      debugTrackedTracks,
      dbUrl: (process.env.DATABASE_URL ?? '').replace(/:[^@]+@/, ':***@').slice(0, 80),
    },
  });
}
