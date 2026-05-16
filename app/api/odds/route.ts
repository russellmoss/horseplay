import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';

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
  const races = await db.listRacesFromDb();
  const trackedTracks = await db.listTrackedTracks();

  // Direct DB query for debugging
  let rawTracks: string[] = [];
  try {
    const sql = neon(process.env.DATABASE_URL!);
    const rows = await sql`SELECT track_code FROM tracked_tracks ORDER BY added_at ASC`;
    rawTracks = rows.map((r) => r.track_code as string);
  } catch (e) {
    rawTracks = [`ERROR: ${e instanceof Error ? e.message : String(e)}`];
  }

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
    _debug: { trackedTracks, rawTracks },
  });
}
