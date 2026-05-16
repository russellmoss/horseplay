import * as fs from 'fs';
import * as path from 'path';
import type { RaceAnalysis } from './types';
import type { BetSettlement, LockedBetPlan, ModelKey } from './simulation/types';
import type { upsertRaceToDb as UpsertFn } from './db';

let dbUpsert: typeof UpsertFn | null = null;
if (process.env.DATABASE_URL) {
  import('./db').then((mod) => {
    dbUpsert = mod.upsertRaceToDb;
  }).catch(() => {});
}

/**
 * In-memory cache of the most recent RaceAnalysis per race. Last-write-wins
 * keyed by raceId, per IMPLEMENTATION.md §10. Refreshes are 5–15 s apart
 * and the math layer is deterministic, so no locking is needed.
 *
 * Hoisted to `globalThis` for the same reason as `scraperRuntime`: Next.js
 * dev mode evaluates the same module in multiple loader contexts (server
 * components / route handlers / instrumentation), and we need a single Map
 * shared across all of them. Production builds don't need this but it's a
 * harmless no-op there.
 */
const STORE_KEY = Symbol.for('derbyEdge.store.v1');
type GlobalWithStore = { [STORE_KEY]?: Map<string, RaceAnalysis> };
const g = globalThis as GlobalWithStore;
if (!g[STORE_KEY]) {
  g[STORE_KEY] = new Map<string, RaceAnalysis>();
}
const store: Map<string, RaceAnalysis> = g[STORE_KEY];

export function upsertRace(analysis: RaceAnalysis): void {
  store.set(analysis.race.raceId, analysis);
  if (dbUpsert) {
    dbUpsert(analysis).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[derby-edge] DB write-through failed:', msg);
    });
  }
}

export function getRace(raceId: string): RaceAnalysis | null {
  return store.get(raceId) ?? null;
}

export function listRaces(): RaceAnalysis[] {
  return [...store.values()];
}

export function listRacesByTrack(trackCode: string): RaceAnalysis[] {
  return listRaces().filter((a) => a.race.trackCode === trackCode);
}

export function removeRace(raceId: string): boolean {
  return store.delete(raceId);
}

export function clearStore(): void {
  store.clear();
}

export function storeSize(): number {
  return store.size;
}

// ── Locked recommendations ───────────────────────────────────────────────
// Captured at T-1:00 (or T-2:00 for voice picks) so we can review post-race
// what the AI advised vs what actually happened. Persists in memory across
// dashboard polls but is lost on `pnpm dev` restart — fine for v1.

export interface LockedRecommendation {
  raceId: string;
  /** ISO timestamp when this snapshot was taken. */
  lockedAt: string;
  /** The "🎯 Bet recommendation" longer paragraph. */
  fullText?: string;
  /** Budget the longer recommendation was generated against. */
  fullBudget?: number;
  /** The short voice pick (~one sentence). */
  voiceText?: string;
  /** Approximate MTP (seconds) at the moment of lock. Useful for sanity-check. */
  mtpAtLockSec?: number;
  /**
   * Structured bet plan at T-1:00 — the simulation tickets we'd have placed.
   * For backward compatibility this points to the Harville-model plan; the
   * dashboard UI reads from this field. The full per-model breakdown lives
   * in `betPlanByModel`.
   */
  betPlan?: LockedBetPlan;
  /** Settlement of the legacy `betPlan` (Harville). */
  settlement?: BetSettlement;
  /**
   * Per-model bet plans. We generate one plan per model at lock time so we
   * can A/B compare post-race P&L between Harville and Henery without
   * changing the live signal classifier. Both plans use the same budget
   * and the same official results to settle.
   */
  betPlanByModel?: Partial<Record<ModelKey, LockedBetPlan>>;
  /** Per-model settlements, one per `betPlanByModel` entry. */
  settlementByModel?: Partial<Record<ModelKey, BetSettlement>>;
  /**
   * RaceAnalysis snapshot at the moment of lock. The historical evaluator
   * (scripts/evaluate-history.ts) joins this to settled outcomes to build the
   * per-(race × horse × model) calibration / EV / ROI CSV. The live in-memory
   * store gets overwritten on every refresh, so without this snapshot the
   * model probabilities and edges that the AI was reasoning over at T-1:00
   * are lost the moment the next poll lands.
   *
   * Optional for back-compat: records persisted before this field was added
   * will not have it, and the evaluator handles missing analysis by emitting
   * ticket-level rows with model-prob columns blank.
   */
  analysis?: RaceAnalysis;
}

const LOCKED_REC_KEY = Symbol.for('derbyEdge.lockedRecs.v1');
type GlobalWithLockedRecs = { [LOCKED_REC_KEY]?: Map<string, LockedRecommendation> };
const gLocked = globalThis as GlobalWithLockedRecs;

// Disk persistence so locked plans + settlements survive `pnpm dev` restarts.
// Writes are best-effort: any I/O error is swallowed to avoid breaking the
// in-memory hot path. v1 keeps everything in one JSON file; if this gets
// big we can shard by date.
const LOCKED_RECS_FILE = path.join(process.cwd(), 'data', 'locked-recs.json');

function loadLockedRecsFromDisk(): Map<string, LockedRecommendation> {
  try {
    if (!fs.existsSync(LOCKED_RECS_FILE)) return new Map();
    const raw = fs.readFileSync(LOCKED_RECS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as LockedRecommendation[];
    if (!Array.isArray(parsed)) return new Map();
    const m = new Map<string, LockedRecommendation>();
    for (const rec of parsed) {
      if (rec && typeof rec.raceId === 'string') m.set(rec.raceId, rec);
    }
    return m;
  } catch {
    return new Map();
  }
}

function saveLockedRecsToDisk(): void {
  try {
    const dir = path.dirname(LOCKED_RECS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const arr = [...lockedRecs.values()];
    fs.writeFileSync(LOCKED_RECS_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch {
    // ignore — disk is best-effort, in-memory remains authoritative
  }
}

if (!gLocked[LOCKED_REC_KEY]) {
  gLocked[LOCKED_REC_KEY] = loadLockedRecsFromDisk();
}
const lockedRecs: Map<string, LockedRecommendation> = gLocked[LOCKED_REC_KEY];

/**
 * Merge fields onto the locked recommendation for a race. The caller may
 * provide just `voiceText` (from the voice pick) OR just `fullText` (from
 * the longer recommendation lock at T-1:00); we keep both in one record.
 * The first lock sets `lockedAt`; subsequent merges don't overwrite it.
 */
export function lockRecommendation(
  raceId: string,
  patch: Partial<Omit<LockedRecommendation, 'raceId' | 'lockedAt'>> & {
    /** When provided, overrides the auto-now timestamp on first lock. */
    lockedAt?: string;
  },
): LockedRecommendation {
  const existing = lockedRecs.get(raceId);
  // Merge per-model maps so a patch carrying only one model preserves the
  // other side. Same shallow-merge convention as the other patch fields.
  const mergedBetPlanByModel = (() => {
    const a = existing?.betPlanByModel ?? {};
    const b = patch.betPlanByModel ?? {};
    const out: Partial<Record<ModelKey, LockedBetPlan>> = { ...a, ...b };
    return Object.keys(out).length > 0 ? out : undefined;
  })();
  const mergedSettlementByModel = (() => {
    const a = existing?.settlementByModel ?? {};
    const b = patch.settlementByModel ?? {};
    const out: Partial<Record<ModelKey, BetSettlement>> = { ...a, ...b };
    return Object.keys(out).length > 0 ? out : undefined;
  })();
  const merged: LockedRecommendation = {
    raceId,
    lockedAt: existing?.lockedAt ?? patch.lockedAt ?? new Date().toISOString(),
    fullText: patch.fullText ?? existing?.fullText,
    fullBudget: patch.fullBudget ?? existing?.fullBudget,
    voiceText: patch.voiceText ?? existing?.voiceText,
    mtpAtLockSec: patch.mtpAtLockSec ?? existing?.mtpAtLockSec,
    betPlan: patch.betPlan ?? existing?.betPlan,
    settlement: patch.settlement ?? existing?.settlement,
    betPlanByModel: mergedBetPlanByModel,
    settlementByModel: mergedSettlementByModel,
    // Take a fresh snapshot whenever a patch provides one (the lock endpoints
    // call this at T-1:00 with the analysis as of that moment). Once recorded,
    // do NOT overwrite with a later snapshot — we want the AT-LOCK state, not
    // a moving target as the pools continue to update toward post.
    analysis: existing?.analysis ?? patch.analysis,
  };
  lockedRecs.set(raceId, merged);
  saveLockedRecsToDisk();
  return merged;
}

export function getLockedRecommendation(
  raceId: string,
): LockedRecommendation | null {
  return lockedRecs.get(raceId) ?? null;
}

export function listLockedRecommendations(): LockedRecommendation[] {
  return [...lockedRecs.values()];
}

export function clearLockedRecommendations(): void {
  lockedRecs.clear();
  saveLockedRecsToDisk();
}

/**
 * Aggregate session-level P&L totals across all currently-settled bet plans.
 * Used by the per-race export to surface a "you're up $X across the day so
 * far" line above the per-race breakdown. Optional filters scope by track
 * code and/or post-time date prefix (yyyy-mm-dd).
 */
export interface SessionTotalsAgg {
  racesSettled: number;
  totalStake: number;
  totalReturn: number;
  totalProfit: number;
  cashedTickets: number;
  totalTickets: number;
}

export function computeSessionTotals(filter?: {
  trackCode?: string;
  postDate?: string;
}): SessionTotalsAgg {
  let racesSettled = 0;
  let totalStake = 0;
  let totalReturn = 0;
  let cashedTickets = 0;
  let totalTickets = 0;
  for (const rec of lockedRecs.values()) {
    if (!rec.settlement) continue;
    if (filter?.trackCode || filter?.postDate) {
      const race = store.get(rec.raceId);
      if (!race) continue;
      if (filter.trackCode && race.race.trackCode !== filter.trackCode) continue;
      if (filter.postDate && !race.race.postTimeUtc.startsWith(filter.postDate)) continue;
    }
    racesSettled += 1;
    totalStake += rec.settlement.totalStake;
    totalReturn += rec.settlement.totalReturn;
    cashedTickets += rec.settlement.tickets.filter((t) => t.cashed).length;
    totalTickets += rec.settlement.tickets.length;
  }
  return {
    racesSettled,
    totalStake,
    totalReturn,
    totalProfit: totalReturn - totalStake,
    cashedTickets,
    totalTickets,
  };
}
