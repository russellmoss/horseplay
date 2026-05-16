import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const scraperEnabled = process.env.ENABLE_SCRAPER === 'true';

export async function POST() {
  if (!scraperEnabled) {
    return NextResponse.json(
      { error: 'Scraper not available in viewer mode' },
      { status: 503 },
    );
  }

  const { scraperRuntime } = await import('../../../lib/scraper/runtime');
  const status = await scraperRuntime.refresh();
  return NextResponse.json({ status });
}
