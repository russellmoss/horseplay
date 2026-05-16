import { NextResponse } from 'next/server';
import { listRaces } from '../../../lib/store';
import {
  generateRecommendation,
  type RecommendationOptions,
  type RecommendationResult,
} from '../../../lib/ai/recommend';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/recommendation                              — global $10 across all open races
 * GET /api/recommendation?budget=20                    — global $20
 * GET /api/recommendation?raceId=CD-7&budget=15        — per-race recommendation
 *
 * 30 s in-memory cache, keyed by (raceId|'all', budget). POST forces a fresh call.
 */

const CACHE_KEY = Symbol.for('derbyEdge.recommendationCache.v2');
type CacheEntry = { result: RecommendationResult; cachedAt: number };
type GlobalWithCache = { [CACHE_KEY]?: Map<string, CacheEntry> };
const g = globalThis as GlobalWithCache;
if (!g[CACHE_KEY]) g[CACHE_KEY] = new Map();
const cache = g[CACHE_KEY];

const CACHE_TTL_MS = 30_000;

function parseOptions(url: URL): RecommendationOptions {
  const raceIdRaw = url.searchParams.get('raceId');
  const budgetRaw = url.searchParams.get('budget');
  const opts: RecommendationOptions = {};
  if (raceIdRaw && raceIdRaw.trim()) opts.raceId = raceIdRaw.trim();
  if (budgetRaw) {
    const n = Number(budgetRaw);
    if (Number.isFinite(n) && n >= 2) opts.budget = Math.floor(n);
  }
  return opts;
}

function cacheKey(opts: RecommendationOptions): string {
  return `${opts.raceId ?? 'all'}::${opts.budget ?? 10}`;
}

async function fetchFresh(opts: RecommendationOptions): Promise<RecommendationResult> {
  const races = listRaces();
  return generateRecommendation(races, opts);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const opts = parseOptions(url);
  const key = cacheKey(opts);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.cachedAt < CACHE_TTL_MS) {
    return NextResponse.json({
      ...hit.result,
      cached: true,
      cachedAgeMs: now - hit.cachedAt,
    });
  }
  const result = await fetchFresh(opts);
  cache.set(key, { result, cachedAt: now });
  return NextResponse.json({ ...result, cached: false, cachedAgeMs: 0 });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const opts = parseOptions(url);
  const key = cacheKey(opts);
  const result = await fetchFresh(opts);
  cache.set(key, { result, cachedAt: Date.now() });
  return NextResponse.json({ ...result, cached: false, cachedAgeMs: 0 });
}
