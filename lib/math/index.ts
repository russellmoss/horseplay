import type {
  EdgeBundle,
  HorseAnalysis,
  ModelOutput,
  ProbSource,
  Race,
  RaceAnalysis,
} from '../types';
import {
  applyFavoriteLongshotBias,
  probsFromDecimalOdds,
  probsFromWinPool,
  uniformProbs,
} from './probability';

function sumPositive(values: number[]): number {
  let total = 0;
  for (const v of values) {
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

function selectProbsAndSource(
  active: { winPoolDollars: number | null; currentOdds: number | null }[],
): { probs: number[]; probSource: ProbSource } {
  if (active.length === 0) {
    return { probs: [], probSource: 'uniform_fallback' };
  }
  if (active.every((h) => h.winPoolDollars !== null)) {
    const pools = active.map((h) => h.winPoolDollars as number);
    if (sumPositive(pools) > 0) {
      return { probs: probsFromWinPool(pools), probSource: 'win_pool' };
    }
  }
  if (active.every((h) => h.currentOdds !== null)) {
    const odds = active.map((h) => h.currentOdds as number);
    let oddsTotal = 0;
    for (const d of odds) {
      if (Number.isFinite(d) && d > 0) oddsTotal += 1 / d;
    }
    if (oddsTotal > 0) {
      return { probs: probsFromDecimalOdds(odds), probSource: 'decimal_odds' };
    }
  }
  return { probs: uniformProbs(active.length), probSource: 'uniform_fallback' };
}
import { heuristicPlaceProbs, heuristicShowProbs } from './heuristic';
import { harvillePlaceProbs, harvilleShowProbs } from './harville';
import { heneryPlaceProbs, heneryShowProbs } from './henery';
import {
  fairPayoutPer2,
  placePayoutBand,
  showPayoutBand,
  winPayoutPer2,
} from './payouts';
import { classifySignal, computeEdge, computeMlDrift } from './ev';
import { decimalToFractional } from './odds';
import { resolveTakeoutForTrack } from '../data/takeout-table';

export interface AnalyzeRaceOptions {
  takeoutWin?: number;
  takeoutPlace: number;
  takeoutShow: number;
  leanThreshold: number;
  driftThreshold: number;
  /**
   * Favorite-longshot bias correction exponent. Applied to pWin AFTER source
   * selection, only when the source is win_pool or decimal_odds (i.e. when
   * the prior reflects public betting). Default 1.06; pass 1 to disable.
   */
  flbAlpha?: number;
  now?: () => string;
}

export function analyzeRace(race: Race, options: AnalyzeRaceOptions): RaceAnalysis {
  const { takeoutPlace, takeoutShow, leanThreshold, driftThreshold } = options;
  const takeoutWin = options.takeoutWin ?? 0.16;
  const flbAlpha = options.flbAlpha ?? 1.06;
  const now = options.now ?? (() => new Date().toISOString());

  // Resolve per-track takeout. Known tracks use their published rates;
  // unknown tracks fall back to the caller's options (env-var defaults).
  const takeout = resolveTakeoutForTrack(race.trackCode, {
    win: takeoutWin,
    place: takeoutPlace,
    show: takeoutShow,
  });

  const active = race.horses.filter((h) => !h.scratched);
  const scratched = race.horses.filter((h) => h.scratched);

  const { probs: rawProbs, probSource } = selectProbsAndSource(active);
  // Apply favorite-longshot bias correction when the prior comes from public
  // betting (win pool or live decimal odds). Skip for uniform_fallback —
  // there's nothing to correct in a flat prior.
  const probs =
    probSource === 'win_pool' || probSource === 'decimal_odds'
      ? applyFavoriteLongshotBias(rawProbs, flbAlpha)
      : rawProbs;

  const heurPlace = heuristicPlaceProbs(probs);
  const heurShow = heuristicShowProbs(probs);
  const harvPlace = harvillePlaceProbs(probs);
  const harvShow = harvilleShowProbs(probs);
  const henPlace = heneryPlaceProbs(probs);
  const henShow = heneryShowProbs(probs);

  const placePoolsRaw = active.map((h) => h.placePoolDollars);
  const showPoolsRaw = active.map((h) => h.showPoolDollars);
  const winPoolsRaw = active.map((h) => h.winPoolDollars);
  const totalPlacePool = race.totalPlacePool;
  const totalShowPool = race.totalShowPool;
  const totalWinPool = race.totalWinPool;
  const placePoolsKnown =
    totalPlacePool !== undefined &&
    totalPlacePool !== null &&
    placePoolsRaw.every((p) => p !== null);
  const showPoolsKnown =
    totalShowPool !== undefined &&
    totalShowPool !== null &&
    showPoolsRaw.every((p) => p !== null);
  const winPoolsKnown =
    totalWinPool !== undefined &&
    totalWinPool !== null &&
    winPoolsRaw.every((p) => p !== null);

  const rows: HorseAnalysis[] = [];

  for (let i = 0; i < active.length; i++) {
    const h = active[i];
    const heuristic: ModelOutput = {
      pPlaceFair: heurPlace[i],
      pShowFair: heurShow[i],
      placeFairPayout: fairPayoutPer2(heurPlace[i]),
      showFairPayout: fairPayoutPer2(heurShow[i]),
    };
    const harville: ModelOutput = {
      pPlaceFair: harvPlace[i],
      pShowFair: harvShow[i],
      placeFairPayout: fairPayoutPer2(harvPlace[i]),
      showFairPayout: fairPayoutPer2(harvShow[i]),
    };
    const henery: ModelOutput = {
      pPlaceFair: henPlace[i],
      pShowFair: henShow[i],
      placeFairPayout: fairPayoutPer2(henPlace[i]),
      showFairPayout: fairPayoutPer2(henShow[i]),
    };

    const placeProjected = placePoolsKnown
      ? placePayoutBand(
          placePoolsRaw as number[],
          i,
          totalPlacePool as number,
          takeout.place,
          probs,
        )
      : { floor: null, mid: null, ceiling: null };
    const showProjected = showPoolsKnown
      ? showPayoutBand(
          showPoolsRaw as number[],
          i,
          totalShowPool as number,
          takeout.show,
          probs,
        )
      : { floor: null, mid: null, ceiling: null };

    const winFairPayout = fairPayoutPer2(probs[i]);
    const winProjected = winPoolsKnown
      ? winPayoutPer2(
          (winPoolsRaw as number[])[i],
          totalWinPool as number,
          takeout.win,
        )
      : null;
    const winEdge = computeEdge(winProjected, winFairPayout);

    const placeEdge: EdgeBundle = {
      heuristicFloor: computeEdge(placeProjected.floor, heuristic.placeFairPayout),
      heuristicMid: computeEdge(placeProjected.mid, heuristic.placeFairPayout),
      harvilleFloor: computeEdge(placeProjected.floor, harville.placeFairPayout),
      harvilleMid: computeEdge(placeProjected.mid, harville.placeFairPayout),
      heneryFloor: computeEdge(placeProjected.floor, henery.placeFairPayout),
      heneryMid: computeEdge(placeProjected.mid, henery.placeFairPayout),
    };
    const showEdge: EdgeBundle = {
      heuristicFloor: computeEdge(showProjected.floor, heuristic.showFairPayout),
      heuristicMid: computeEdge(showProjected.mid, heuristic.showFairPayout),
      harvilleFloor: computeEdge(showProjected.floor, harville.showFairPayout),
      harvilleMid: computeEdge(showProjected.mid, harville.showFairPayout),
      heneryFloor: computeEdge(showProjected.floor, henery.showFairPayout),
      heneryMid: computeEdge(showProjected.mid, henery.showFairPayout),
    };

    const mlDrift = computeMlDrift(h.currentOdds, h.mlOdds);
    const signal = classifySignal(placeEdge, showEdge, mlDrift, leanThreshold, driftThreshold);
    const fractional = h.currentOdds !== null ? decimalToFractional(h.currentOdds) : '';

    rows.push({
      program: h.program,
      name: h.name,
      mlOdds: h.mlOdds,
      currentOdds: h.currentOdds,
      currentFractional: fractional,
      mlDrift,
      pWin: probs[i],
      pWinRaw: rawProbs[i],
      heuristic,
      harville,
      henery,
      placeProjected,
      showProjected,
      placeEdge,
      showEdge,
      winFairPayout,
      winProjected,
      winEdge,
      signal,
    });
  }

  const NULL_MODEL: ModelOutput = {
    pPlaceFair: 0,
    pShowFair: 0,
    placeFairPayout: null,
    showFairPayout: null,
  };
  const NULL_EDGES: EdgeBundle = {
    heuristicFloor: null,
    heuristicMid: null,
    harvilleFloor: null,
    harvilleMid: null,
    heneryFloor: null,
    heneryMid: null,
  };
  for (const h of scratched) {
    rows.push({
      program: h.program,
      name: h.name,
      mlOdds: h.mlOdds,
      currentOdds: h.currentOdds,
      currentFractional: '',
      mlDrift: null,
      pWin: 0,
      pWinRaw: 0,
      heuristic: NULL_MODEL,
      harville: NULL_MODEL,
      henery: NULL_MODEL,
      placeProjected: { floor: null, mid: null, ceiling: null },
      showProjected: { floor: null, mid: null, ceiling: null },
      placeEdge: NULL_EDGES,
      showEdge: NULL_EDGES,
      winFairPayout: null,
      winProjected: null,
      winEdge: null,
      signal: 'none',
    });
  }

  return {
    race,
    probSource,
    rows,
    computedAt: now(),
  };
}

export {
  probsFromWinPool,
  probsFromDecimalOdds,
  uniformProbs,
} from './probability';
export { heuristicPlaceProbs, heuristicShowProbs } from './heuristic';
export { harvillePlaceProbs, harvilleShowProbs } from './harville';
export {
  heneryPlaceProbs,
  heneryShowProbs,
  HENERY_DEFAULT_BETA,
  HENERY_DEFAULT_GAMMA,
} from './henery';
export {
  placePayoutBand,
  showPayoutBand,
  winPayoutPer2,
  fairPayoutPer2,
  breakage,
} from './payouts';
export { computeEdge, classifySignal, computeMlDrift } from './ev';
export { decimalToFractional, fractionalToDecimal } from './odds';
