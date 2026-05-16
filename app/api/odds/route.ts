import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const scraperEnabled = process.env.ENABLE_SCRAPER === 'true';

async function getTrackedTracksFromDb(): Promise<string[]> {
  const url = process.env.DATABASE_URL;
  if (!url) return [];
  const sql = neon(url);
  const rows = await sql`SELECT track_code FROM tracked_tracks ORDER BY added_at ASC`;
  return rows.map((r) => r.track_code as string);
}

export async function GET() {
  if (scraperEnabled) {
    const { listRaces } = await import('../../../lib/store');
    const { scraperRuntime } = await import('../../../lib/scraper/runtime');
    const races = listRaces();
    const status = scraperRuntime.status();
    return NextResponse.json({ status, races, count: races.length });
  }

  const { listRacesFromDb } = await import('../../../lib/db');
  const [races, trackedTracks] = await Promise.all([
    listRacesFromDb(),
    getTrackedTracksFromDb(),
  ]);
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
  });
}
