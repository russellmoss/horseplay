import { NextResponse } from 'next/server';
import { getRaceAny } from '../../../lib/race-data';
import { generateBetPlan } from '../../../lib/ai/bet-planner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/bet-plan?raceId=CD-7&budget=20
 *
 * Preview-only structured bet plan for the race. Does NOT lock the plan into
 * the locked-recommendation record — that's what /api/lock-bet-plan is for,
 * fired automatically at T-1:00. This endpoint exists so the on-screen panel
 * can show what the AI is currently thinking at any budget the user picks.
 *
 * 30-second in-memory cache, keyed by (raceId, budget). POST forces a fresh
 * call.
 */

const CACHE_KEY = Symbol.for('derbyEdge.betPlanPreviewCache.v1');
type CacheEntry = {
  result: { rationale: string; tickets: unknown[]; totalStake: number; budget: number; raceId: string };
  cachedAt: number;
};
type GlobalWithCache = { [CACHE_KEY]?: Map<string, CacheEntry> };
const g = globalThis as GlobalWithCache;
if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map();
const cache = g[CACHE_KEY];

const CACHE_TTL_MS = 30_000;

function parseParams(url: URL): { raceId: string | null; budget: number } {
  const raceId = url.searchParams.get('raceId');
  const budgetRaw = url.searchParams.get('budget');
  let budget = 20;
  if (budgetRaw) {
    const n = Number(budgetRaw);
    if (Number.isFinite(n) && n >= 2) budget = Math.floor(n);
  }
  return { raceId: raceId && raceId.trim() ? raceId.trim() : null, budget };
}

async function fetchFresh(raceId: string, budget: number) {
  const analysis = await getRaceAny(raceId);
  if (!analysis) {
    return { error: `No cached analysis for race ${raceId}`, status: 404 as const };
  }
  const plan = await generateBetPlan({ analysis, budget });
  return {
    raceId,
    budget,
    rationale: plan.rationale,
    tickets: plan.tickets,
    totalStake: plan.totalStake,
  };
}

async function handle(req: Request, force: boolean) {
  const url = new URL(req.url);
  const { raceId, budget } = parseParams(url);
  if (!raceId) {
    return NextResponse.json({ error: 'raceId required' }, { status: 400 });
  }
  const key = `${raceId}::${budget}`;
  const now = Date.now();
  if (!force) {
    const hit = cache.get(key);
    if (hit && now - hit.cachedAt < CACHE_TTL_MS) {
      return NextResponse.json({ ...hit.result, cached: true, cachedAgeMs: now - hit.cachedAt });
    }
  }
  try {
    const result = await fetchFresh(raceId, budget);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    cache.set(key, { result, cachedAt: now });
    return NextResponse.json({ ...result, cached: false, cachedAgeMs: 0 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function GET(req: Request) {
  return handle(req, false);
}

export async function POST(req: Request) {
  return handle(req, true);
}
