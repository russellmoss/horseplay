import type { Horse, Race, RaceResults } from '../types';

/**
 * The single file in the codebase that knows about FanDuel Racing's GraphQL
 * response shape. Everything else consumes the internal `Race` / `Horse` types.
 *
 * If FDR rotates their schema, this file is the only thing that needs to change
 * (plus `lib/scraper/queries.ts` for the request side).
 *
 * See `auth/discovered-endpoints.md` for the captured shape and field mapping.
 */

// ---------- FDR JSON types (subset of fields we consume) ----------

export interface FdrFractionalOdds {
  numerator: number | null;
  denominator: number | null;
  __typename?: string;
}

export interface FdrPoolRunnerData {
  amount: number | null;
  __typename?: string;
}

export interface FdrBiPool {
  wagerType: { code: string; __typename?: string };
  poolRunnersData: FdrPoolRunnerData[] | null;
  __typename?: string;
}

export interface FdrRunner {
  runnerId?: string;
  horseName?: string | null;
  jockey?: string | null;
  trainer?: string | null;
  scratched?: boolean | null;
  __typename?: string;
}

export interface FdrBettingInterest {
  biNumber: number;
  favorite?: boolean;
  currentOdds: FdrFractionalOdds | null;
  morningLineOdds: FdrFractionalOdds | null;
  biPools: FdrBiPool[] | null;
  runners: FdrRunner[];
  __typename?: string;
}

export interface FdrRacePool {
  wagerType: { code: string; __typename?: string };
  amount: number | null;
  __typename?: string;
}

export interface FdrResultRunner {
  biNumber: number;
  finishPosition: number;
  runnerName: string;
  winPayoff: number;
  placePayoff: number;
  showPayoff: number;
  betAmount?: number;
  runnerNumber?: string;
  __typename?: string;
}

export interface FdrPayoffSelection {
  selection?: string;
  payoutAmount?: number | null;
  __typename?: string;
}

export interface FdrPayoffEntry {
  wagerType?: { code?: string; __typename?: string };
  /** Base unit the payoutAmount is per (e.g. 2.0 for exacta, 0.5 for trifecta). */
  wagerAmount?: number | null;
  selections?: FdrPayoffSelection[];
  __typename?: string;
}

export interface FdrResults {
  runners: FdrResultRunner[];
  payoffs?: FdrPayoffEntry[];
  winningTime?: number | null;
  __typename?: string;
}

export interface FdrRaceUpdate {
  id: string;
  tvgRaceId: number;
  raceNumber: string | number;
  postTime: string;
  status: { code: string; __typename?: string };
  bettingInterests: FdrBettingInterest[] | null;
  racePools: FdrRacePool[] | null;
  results?: FdrResults | null;
  /** Minutes to post; not consumed by the adapter but useful for logging. */
  mtp?: number | null;
  __typename?: string;
}

export interface AdaptOptions {
  /** Override clock for testing — defaults to `new Date().toISOString()`. */
  now?: () => string;
}

// ---------- adapter ----------

const OPEN_STATUS_CODES = new Set(['O', 'IC', 'MO']);
const CLOSED_STATUS_CODES = new Set(['RO', 'SK']);

export function adaptFdrToRace(update: FdrRaceUpdate, options: AdaptOptions = {}): Race {
  const now = options.now ?? (() => new Date().toISOString());

  if (!update.bettingInterests || update.bettingInterests.length === 0) {
    throw new Error(`adapter: race ${update.id} has no bettingInterests`);
  }

  const horses: Horse[] = update.bettingInterests.map(adaptHorse);

  const allWinPoolsBlank = horses.every(
    (h) => h.winPoolDollars === null || h.winPoolDollars === 0,
  );
  const allOddsBlank = horses.every((h) => h.currentOdds === null);
  if (allWinPoolsBlank && allOddsBlank) {
    throw new Error(
      `adapter: race ${update.id} has neither win-pool dollars nor live odds — nothing to compute against`,
    );
  }

  const race: Race = {
    raceId: update.id,
    trackCode: parseTrackCode(update.id),
    raceNumber: parseRaceNumber(update.raceNumber),
    postTimeUtc: update.postTime,
    status: deriveStatus(update),
    horses,
    totalWinPool: lookupRacePool(update.racePools, 'WN') ?? undefined,
    totalPlacePool: lookupRacePool(update.racePools, 'PL') ?? undefined,
    totalShowPool: lookupRacePool(update.racePools, 'SH') ?? undefined,
    totalExactaPool: lookupRacePool(update.racePools, 'EX') ?? undefined,
    totalTrifectaPool: lookupRacePool(update.racePools, 'TR') ?? undefined,
    totalSuperfectaPool: lookupRacePool(update.racePools, 'SU') ?? undefined,
    totalSuperHighFivePool: lookupRacePool(update.racePools, 'SH5') ?? undefined,
    totalDailyDoublePool: lookupRacePool(update.racePools, 'DB') ?? undefined,
    totalPick3Pool: lookupRacePool(update.racePools, 'P3') ?? undefined,
    totalPick6Pool: lookupRacePool(update.racePools, 'P6') ?? undefined,
    lastUpdate: now(),
    tvgRaceId: update.tvgRaceId,
    results: hasUsableResults(update.results) ? adaptResults(update.results!) : null,
  };

  return race;
}

function adaptHorse(bi: FdrBettingInterest): Horse {
  const runner: FdrRunner = bi.runners?.[0] ?? {};
  const horse: Horse = {
    program: String(bi.biNumber),
    name: runner.horseName ?? '',
    mlOdds: fractionalToDecimal(bi.morningLineOdds),
    currentOdds: fractionalToDecimal(bi.currentOdds),
    winPoolDollars: lookupBiPool(bi.biPools, 'WN'),
    placePoolDollars: lookupBiPool(bi.biPools, 'PL'),
    showPoolDollars: lookupBiPool(bi.biPools, 'SH'),
    scratched: runner.scratched === true,
  };
  if (typeof runner.jockey === 'string' && runner.jockey.length > 0) {
    horse.jockey = runner.jockey;
  }
  if (typeof runner.trainer === 'string' && runner.trainer.length > 0) {
    horse.trainer = runner.trainer;
  }
  return horse;
}

function adaptResults(results: FdrResults): RaceResults {
  // Capture official exotic payoffs (EX, TR, SU, SH5) for the simulation
  // settlement engine. WPS payoffs are already per-runner above; we pull the
  // exotic payouts separately because they're per-combination, not per-horse.
  const EXOTIC_CODES = new Set(['EX', 'TR', 'SU', 'SH5']);
  const exoticPayoffs = (results.payoffs ?? [])
    .flatMap((p) => {
      const wagerCode = p.wagerType?.code;
      if (!wagerCode || !EXOTIC_CODES.has(wagerCode)) return [];
      const wagerAmount = typeof p.wagerAmount === 'number' ? p.wagerAmount : 2;
      return (p.selections ?? [])
        .filter(
          (s): s is { selection: string; payoutAmount: number } =>
            typeof s.selection === 'string' &&
            typeof s.payoutAmount === 'number' &&
            s.payoutAmount > 0,
        )
        .map((s) => ({
          wagerCode,
          wagerAmount,
          selection: s.selection,
          payoutAmount: s.payoutAmount,
        }));
    });

  return {
    runners: results.runners
      .slice()
      .sort((a, b) => a.finishPosition - b.finishPosition)
      .map((r) => ({
        finishPosition: r.finishPosition,
        program: String(r.biNumber),
        name: r.runnerName,
        winPayoff: r.winPayoff,
        placePayoff: r.placePayoff,
        showPayoff: r.showPayoff,
      })),
    winningTimeSeconds: typeof results.winningTime === 'number' ? results.winningTime : null,
    exoticPayoffs: exoticPayoffs.length > 0 ? exoticPayoffs : undefined,
  };
}

function deriveStatus(update: FdrRaceUpdate): Race['status'] {
  if (hasUsableResults(update.results)) return 'official';
  const code = update.status?.code;
  if (typeof code === 'string' && OPEN_STATUS_CODES.has(code)) return 'open';
  if (typeof code === 'string' && CLOSED_STATUS_CODES.has(code)) return 'closed';
  // Unknown / missing code: defensively closed. Anything new from FDR will surface
  // as 'closed' and be discoverable when it appears in the dashboard.
  return 'closed';
}

function hasUsableResults(results: FdrResults | null | undefined): results is FdrResults {
  return (
    results !== null &&
    results !== undefined &&
    Array.isArray(results.runners) &&
    results.runners.length > 0
  );
}

export function fractionalToDecimal(odds: FdrFractionalOdds | null | undefined): number | null {
  if (!odds) return null;
  const num = odds.numerator;
  const den = odds.denominator ?? 1;
  if (num === null || num === undefined) return null;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return 1 + num / den;
}

function lookupBiPool(biPools: FdrBiPool[] | null | undefined, code: string): number | null {
  if (!biPools) return null;
  const pool = biPools.find((bp) => bp.wagerType?.code === code);
  if (!pool || !pool.poolRunnersData || pool.poolRunnersData.length === 0) return null;
  const amount = pool.poolRunnersData[0].amount;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
}

function lookupRacePool(racePools: FdrRacePool[] | null | undefined, code: string): number | null {
  if (!racePools) return null;
  const pool = racePools.find((rp) => rp.wagerType?.code === code);
  if (!pool) return null;
  const amount = pool.amount;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
}

function parseTrackCode(raceId: string): string {
  const dash = raceId.indexOf('-');
  return dash > 0 ? raceId.slice(0, dash) : raceId;
}

function parseRaceNumber(raceNumber: string | number): number {
  if (typeof raceNumber === 'number' && Number.isFinite(raceNumber)) return raceNumber;
  const parsed = Number(raceNumber);
  if (!Number.isFinite(parsed)) {
    throw new Error(`adapter: invalid raceNumber: ${JSON.stringify(raceNumber)}`);
  }
  return parsed;
}
