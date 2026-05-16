import { NextResponse } from 'next/server';
import {
  getRace,
  getLockedRecommendation,
  lockRecommendation,
} from '../../../../lib/store';
import { generateBetPlan, type BetPlanResult } from '../../../../lib/ai/bet-planner';
import type {
  BetTicket,
  LockedBetPlan,
  ModelKey,
} from '../../../../lib/simulation/types';
import type { Race } from '../../../../lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/lock-bet-plan/[raceId]
 *
 * Auto-fired at T-1:00 by the dashboard. Generates a structured bet plan
 * via Claude (tool-call enforced JSON), validates the result against the
 * pool-size guardrails and the user-supplied budget cap (default $20), and
 * pins it to the locked-rec record. Idempotent: returns the existing plan
 * unchanged if one is already locked.
 *
 * Optional body: { budget: number } — defaults to $20.
 */

const DEFAULT_STAKE_CAP = 20;
const EXACTA_MIN_POOL = 1000;
const TRIFECTA_MIN_POOL = 3000;

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
    // Empty body is fine — fall back to the default budget cap.
  }
  const stakeCap = Math.max(2, Math.floor(body.budget ?? DEFAULT_STAKE_CAP));

  const analysis = getRace(raceId);
  if (!analysis) {
    return NextResponse.json(
      { error: `No cached analysis for race ${raceId}` },
      { status: 404 },
    );
  }

  // Idempotency: if BOTH model plans are already locked, return cached.
  const existing = getLockedRecommendation(raceId);
  const cachedHarville = existing?.betPlanByModel?.harville ?? existing?.betPlan;
  const cachedHenery = existing?.betPlanByModel?.henery;
  if (cachedHarville && cachedHenery) {
    return NextResponse.json({
      locked: true,
      cached: true,
      plan: cachedHarville,
      plansByModel: { harville: cachedHarville, henery: cachedHenery },
    });
  }

  // Generate the two model plans in parallel — same race, same budget,
  // different fair-price/edge inputs. Both go through identical validation.
  const r = analysis.race;
  const lockedAt = new Date().toISOString();

  let harvillePlan: BetPlanResult | null = null;
  let heneryPlan: BetPlanResult | null = null;
  try {
    const settled = await Promise.all([
      cachedHarville
        ? Promise.resolve<BetPlanResult>({
            rationale: cachedHarville.rationale,
            tickets: cachedHarville.tickets,
            totalStake: cachedHarville.totalStake,
            model: 'harville',
          })
        : generateBetPlan({ analysis, budget: stakeCap, model: 'harville' }),
      cachedHenery
        ? Promise.resolve<BetPlanResult>({
            rationale: cachedHenery.rationale,
            tickets: cachedHenery.tickets,
            totalStake: cachedHenery.totalStake,
            model: 'henery',
          })
        : generateBetPlan({ analysis, budget: stakeCap, model: 'henery' }),
    ]);
    harvillePlan = settled[0];
    heneryPlan = settled[1];
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not generate bet plan: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  const harvilleLocked = cachedHarville
    ? cachedHarville
    : finalizeLocked(raceId, lockedAt, harvillePlan, r, stakeCap);
  const heneryLocked = cachedHenery
    ? cachedHenery
    : finalizeLocked(raceId, lockedAt, heneryPlan, r, stakeCap);

  const mtpSec = Math.round(
    (Date.parse(analysis.race.postTimeUtc) - Date.now()) / 1000,
  );
  lockRecommendation(raceId, {
    // Legacy alias — dashboard UI reads `betPlan`. Keep pointing to Harville.
    betPlan: harvilleLocked,
    betPlanByModel: {
      harville: harvilleLocked,
      henery: heneryLocked,
    },
    mtpAtLockSec: Number.isFinite(mtpSec) ? mtpSec : undefined,
    // Persist the analysis snapshot so the historical evaluator
    // (scripts/evaluate-history.ts) can recover the per-horse model
    // probabilities and edges the AI was reasoning over at lock time.
    analysis,
  });

  return NextResponse.json({
    locked: true,
    cached: false,
    plan: harvilleLocked,
    plansByModel: {
      harville: harvilleLocked,
      henery: heneryLocked,
    },
  });
}

/**
 * Apply server-side validation and budget-cap clipping to a planner result,
 * then wrap it as a `LockedBetPlan` ready to store. Identical guardrails to
 * the previous single-plan path; factored so we can run it once per model.
 */
function finalizeLocked(
  raceId: string,
  lockedAt: string,
  plan: BetPlanResult,
  race: Race,
  stakeCap: number,
): LockedBetPlan {
  const validatedTickets: BetTicket[] = [];
  const droppedNotes: string[] = [];
  let runningTotal = 0;
  const scratchedSet = new Set(
    race.horses.filter((h) => h.scratched).map((h) => h.program),
  );
  for (const t of plan.tickets) {
    if (t.type === 'exacta_straight' || t.type === 'exacta_box') {
      if (!race.totalExactaPool || race.totalExactaPool < EXACTA_MIN_POOL) {
        droppedNotes.push(
          `dropped ${t.type} on horses ${t.horses.join(',')} — exacta pool ${race.totalExactaPool ? `$${race.totalExactaPool.toLocaleString()}` : 'unknown'} below $${EXACTA_MIN_POOL.toLocaleString()} guardrail`,
        );
        continue;
      }
    }
    if (t.type === 'trifecta_straight' || t.type === 'trifecta_box') {
      if (!race.totalTrifectaPool || race.totalTrifectaPool < TRIFECTA_MIN_POOL) {
        droppedNotes.push(
          `dropped ${t.type} on horses ${t.horses.join(',')} — trifecta pool ${race.totalTrifectaPool ? `$${race.totalTrifectaPool.toLocaleString()}` : 'unknown'} below $${TRIFECTA_MIN_POOL.toLocaleString()} guardrail`,
        );
        continue;
      }
    }
    if (!Number.isFinite(t.amount) || t.amount < 2 || !Number.isInteger(t.amount)) {
      droppedNotes.push(
        `dropped ${t.type} on horses ${t.horses.join(',')} — invalid amount ${t.amount}`,
      );
      continue;
    }
    if (t.horses.some((p) => scratchedSet.has(p))) {
      droppedNotes.push(
        `dropped ${t.type} on horses ${t.horses.join(',')} — includes scratched horse`,
      );
      continue;
    }
    if (runningTotal + t.amount > stakeCap) {
      const remaining = stakeCap - runningTotal;
      if (remaining < 2) {
        droppedNotes.push(
          `dropped ${t.type} on horses ${t.horses.join(',')} — $${stakeCap} cap reached`,
        );
        continue;
      }
      validatedTickets.push({ ...t, amount: remaining });
      runningTotal += remaining;
      droppedNotes.push(
        `trimmed ${t.type} on horses ${t.horses.join(',')} from $${t.amount} to $${remaining} to fit $${stakeCap} cap`,
      );
      break;
    }
    validatedTickets.push(t);
    runningTotal += t.amount;
  }

  const totalStake = validatedTickets.reduce((a, t) => a + t.amount, 0);
  const finalRationale =
    droppedNotes.length > 0
      ? `${plan.rationale}\n\nServer adjustments: ${droppedNotes.join('; ')}.`
      : plan.rationale;

  return {
    raceId,
    lockedAt,
    tickets: validatedTickets,
    totalStake,
    rationale: finalRationale,
    model: plan.model,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: { raceId: string } },
) {
  const { raceId } = params;
  if (!raceId) {
    return NextResponse.json({ error: 'raceId required' }, { status: 400 });
  }
  const rec = getLockedRecommendation(raceId);
  if (!rec?.betPlan) {
    return NextResponse.json(
      { error: `No bet plan locked for race ${raceId}` },
      { status: 404 },
    );
  }
  return NextResponse.json({ plan: rec.betPlan });
}
