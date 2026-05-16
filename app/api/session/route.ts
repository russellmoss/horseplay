import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const scraperEnabled = process.env.ENABLE_SCRAPER === 'true';

export async function GET() {
  if (scraperEnabled) {
    const { scraperRuntime } = await import('../../../lib/scraper/runtime');
    const status = scraperRuntime.status();
    const healthy = status.state === 'running';
    return NextResponse.json({ healthy, status });
  }

  return NextResponse.json({
    healthy: true,
    status: {
      state: 'remote',
      message: 'Viewer mode — scraper runs on operator machine',
      startedAt: null,
      lastFrameAt: null,
      framesReceived: 0,
      analysesCached: 0,
      lastError: null,
      botChallengePending: false,
      botChallengeDetectedAt: null,
      trackedTracks: [],
    },
  });
}
