import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const scraperEnabled = process.env.ENABLE_SCRAPER === 'true';

interface AddTrackBody {
  url?: string;
  trackCode?: string;
}

interface RemoveTrackBody {
  trackCode: string;
}

export async function POST(req: Request) {
  if (!scraperEnabled) {
    return NextResponse.json(
      { error: 'Track management not available in viewer mode' },
      { status: 503 },
    );
  }

  let body: AddTrackBody;
  try {
    body = (await req.json()) as AddTrackBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  let trackCode: string | null = null;
  let raceNumberHint: number | null = null;

  if (typeof body.url === 'string' && body.url.trim().length > 0) {
    const { parseFanDuelUrl } = await import('../../../lib/scraper/url-parser');
    const parsed = parseFanDuelUrl(body.url);
    if (!parsed) {
      return NextResponse.json(
        { error: `Could not parse a FanDuel track URL out of "${body.url}".` },
        { status: 400 },
      );
    }
    trackCode = parsed.trackCode;
    raceNumberHint = parsed.raceNumber;
  } else if (typeof body.trackCode === 'string' && body.trackCode.trim().length > 0) {
    trackCode = body.trackCode.trim().toUpperCase();
  } else {
    return NextResponse.json(
      { error: 'Provide either { url } or { trackCode }.' },
      { status: 400 },
    );
  }

  try {
    const { scraperRuntime } = await import('../../../lib/scraper/runtime');
    const trackedTracks = await scraperRuntime.addTrack(trackCode);
    return NextResponse.json({
      ok: true,
      trackCode,
      raceNumberHint,
      trackedTracks,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not add ${trackCode}: ${msg}` },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  if (!scraperEnabled) {
    return NextResponse.json(
      { error: 'Track management not available in viewer mode' },
      { status: 503 },
    );
  }

  let body: RemoveTrackBody;
  try {
    body = (await req.json()) as RemoveTrackBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body.trackCode !== 'string' || body.trackCode.trim().length === 0) {
    return NextResponse.json({ error: 'trackCode required' }, { status: 400 });
  }
  try {
    const { scraperRuntime } = await import('../../../lib/scraper/runtime');
    const trackedTracks = await scraperRuntime.removeTrack(body.trackCode);
    return NextResponse.json({ ok: true, trackedTracks });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not remove ${body.trackCode}: ${msg}` },
      { status: 400 },
    );
  }
}
