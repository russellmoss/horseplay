import { NextResponse } from 'next/server';
import {
  getRace,
  getLockedRecommendation,
  lockRecommendation,
} from '../../../../lib/store';
import { generateRecommendation } from '../../../../lib/ai/recommend';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/lock-recommendation/[raceId]
 *
 * Captures a snapshot of the AI's "🎯 Bet recommendation" for the race and
 * pins it to the locked-recommendation record. Idempotent — if a full
 * recommendation has already been locked for this race, returns the existing
 * one unchanged so client double-fires don't burn extra Anthropic calls.
 *
 * Optional body: { budget: number } — defaults to $20.
 */
interface LockRequestBody {
  budget?: number;
}

export async function POST(
  req: Request,
  { params }: { params: { raceId: string } },
) {
  const { raceId } = params;
  if (!raceId) {
    return NextResponse.json({ error: 'raceId required' }, { status: 400 });
  }

  let body: LockRequestBody = {};
  try {
    body = (await req.json()) as LockRequestBody;
  } catch {
    // Empty body is fine — fall back to defaults.
  }
  const budget = Math.max(2, Math.floor(body.budget ?? 20));

  const analysis = getRace(raceId);
  if (!analysis) {
    return NextResponse.json(
      { error: `No cached analysis for race ${raceId}` },
      { status: 404 },
    );
  }

  // Idempotency: if we already have a full recommendation locked for this
  // race, return it without re-generating.
  const existing = getLockedRecommendation(raceId);
  if (existing?.fullText) {
    return NextResponse.json({
      locked: true,
      cached: true,
      record: existing,
    });
  }

  // Generate the recommendation against the full race set (so the model can
  // still reason cross-race), but anchored to this raceId.
  let recText: string;
  try {
    const rec = await generateRecommendation([analysis], { raceId, budget });
    recText = rec.text;
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not generate recommendation: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  const mtpSec = Math.round(
    (Date.parse(analysis.race.postTimeUtc) - Date.now()) / 1000,
  );
  const record = lockRecommendation(raceId, {
    fullText: recText,
    fullBudget: budget,
    mtpAtLockSec: Number.isFinite(mtpSec) ? mtpSec : undefined,
    // Persist the analysis snapshot so the historical evaluator can recover
    // the per-horse model state at lock time. Stored once; later calls to
    // lockRecommendation for this race preserve the earlier snapshot.
    analysis,
  });

  return NextResponse.json({
    locked: true,
    cached: false,
    record,
  });
}

/** GET — peek at the current locked record without generating one. */
export async function GET(
  _req: Request,
  { params }: { params: { raceId: string } },
) {
  const { raceId } = params;
  if (!raceId) {
    return NextResponse.json({ error: 'raceId required' }, { status: 400 });
  }
  const record = getLockedRecommendation(raceId);
  if (!record) {
    return NextResponse.json(
      { error: `No locked recommendation for race ${raceId}` },
      { status: 404 },
    );
  }
  return NextResponse.json({ record });
}
