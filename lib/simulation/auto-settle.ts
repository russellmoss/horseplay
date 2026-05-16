import type { RaceAnalysis } from '../types';
import { getLockedRecommendation, lockRecommendation } from '../store';
import { settleBetPlan } from './settle';
import { generatePostRaceNarrative } from '../ai/post-race-narrative';
import type { BetSettlement, ModelKey } from './types';

/**
 * Settle locked bet plan(s) against official results AND generate the frozen
 * post-race narrative. Called from the poller's ingest path. Idempotent:
 * already-settled and already-narrated races are no-ops.
 *
 * Per-model handling: when `betPlanByModel` is populated (Harville + Henery
 * shadow plans), settle each independently against the same official results
 * and store under `settlementByModel`. The legacy `settlement` field stays
 * pointed at the Harville settlement so existing readers (dashboard P&L
 * widgets, the per-race xlsx export's "settlement" section) work unchanged.
 *
 * The post-race narrative runs ONCE against the Harville plan only — the
 * narrative is qualitative commentary that doesn't really differ between
 * models, and we want to bound LLM cost.
 */
export async function maybeSettleAndNarrate(
  analysis: RaceAnalysis,
): Promise<void> {
  const raceId = analysis.race.raceId;
  const rec = getLockedRecommendation(raceId);
  if (!rec) return;
  if (!rec.betPlan && !rec.betPlanByModel) return;

  // Settle every model that has a plan but no settlement yet.
  const existingByModel = rec.settlementByModel ?? {};
  const updatedByModel: Partial<Record<ModelKey, BetSettlement>> = {
    ...existingByModel,
  };
  let anySettled = false;
  const models: ModelKey[] = ['harville', 'henery'];
  for (const m of models) {
    if (existingByModel[m]) continue;
    const plan = rec.betPlanByModel?.[m] ?? (m === 'harville' ? rec.betPlan : undefined);
    if (!plan) continue;
    const s = settleBetPlan(plan, analysis.race) ?? undefined;
    if (s) {
      updatedByModel[m] = s;
      anySettled = true;
    }
  }

  // Legacy `settlement` field continues to mirror the Harville settlement.
  let settlement: BetSettlement | undefined =
    updatedByModel.harville ?? rec.settlement;
  if (!settlement && rec.betPlan) {
    settlement = settleBetPlan(rec.betPlan, analysis.race) ?? undefined;
    if (settlement) anySettled = true;
  }

  if (anySettled) {
    lockRecommendation(raceId, {
      settlement,
      settlementByModel: updatedByModel,
    });
  }

  // Narrative is keyed off the Harville plan + its settlement. Skip if no
  // Harville plan exists or already narrated.
  const harvillePlan = rec.betPlanByModel?.harville ?? rec.betPlan;
  if (!harvillePlan) return;
  if (settlement && harvillePlan.postRaceNarrative) return;
  if (!settlement) return;

  if (harvillePlan.postRaceNarrative) return;
  let narrative: string;
  try {
    narrative = await generatePostRaceNarrative({
      analysis,
      plan: harvillePlan,
      settlement,
    });
  } catch (err) {
    console.warn(
      'post-race narrative generation failed for',
      raceId,
      ':',
      err instanceof Error ? err.message : err,
    );
    return;
  }
  // Re-fetch to get freshest copy, mutate the (Harville) plan, write back.
  const fresh = getLockedRecommendation(raceId);
  const targetPlan = fresh?.betPlanByModel?.harville ?? fresh?.betPlan;
  if (!targetPlan) return;
  const updated = {
    ...targetPlan,
    postRaceNarrative: narrative,
    postRaceNarrativeAt: new Date().toISOString(),
  };
  // Update both the legacy alias and the per-model entry so future reads
  // see the narrative regardless of which field they look at.
  lockRecommendation(raceId, {
    betPlan: updated,
    betPlanByModel: {
      harville: updated,
      henery: fresh?.betPlanByModel?.henery,
    },
  });
}
