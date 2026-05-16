import { NextResponse } from 'next/server';
import {
  getLockedRecommendation,
  listRaces,
  lockRecommendation,
} from '../../../lib/store';
import { generateBetPlan } from '../../../lib/ai/bet-planner';
import { settleBetPlan } from '../../../lib/simulation/settle';
import { generatePostRaceNarrative } from '../../../lib/ai/post-race-narrative';
import type { BetTicket, LockedBetPlan } from '../../../lib/simulation/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300; // 14 races × ~5s each can run long

/**
 * POST /api/backfill-day?trackCode=BEL&date=2026-05-03
 *
 * For each cached race on the requested track + date:
 *   1. If no betPlan locked → generate one with generateBetPlan
 *   2. If race is official and unsettled → run settleBetPlan
 *   3. If settled but no narrative → generate one
 *
 * Idempotent. Skips races that already have everything. Returns a summary
 * with one entry per race describing what happened.
 *
 * NOTE: The bet planner sees CURRENT pool data, not what the pools were at
 * T-1:00. For races that finished hours ago, pool snapshots are typically
 * still present (FDR doesn't clear them), but this is "near-T-1:00" not
 * exact. Acceptable for retro analysis.
 */

const STAKE_CAP = 20;
const EXACTA_MIN_POOL = 1000;
const TRIFECTA_MIN_POOL = 3000;

interface RaceBackfillResult {
  raceId: string;
  raceLabel: string;
  status: string;
  generatedPlan: boolean;
  settled: boolean;
  generatedNarrative: boolean;
  alreadyComplete: boolean;
  skipReason?: string;
  error?: string;
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const trackCode = url.searchParams.get('trackCode')?.trim().toUpperCase();
  const postDate =
    url.searchParams.get('date')?.trim() ?? new Date().toISOString().slice(0, 10);

  if (!trackCode) {
    return NextResponse.json({ error: 'trackCode required' }, { status: 400 });
  }

  const dayRaces = listRaces().filter(
    (a) =>
      a.race.trackCode === trackCode &&
      a.race.postTimeUtc.startsWith(postDate),
  );
  if (dayRaces.length === 0) {
    return NextResponse.json(
      {
        error: `No cached races for ${trackCode} on ${postDate}.`,
      },
      { status: 404 },
    );
  }

  const results: RaceBackfillResult[] = [];
  for (const analysis of dayRaces) {
    const raceLabel = `${analysis.race.trackCode} R${analysis.race.raceNumber}`;
    const raceId = analysis.race.raceId;
    const result: RaceBackfillResult = {
      raceId,
      raceLabel,
      status: analysis.race.status,
      generatedPlan: false,
      settled: false,
      generatedNarrative: false,
      alreadyComplete: false,
    };

    try {
      const existing = getLockedRecommendation(raceId);
      const hasResults =
        analysis.race.results !== null &&
        analysis.race.results !== undefined &&
        analysis.race.results.runners.length > 0;
      const hasPlan = !!existing?.betPlan;
      const hasSettlement = !!existing?.settlement;
      const hasNarrative = !!existing?.betPlan?.postRaceNarrative;

      // Skip when fully done.
      if (hasPlan && (!hasResults || (hasSettlement && hasNarrative))) {
        result.alreadyComplete = true;
        results.push(result);
        continue;
      }

      // Step 1: lock a plan if there isn't one.
      if (!hasPlan) {
        // Sanity check: do we have ANY pool data? If not, the planner won't
        // produce anything useful — skip with a note.
        if (
          !analysis.race.totalWinPool &&
          !analysis.race.totalPlacePool &&
          !analysis.race.totalShowPool
        ) {
          result.skipReason = 'no pool data cached for this race';
          results.push(result);
          continue;
        }
        const plan = await generateBetPlan({ analysis });
        const validated = validatePlan(plan, analysis);
        const locked: LockedBetPlan = {
          raceId,
          lockedAt: new Date().toISOString(),
          tickets: validated.tickets,
          totalStake: validated.totalStake,
          rationale: validated.rationale,
        };
        lockRecommendation(raceId, { betPlan: locked });
        result.generatedPlan = true;
      }

      // Re-fetch to get the freshest record (post-plan-lock above).
      const fresh = getLockedRecommendation(raceId);
      if (!fresh?.betPlan) {
        result.skipReason = 'plan disappeared after lock — bug?';
        results.push(result);
        continue;
      }

      // Step 2: settle if race is official and not yet settled.
      if (hasResults && !fresh.settlement) {
        const settlement = settleBetPlan(fresh.betPlan, analysis.race);
        if (settlement) {
          lockRecommendation(raceId, { settlement });
          result.settled = true;
        }
      }

      // Step 3: narrate if we have a settlement and no narrative yet.
      const afterSettle = getLockedRecommendation(raceId);
      if (
        afterSettle?.settlement &&
        afterSettle.betPlan &&
        !afterSettle.betPlan.postRaceNarrative
      ) {
        const narrative = await generatePostRaceNarrative({
          analysis,
          plan: afterSettle.betPlan,
          settlement: afterSettle.settlement,
        });
        const updated: LockedBetPlan = {
          ...afterSettle.betPlan,
          postRaceNarrative: narrative,
          postRaceNarrativeAt: new Date().toISOString(),
        };
        lockRecommendation(raceId, { betPlan: updated });
        result.generatedNarrative = true;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    results.push(result);
  }

  return NextResponse.json({
    trackCode,
    postDate,
    total: results.length,
    results,
  });
}

/** Server-side validator (mirrors the lock-bet-plan endpoint). */
function validatePlan(
  plan: { rationale: string; tickets: BetTicket[]; totalStake: number },
  analysis: { race: { totalExactaPool?: number; totalTrifectaPool?: number; horses: Array<{ program: string; scratched: boolean }> } },
): { rationale: string; tickets: BetTicket[]; totalStake: number } {
  const r = analysis.race;
  const validatedTickets: BetTicket[] = [];
  const droppedNotes: string[] = [];
  let runningTotal = 0;
  for (const t of plan.tickets) {
    if (t.type === 'exacta_straight' || t.type === 'exacta_box') {
      if (!r.totalExactaPool || r.totalExactaPool < EXACTA_MIN_POOL) {
        droppedNotes.push(
          `dropped ${t.type} — exacta pool below $${EXACTA_MIN_POOL.toLocaleString()}`,
        );
        continue;
      }
    }
    if (t.type === 'trifecta_straight' || t.type === 'trifecta_box') {
      if (!r.totalTrifectaPool || r.totalTrifectaPool < TRIFECTA_MIN_POOL) {
        droppedNotes.push(
          `dropped ${t.type} — trifecta pool below $${TRIFECTA_MIN_POOL.toLocaleString()}`,
        );
        continue;
      }
    }
    if (!Number.isInteger(t.amount) || t.amount < 2) {
      droppedNotes.push(`dropped ${t.type} — invalid amount ${t.amount}`);
      continue;
    }
    const scratchedSet = new Set(
      r.horses.filter((h) => h.scratched).map((h) => h.program),
    );
    if (t.horses.some((p) => scratchedSet.has(p))) {
      droppedNotes.push(`dropped ${t.type} — includes scratched horse`);
      continue;
    }
    if (runningTotal + t.amount > STAKE_CAP) {
      const remaining = STAKE_CAP - runningTotal;
      if (remaining < 2) {
        droppedNotes.push(`dropped ${t.type} — $${STAKE_CAP} cap reached`);
        continue;
      }
      validatedTickets.push({ ...t, amount: remaining });
      runningTotal += remaining;
      droppedNotes.push(
        `trimmed ${t.type} from $${t.amount} to $${remaining} for cap`,
      );
      break;
    }
    validatedTickets.push(t);
    runningTotal += t.amount;
  }
  const totalStake = validatedTickets.reduce((a, t) => a + t.amount, 0);
  const rationale =
    droppedNotes.length > 0
      ? `${plan.rationale}\n\nServer adjustments: ${droppedNotes.join('; ')}.`
      : plan.rationale;
  return { rationale, tickets: validatedTickets, totalStake };
}
