/**
 * Historical evaluator — joins lock-time RaceAnalysis snapshots to settled
 * outcomes from `data/locked-recs.json` and emits a long-format CSV with
 * one row per (race × horse × model). Downstream diagnostics (calibration
 * plot, Brier/log-loss, ROI-by-drift, SLAM_DUNK threshold sweep, per-track
 * breakouts, blended-model backtest) all consume this CSV.
 *
 * Run: `tsx scripts/evaluate-history.ts`
 * Output: `data/evaluations/history-YYYY-MM-DD.csv` (today's date)
 *
 * Design notes:
 *
 * 1. ROSTER-DRIVEN vs BET-DRIVEN emission. When the record has an `analysis`
 *    snapshot we iterate ALL horses in the analysis (the full roster). Every
 *    horse gets two rows (one per model) regardless of whether either model
 *    bet on it. Tickets are a left-join onto the roster — horses without
 *    tickets get tickets_count=0 and zero stake/pnl, but their probability,
 *    edge, and pool columns are populated. This is required for calibration
 *    work: we need pWin/pPlace/pShow for EVERY horse, including the unbet
 *    ones, to assess whether predicted 5%-pWin horses actually win 5% of
 *    the time. (See `analysis_present` column for which path emitted a row.)
 *
 *    Records persisted before the analysis-snapshot field was added fall
 *    through to bet-driven emission: one row per horse the model bet on.
 *    Plus a sentinel row when a model legitimately passed (empty plan) so
 *    "model passed" is visible in the CSV instead of an absence.
 *
 * 2. `signal_tag` is the Harville-derived classifier output, duplicated
 *    across both model rows for a given horse — the classifier doesn't run
 *    per-model in this codebase.
 *
 * 3. Per-horse ticket aggregation: a single ticket may reference multiple
 *    horses (boxes, straight exotics with multiple legs). We split the
 *    ticket's stake and profit EVENLY across the horses it touches, so that
 *    Σ_horses stake_*  ==  plan total stake (reconciles exactly to plan).
 *
 * 4. `place_proj_mid` / `show_proj_mid` are the SAME on both model rows for
 *    a horse — the projection is a pool-state estimate, not a model output.
 *    Only the fair price (and therefore the edge) differs per model.
 *
 * 5. `settlement_state` ∈ {'settled', 'pending', 'void'}. A 'void' state is
 *    a race that came back with no usable finishing positions (canceled /
 *    postponed / all-MTO). Real pari-mutuel handling is refund-in-full, so
 *    void rows have totalReturn==totalStake and totalProfit==0. Downstream
 *    code should filter to settlement_state=='settled' for ROI / Brier /
 *    calibration analysis. The legacy `settled` boolean column is true ONLY
 *    when settlement_state == 'settled' — void and pending are both false.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  EdgeBundle,
  HorseAnalysis,
  RaceAnalysis,
} from '../lib/types.js';
import type {
  BetSettlement,
  LockedBetPlan,
  ModelKey,
  SettledTicket,
  TicketType,
} from '../lib/simulation/types.js';
import type { LockedRecommendation } from '../lib/store.js';

// ── Paths ────────────────────────────────────────────────────────────────

const REPO_ROOT = process.cwd();
const LOCKED_RECS_FILE = path.join(REPO_ROOT, 'data', 'locked-recs.json');
const OUT_DIR = path.join(REPO_ROOT, 'data', 'evaluations');
const todayIso = new Date().toISOString().slice(0, 10);
const OUT_FILE = path.join(OUT_DIR, `history-${todayIso}.csv`);

// ── Helpers ──────────────────────────────────────────────────────────────

const MODELS: ModelKey[] = ['harville', 'henery'];
type SettlementState = 'settled' | 'pending' | 'void';

/** Pull the per-model bet plan, falling back to the legacy `betPlan` (Harville). */
function planFor(
  rec: LockedRecommendation,
  model: ModelKey,
): LockedBetPlan | null {
  const fromMap = rec.betPlanByModel?.[model];
  if (fromMap) return fromMap;
  if (model === 'harville' && rec.betPlan) return rec.betPlan;
  return null;
}

/** Same fallback rule for the settlement side. */
function settlementFor(
  rec: LockedRecommendation,
  model: ModelKey,
): BetSettlement | null {
  const fromMap = rec.settlementByModel?.[model];
  if (fromMap) return fromMap;
  if (model === 'harville' && rec.settlement) return rec.settlement;
  return null;
}

/** Race-level settlement state for one model. */
function settlementStateFor(rec: LockedRecommendation, model: ModelKey): SettlementState {
  const s = settlementFor(rec, model);
  if (!s) return 'pending';
  if (s.state === 'void') return 'void';
  return 'settled';
}

/** Map ticket type → the bet-type column family (win/place/show/exacta/trifecta). */
function bucketFor(t: TicketType): 'win' | 'place' | 'show' | 'exacta' | 'trifecta' {
  if (t === 'win' || t === 'place' || t === 'show') return t;
  if (t === 'exacta_straight' || t === 'exacta_box') return 'exacta';
  return 'trifecta';
}

/** Per-(horse × bucket) running totals for one model's plan. */
interface HorseBetAgg {
  ticketsCount: number;
  totalStake: number;
  totalReturned: number;
  stakeByBucket: Record<'win' | 'place' | 'show' | 'exacta' | 'trifecta', number>;
  pnlByBucket: Record<'win' | 'place' | 'show' | 'exacta' | 'trifecta', number>;
}
function emptyHorseAgg(): HorseBetAgg {
  return {
    ticketsCount: 0,
    totalStake: 0,
    totalReturned: 0,
    stakeByBucket: { win: 0, place: 0, show: 0, exacta: 0, trifecta: 0 },
    pnlByBucket: { win: 0, place: 0, show: 0, exacta: 0, trifecta: 0 },
  };
}

/**
 * Aggregate one model's plan/settlement into a horse-keyed map.
 *
 * Multi-horse tickets split stake and profit EVENLY across all horses the
 * ticket touches, so Σ_horses stake == plan total stake. Pending tickets
 * contribute stake but zero return/pnl. Void tickets contribute stake AND
 * an equal-amount refund, so pnl share = 0 (handled via the settlement's
 * existing totalReturn = totalStake convention).
 */
function aggregatePlanByHorse(
  plan: LockedBetPlan | null,
  settle: BetSettlement | null,
): Map<string, HorseBetAgg> {
  const byHorse = new Map<string, HorseBetAgg>();
  if (!plan) return byHorse;

  const settledTickets: SettledTicket[] = settle?.tickets ?? [];

  for (let i = 0; i < plan.tickets.length; i++) {
    const t = plan.tickets[i];
    const s = settledTickets[i];
    const horses = t.horses ?? [];
    if (horses.length === 0) continue;
    const stakeShare = t.amount / horses.length;
    const returnShare = s ? s.returned / horses.length : 0;
    const profitShare = s ? s.profit / horses.length : 0; // pending → pnl null at the row level
    const bucket = bucketFor(t.type);
    for (const h of horses) {
      const agg = byHorse.get(h) ?? emptyHorseAgg();
      agg.ticketsCount += 1;
      agg.totalStake += stakeShare;
      agg.totalReturned += returnShare;
      agg.stakeByBucket[bucket] += stakeShare;
      if (s) agg.pnlByBucket[bucket] += profitShare;
      byHorse.set(h, agg);
    }
  }
  return byHorse;
}

/** Look up the EdgeBundle field for the given model. */
function modelEdge(edge: EdgeBundle, model: ModelKey, band: 'floor' | 'mid'): number | null {
  if (model === 'harville') {
    return band === 'floor' ? edge.harvilleFloor : edge.harvilleMid;
  }
  return band === 'floor' ? edge.heneryFloor : edge.heneryMid;
}

/** Date prefix from an ISO string (YYYY-MM-DD), with a fallback. */
function isoDateOnly(iso: string | undefined | null): string | null {
  if (!iso || typeof iso !== 'string') return null;
  return iso.slice(0, 10);
}

// ── CSV writing ──────────────────────────────────────────────────────────

const COLUMNS = [
  'race_id',
  'track_code',
  'race_date',
  'race_number',
  'surface',
  'distance',
  'field_size',
  'race_class',
  'horse_number',
  'horse_name',
  'model',
  'analysis_present',
  'p_win',
  'p_place',
  'p_show',
  'win_fair_payout',
  'place_fair_payout',
  'show_fair_payout',
  'win_proj_payout',
  'place_proj_mid',
  'place_proj_floor',
  'show_proj_mid',
  'show_proj_floor',
  'win_edge_mid',
  'place_edge_mid',
  'place_edge_floor',
  'show_edge_mid',
  'show_edge_floor',
  'ml_drift',
  'signal_tag',
  'win_pool',
  'place_pool',
  'show_pool',
  'exacta_pool',
  'trifecta_pool',
  'finish_position',
  'won',
  'placed',
  'showed',
  'realized_win_payoff',
  'realized_place_payoff',
  'realized_show_payoff',
  'tickets_count',
  'total_stake_on_horse',
  'total_returned_on_horse',
  'pnl_on_horse',
  'stake_win',
  'stake_place',
  'stake_show',
  'stake_exacta',
  'stake_trifecta',
  'pnl_win',
  'pnl_place',
  'pnl_show',
  'pnl_exacta',
  'pnl_trifecta',
  'scratched',
  'settlement_state',
  'settled',
  'lock_timestamp_utc',
  'settle_timestamp_utc',
] as const;

type ColumnName = (typeof COLUMNS)[number];
type Row = Partial<Record<ColumnName, number | string | boolean | null>>;

function csvEscape(value: number | string | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return Number.isInteger(value)
      ? value.toString()
      : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(rows: Row[]): void {
  const header = COLUMNS.join(',');
  const body = rows.map((r) => COLUMNS.map((c) => csvEscape(r[c])).join(',')).join('\n');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, header + '\n' + body + '\n', 'utf8');
}

// ── Row building ─────────────────────────────────────────────────────────

interface BuildContext {
  rec: LockedRecommendation;
  analysis: RaceAnalysis | undefined;
  raceDate: string | null;
  trackCode: string;
  raceNumber: number | null;
  fieldSize: number | null;
  compositeRaceId: string;
}

function buildRowsForRec(rec: LockedRecommendation): Row[] {
  const ctx = makeContext(rec);
  const rows: Row[] = [];

  const aggByModel: Record<ModelKey, Map<string, HorseBetAgg>> = {
    harville: aggregatePlanByHorse(planFor(rec, 'harville'), settlementFor(rec, 'harville')),
    henery: aggregatePlanByHorse(planFor(rec, 'henery'), settlementFor(rec, 'henery')),
  };

  const results = ctx.analysis?.race.results ?? null;
  const resultByProgram = new Map<
    string,
    { pos: number; win: number; place: number; show: number }
  >();
  if (results) {
    for (const r of results.runners) {
      resultByProgram.set(r.program, {
        pos: r.finishPosition,
        win: r.winPayoff,
        place: r.placePayoff,
        show: r.showPayoff,
      });
    }
  }

  const stateByModel: Record<ModelKey, SettlementState> = {
    harville: settlementStateFor(rec, 'harville'),
    henery: settlementStateFor(rec, 'henery'),
  };
  const settleAtByModel: Record<ModelKey, string | null> = {
    harville: settlementFor(rec, 'harville')?.settledAt ?? null,
    henery: settlementFor(rec, 'henery')?.settledAt ?? null,
  };

  // ── PATH A: roster-driven (analysis present) ──
  if (ctx.analysis) {
    for (const h of ctx.analysis.rows) {
      const horsePoolWin = findHorsePool(ctx.analysis, h.program, 'win');
      const horsePoolPlace = findHorsePool(ctx.analysis, h.program, 'place');
      const horsePoolShow = findHorsePool(ctx.analysis, h.program, 'show');
      const result = resultByProgram.get(h.program) ?? null;
      const scratched = !!ctx.analysis.race.horses.find(
        (x) => x.program === h.program && x.scratched,
      );

      for (const model of MODELS) {
        rows.push(
          makeRow(ctx, h, model, {
            horsePoolWin,
            horsePoolPlace,
            horsePoolShow,
            result,
            scratched,
            state: stateByModel[model],
            settleAt: settleAtByModel[model],
            agg: aggByModel[model].get(h.program) ?? null,
            analysisPresent: true,
          }),
        );
      }
    }
    return rows;
  }

  // ── PATH B: bet-driven (no analysis snapshot, legacy records) ──
  const touchedPrograms = new Set<string>();
  for (const model of MODELS) {
    for (const h of aggByModel[model].keys()) touchedPrograms.add(h);
  }
  for (const program of touchedPrograms) {
    const result = resultByProgram.get(program) ?? null;
    for (const model of MODELS) {
      const agg = aggByModel[model].get(program);
      if (!agg) continue;
      rows.push(
        makeFallbackRow(ctx, program, model, {
          result,
          state: stateByModel[model],
          settleAt: settleAtByModel[model],
          agg,
        }),
      );
    }
  }

  // Sentinel rows: model has a plan but it's empty (legitimately passed) AND
  // no analysis snapshot means the roster-driven path won't fire. Without
  // these the CSV would silently drop "model passed" cases.
  for (const model of MODELS) {
    const plan = planFor(rec, model);
    if (!plan) continue;
    if (plan.tickets.length > 0) continue;
    rows.push(
      makeSentinelRow(ctx, model, {
        state: stateByModel[model],
        settleAt: settleAtByModel[model],
      }),
    );
  }
  return rows;
}

function makeContext(rec: LockedRecommendation): BuildContext {
  const analysis = rec.analysis;
  const trackCode = analysis?.race.trackCode ?? rec.raceId.split('-')[0] ?? '';
  const raceNumber = analysis?.race.raceNumber ?? parseRaceNumberFromId(rec.raceId);
  const raceDate =
    isoDateOnly(analysis?.race.postTimeUtc) ??
    isoDateOnly(rec.lockedAt) ??
    null;
  const fieldSize = analysis
    ? analysis.race.horses.filter((h) => !h.scratched).length
    : null;
  const compositeRaceId =
    raceDate && raceNumber !== null
      ? `${trackCode}-${raceDate}-R${raceNumber}`
      : `${rec.raceId}@${rec.lockedAt}`;
  return {
    rec,
    analysis,
    raceDate,
    trackCode,
    raceNumber,
    fieldSize,
    compositeRaceId,
  };
}

function parseRaceNumberFromId(raceId: string): number | null {
  const parts = raceId.split('-');
  const last = parts[parts.length - 1];
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

function findHorsePool(
  analysis: RaceAnalysis,
  program: string,
  pool: 'win' | 'place' | 'show',
): number | null {
  const h = analysis.race.horses.find((x) => x.program === program);
  if (!h) return null;
  if (pool === 'win') return h.winPoolDollars;
  if (pool === 'place') return h.placePoolDollars;
  return h.showPoolDollars;
}

interface FullRowExtras {
  horsePoolWin: number | null;
  horsePoolPlace: number | null;
  horsePoolShow: number | null;
  result: { pos: number; win: number; place: number; show: number } | null;
  scratched: boolean;
  state: SettlementState;
  settleAt: string | null;
  agg: HorseBetAgg | null;
  analysisPresent: boolean;
}

function makeRow(
  ctx: BuildContext,
  h: HorseAnalysis,
  model: ModelKey,
  ex: FullRowExtras,
): Row {
  const analysis = ctx.analysis!;
  const modelOut = model === 'harville' ? h.harville : h.henery;
  const isSettled = ex.state === 'settled';

  // Outcome booleans are only meaningful for settled (not void, not pending),
  // non-scratched horses. Void races have refund-equal-stake P&L so there's
  // no win/place/show signal to report.
  let won: boolean | null = null;
  let placed: boolean | null = null;
  let showed: boolean | null = null;
  if (isSettled && !ex.scratched && ex.result && ex.result.pos > 0) {
    won = ex.result.pos === 1;
    placed = ex.result.pos <= 2;
    showed = ex.result.pos <= 3;
  }

  return {
    race_id: ctx.compositeRaceId,
    track_code: ctx.trackCode,
    race_date: ctx.raceDate,
    race_number: ctx.raceNumber,
    surface: null,
    distance: null,
    field_size: ctx.fieldSize,
    race_class: null,
    horse_number: h.program,
    horse_name: h.name,
    model,
    analysis_present: ex.analysisPresent,
    p_win: ex.scratched ? null : h.pWin,
    p_place: ex.scratched ? null : modelOut.pPlaceFair,
    p_show: ex.scratched ? null : modelOut.pShowFair,
    win_fair_payout: h.winFairPayout,
    place_fair_payout: modelOut.placeFairPayout,
    show_fair_payout: modelOut.showFairPayout,
    win_proj_payout: h.winProjected,
    place_proj_mid: h.placeProjected.mid,
    place_proj_floor: h.placeProjected.floor,
    show_proj_mid: h.showProjected.mid,
    show_proj_floor: h.showProjected.floor,
    win_edge_mid: h.winEdge,
    place_edge_mid: modelEdge(h.placeEdge, model, 'mid'),
    place_edge_floor: modelEdge(h.placeEdge, model, 'floor'),
    show_edge_mid: modelEdge(h.showEdge, model, 'mid'),
    show_edge_floor: modelEdge(h.showEdge, model, 'floor'),
    ml_drift: h.mlDrift,
    signal_tag: h.signal,
    win_pool: ex.horsePoolWin,
    place_pool: ex.horsePoolPlace,
    show_pool: ex.horsePoolShow,
    exacta_pool: analysis.race.totalExactaPool ?? null,
    trifecta_pool: analysis.race.totalTrifectaPool ?? null,
    finish_position: ex.result?.pos ?? null,
    won,
    placed,
    showed,
    realized_win_payoff: ex.result?.win ?? null,
    realized_place_payoff: ex.result?.place ?? null,
    realized_show_payoff: ex.result?.show ?? null,
    tickets_count: ex.agg?.ticketsCount ?? 0,
    total_stake_on_horse: ex.agg?.totalStake ?? 0,
    total_returned_on_horse:
      ex.state === 'pending' ? null : ex.agg?.totalReturned ?? 0,
    pnl_on_horse:
      ex.state === 'pending'
        ? null
        : (ex.agg?.totalReturned ?? 0) - (ex.agg?.totalStake ?? 0),
    stake_win: ex.agg?.stakeByBucket.win ?? 0,
    stake_place: ex.agg?.stakeByBucket.place ?? 0,
    stake_show: ex.agg?.stakeByBucket.show ?? 0,
    stake_exacta: ex.agg?.stakeByBucket.exacta ?? 0,
    stake_trifecta: ex.agg?.stakeByBucket.trifecta ?? 0,
    pnl_win: ex.state === 'pending' ? null : ex.agg?.pnlByBucket.win ?? 0,
    pnl_place: ex.state === 'pending' ? null : ex.agg?.pnlByBucket.place ?? 0,
    pnl_show: ex.state === 'pending' ? null : ex.agg?.pnlByBucket.show ?? 0,
    pnl_exacta: ex.state === 'pending' ? null : ex.agg?.pnlByBucket.exacta ?? 0,
    pnl_trifecta: ex.state === 'pending' ? null : ex.agg?.pnlByBucket.trifecta ?? 0,
    scratched: ex.scratched,
    settlement_state: ex.state,
    settled: isSettled,
    lock_timestamp_utc: ctx.rec.lockedAt,
    settle_timestamp_utc: ex.settleAt,
  };
}

interface FallbackRowExtras {
  result: { pos: number; win: number; place: number; show: number } | null;
  state: SettlementState;
  settleAt: string | null;
  agg: HorseBetAgg;
}

function makeFallbackRow(
  ctx: BuildContext,
  program: string,
  model: ModelKey,
  ex: FallbackRowExtras,
): Row {
  const isSettled = ex.state === 'settled';
  let won: boolean | null = null;
  let placed: boolean | null = null;
  let showed: boolean | null = null;
  if (isSettled && ex.result && ex.result.pos > 0) {
    won = ex.result.pos === 1;
    placed = ex.result.pos <= 2;
    showed = ex.result.pos <= 3;
  }
  return {
    race_id: ctx.compositeRaceId,
    track_code: ctx.trackCode,
    race_date: ctx.raceDate,
    race_number: ctx.raceNumber,
    surface: null,
    distance: null,
    field_size: null,
    race_class: null,
    horse_number: program,
    horse_name: null,
    model,
    analysis_present: false,
    p_win: null,
    p_place: null,
    p_show: null,
    win_fair_payout: null,
    place_fair_payout: null,
    show_fair_payout: null,
    win_proj_payout: null,
    place_proj_mid: null,
    place_proj_floor: null,
    show_proj_mid: null,
    show_proj_floor: null,
    win_edge_mid: null,
    place_edge_mid: null,
    place_edge_floor: null,
    show_edge_mid: null,
    show_edge_floor: null,
    ml_drift: null,
    signal_tag: null,
    win_pool: null,
    place_pool: null,
    show_pool: null,
    exacta_pool: null,
    trifecta_pool: null,
    finish_position: ex.result?.pos ?? null,
    won,
    placed,
    showed,
    realized_win_payoff: ex.result?.win ?? null,
    realized_place_payoff: ex.result?.place ?? null,
    realized_show_payoff: ex.result?.show ?? null,
    tickets_count: ex.agg.ticketsCount,
    total_stake_on_horse: ex.agg.totalStake,
    total_returned_on_horse: ex.state === 'pending' ? null : ex.agg.totalReturned,
    pnl_on_horse: ex.state === 'pending' ? null : ex.agg.totalReturned - ex.agg.totalStake,
    stake_win: ex.agg.stakeByBucket.win,
    stake_place: ex.agg.stakeByBucket.place,
    stake_show: ex.agg.stakeByBucket.show,
    stake_exacta: ex.agg.stakeByBucket.exacta,
    stake_trifecta: ex.agg.stakeByBucket.trifecta,
    pnl_win: ex.state === 'pending' ? null : ex.agg.pnlByBucket.win,
    pnl_place: ex.state === 'pending' ? null : ex.agg.pnlByBucket.place,
    pnl_show: ex.state === 'pending' ? null : ex.agg.pnlByBucket.show,
    pnl_exacta: ex.state === 'pending' ? null : ex.agg.pnlByBucket.exacta,
    pnl_trifecta: ex.state === 'pending' ? null : ex.agg.pnlByBucket.trifecta,
    scratched: false,
    settlement_state: ex.state,
    settled: isSettled,
    lock_timestamp_utc: ctx.rec.lockedAt,
    settle_timestamp_utc: ex.settleAt,
  };
}

/**
 * Sentinel row for a model that legitimately passed (empty plan) on a record
 * that has no analysis snapshot. Without this, "model passed" looks like
 * "model absence" downstream. horse_number / horse_name are null; all
 * stake / pnl columns are 0.
 */
function makeSentinelRow(
  ctx: BuildContext,
  model: ModelKey,
  ex: { state: SettlementState; settleAt: string | null },
): Row {
  const isSettled = ex.state === 'settled';
  return {
    race_id: ctx.compositeRaceId,
    track_code: ctx.trackCode,
    race_date: ctx.raceDate,
    race_number: ctx.raceNumber,
    surface: null,
    distance: null,
    field_size: null,
    race_class: null,
    horse_number: null,
    horse_name: null,
    model,
    analysis_present: false,
    p_win: null,
    p_place: null,
    p_show: null,
    win_fair_payout: null,
    place_fair_payout: null,
    show_fair_payout: null,
    win_proj_payout: null,
    place_proj_mid: null,
    place_proj_floor: null,
    show_proj_mid: null,
    show_proj_floor: null,
    win_edge_mid: null,
    place_edge_mid: null,
    place_edge_floor: null,
    show_edge_mid: null,
    show_edge_floor: null,
    ml_drift: null,
    signal_tag: null,
    win_pool: null,
    place_pool: null,
    show_pool: null,
    exacta_pool: null,
    trifecta_pool: null,
    finish_position: null,
    won: null,
    placed: null,
    showed: null,
    realized_win_payoff: null,
    realized_place_payoff: null,
    realized_show_payoff: null,
    tickets_count: 0,
    total_stake_on_horse: 0,
    total_returned_on_horse: isSettled ? 0 : null,
    pnl_on_horse: isSettled ? 0 : null,
    stake_win: 0,
    stake_place: 0,
    stake_show: 0,
    stake_exacta: 0,
    stake_trifecta: 0,
    pnl_win: isSettled ? 0 : null,
    pnl_place: isSettled ? 0 : null,
    pnl_show: isSettled ? 0 : null,
    pnl_exacta: isSettled ? 0 : null,
    pnl_trifecta: isSettled ? 0 : null,
    scratched: false,
    settlement_state: ex.state,
    settled: isSettled,
    lock_timestamp_utc: ctx.rec.lockedAt,
    settle_timestamp_utc: ex.settleAt,
  };
}

// ── Sort ─────────────────────────────────────────────────────────────────

function sortRows(rows: Row[]): Row[] {
  return rows.slice().sort((a, b) => {
    const k = (r: Row) =>
      [
        r.race_date ?? '',
        r.track_code ?? '',
        String(r.race_number ?? 0).padStart(4, '0'),
        padHorseProgram(String(r.horse_number ?? '')),
        r.model ?? '',
      ].join('|');
    const ka = k(a);
    const kb = k(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function padHorseProgram(p: string): string {
  if (p === '') return 'zzz_sentinel'; // sentinel rows sort last within their race
  const m = /^(\d+)([A-Za-z]*)$/.exec(p);
  if (!m) return p.padStart(6, '0');
  return m[1].padStart(4, '0') + m[2];
}

// ── Summary + reconciliation ────────────────────────────────────────────

interface Summary {
  totalRecords: number;
  settled: number;
  pending: number;
  voidCount: number;
  totalRows: number;
  nanPWin: number;
  nanPPlaceHarv: number;
  scratched: number;
  recsMissingAnalysis: number;
  recsWithAnalysis: number;
  tracks: Map<string, number>;
  dateMin: string | null;
  dateMax: string | null;
  fileSizeMB: number;
}

function summarize(rows: Row[], recs: LockedRecommendation[]): Summary {
  let settled = 0;
  let voidCount = 0;
  let pending = 0;
  for (const rec of recs) {
    // A record is "settled" if EITHER model has a settled state. Void if
    // every present model is void. Pending otherwise.
    const states: SettlementState[] = MODELS.map((m) => settlementStateFor(rec, m));
    if (states.some((s) => s === 'settled')) settled++;
    else if (states.some((s) => s === 'void') && !states.some((s) => s === 'settled'))
      voidCount++;
    else pending++;
  }
  const recsWithAnalysis = recs.filter((r) => r.analysis).length;

  let nanPWin = 0;
  let nanPPlaceHarv = 0;
  let scratched = 0;
  const seenRacesByTrack = new Map<string, Set<string>>();
  let dateMin: string | null = null;
  let dateMax: string | null = null;

  for (const r of rows) {
    if (r.scratched === true) scratched += 1;
    if (typeof r.p_win === 'number' && !Number.isFinite(r.p_win)) nanPWin += 1;
    if (r.model === 'harville' && typeof r.p_place === 'number' && !Number.isFinite(r.p_place))
      nanPPlaceHarv += 1;
    if (typeof r.track_code === 'string' && typeof r.race_id === 'string') {
      const set = seenRacesByTrack.get(r.track_code) ?? new Set<string>();
      set.add(r.race_id);
      seenRacesByTrack.set(r.track_code, set);
    }
    if (typeof r.race_date === 'string' && r.race_date.length === 10) {
      if (!dateMin || r.race_date < dateMin) dateMin = r.race_date;
      if (!dateMax || r.race_date > dateMax) dateMax = r.race_date;
    }
  }

  const tracks = new Map<string, number>();
  for (const [t, s] of seenRacesByTrack) tracks.set(t, s.size);

  let fileSizeMB = 0;
  try {
    const stat = fs.statSync(OUT_FILE);
    fileSizeMB = stat.size / (1024 * 1024);
  } catch {
    fileSizeMB = 0;
  }

  return {
    totalRecords: recs.length,
    settled,
    pending,
    voidCount,
    totalRows: rows.length,
    nanPWin,
    nanPPlaceHarv,
    scratched,
    recsMissingAnalysis: recs.length - recsWithAnalysis,
    recsWithAnalysis,
    tracks,
    dateMin,
    dateMax,
    fileSizeMB,
  };
}

interface ReconAgg {
  stake: number;
  returned: number;
  pnl: number;
}
function reconcile(recs: LockedRecommendation[]): Record<ModelKey, ReconAgg> {
  const agg: Record<ModelKey, ReconAgg> = {
    harville: { stake: 0, returned: 0, pnl: 0 },
    henery: { stake: 0, returned: 0, pnl: 0 },
  };
  for (const rec of recs) {
    for (const model of MODELS) {
      const s = settlementFor(rec, model);
      if (!s) continue;
      if (s.state === 'void') continue; // void = refund, not a real bet outcome
      agg[model].stake += s.totalStake;
      agg[model].returned += s.totalReturn;
      agg[model].pnl += s.totalProfit;
    }
  }
  return agg;
}

function rowsReconcile(rows: Row[]): Record<ModelKey, ReconAgg> {
  const agg: Record<ModelKey, ReconAgg> = {
    harville: { stake: 0, returned: 0, pnl: 0 },
    henery: { stake: 0, returned: 0, pnl: 0 },
  };
  for (const r of rows) {
    if (r.settlement_state !== 'settled') continue;
    const model = r.model as ModelKey | undefined;
    if (!model) continue;
    if (typeof r.total_stake_on_horse === 'number') agg[model].stake += r.total_stake_on_horse;
    if (typeof r.total_returned_on_horse === 'number')
      agg[model].returned += r.total_returned_on_horse;
    if (typeof r.pnl_on_horse === 'number') agg[model].pnl += r.pnl_on_horse;
  }
  return agg;
}

// ── Integrity counts ────────────────────────────────────────────────────

interface Integrity {
  pairsBothModels: number;
  pairsOneModelOnly: number;
  racesAnalysisBothModels: number;
  voidRaces: number;
  bel20260510Races: number;
  stakeDelta20260504: number;
}

function integrity(rows: Row[]): Integrity {
  // Group rows by (race_id, horse_number); count whether both models present.
  const byPair = new Map<string, Set<string>>();
  const byRace = new Map<string, { ap: boolean; models: Set<string> }>();
  const voids = new Set<string>();
  const bel0510 = new Set<string>();

  let stakeH0504 = 0;
  let stakeHe0504 = 0;

  for (const r of rows) {
    const rid = String(r.race_id ?? '');
    const hn = String(r.horse_number ?? '');
    const m = String(r.model ?? '');
    // Pair set
    if (hn !== '' && hn !== 'null') {
      const k = `${rid}|${hn}`;
      const s = byPair.get(k) ?? new Set<string>();
      s.add(m);
      byPair.set(k, s);
    }
    // Race-level: track analysis_present and models
    const rec = byRace.get(rid) ?? { ap: false, models: new Set<string>() };
    if (r.analysis_present === true) rec.ap = true;
    rec.models.add(m);
    byRace.set(rid, rec);
    // Voids
    if (r.settlement_state === 'void') voids.add(rid);
    // BEL-2026-05-10
    if (rid.startsWith('BEL-2026-05-10-')) bel0510.add(rid);
    // 2026-05-04 stake delta — sum of total_stake_on_horse for settled rows
    if (r.race_date === '2026-05-04' && r.settlement_state === 'settled') {
      const s = typeof r.total_stake_on_horse === 'number' ? r.total_stake_on_horse : 0;
      if (m === 'harville') stakeH0504 += s;
      else if (m === 'henery') stakeHe0504 += s;
    }
  }

  let pairsBoth = 0;
  let pairsOne = 0;
  for (const s of byPair.values()) {
    if (s.size === MODELS.length) pairsBoth++;
    else pairsOne++;
  }
  let racesApBoth = 0;
  for (const v of byRace.values()) {
    if (v.ap && MODELS.every((m) => v.models.has(m))) racesApBoth++;
  }

  return {
    pairsBothModels: pairsBoth,
    pairsOneModelOnly: pairsOne,
    racesAnalysisBothModels: racesApBoth,
    voidRaces: voids.size,
    bel20260510Races: bel0510.size,
    stakeDelta20260504: stakeH0504 - stakeHe0504,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────

function main(): void {
  if (!fs.existsSync(LOCKED_RECS_FILE)) {
    console.error(`error: ${LOCKED_RECS_FILE} not found`);
    process.exit(1);
  }
  const raw = fs.readFileSync(LOCKED_RECS_FILE, 'utf8');
  const recs = JSON.parse(raw) as LockedRecommendation[];
  if (!Array.isArray(recs)) {
    console.error(`error: ${LOCKED_RECS_FILE} did not parse to an array`);
    process.exit(1);
  }

  const allRows: Row[] = [];
  for (const rec of recs) {
    try {
      const rows = buildRowsForRec(rec);
      allRows.push(...rows);
    } catch (err) {
      console.warn(
        `warn: failed to build rows for race ${rec.raceId ?? '<unknown>'}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  const sorted = sortRows(allRows);
  writeCsv(sorted);

  const summary = summarize(sorted, recs);
  const recon = reconcile(recs);
  const reconFromRows = rowsReconcile(sorted);
  const intg = integrity(sorted);

  const pct = (a: number, b: number) => (b === 0 ? '0.0%' : `${((100 * a) / b).toFixed(1)}%`);
  const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
  const fmtRoi = (pnl: number, stake: number) =>
    stake === 0 ? '—' : `${((100 * pnl) / stake).toFixed(1)}%`;

  console.log('');
  console.log('=== EVALUATOR SUMMARY ===');
  console.log(`Total locked records:           ${summary.totalRecords}`);
  console.log(
    `Settled:                        ${summary.settled} (${pct(summary.settled, summary.totalRecords)})`,
  );
  console.log(`Void:                           ${summary.voidCount}`);
  console.log(`Pending:                        ${summary.pending}`);
  console.log(`Records with analysis snapshot: ${summary.recsWithAnalysis}`);
  console.log(
    `Records missing analysis:       ${summary.recsMissingAnalysis}  (older records — model-prob columns blank)`,
  );
  console.log(`Total horse-model rows emitted: ${summary.totalRows}`);
  console.log(`Rows with NaN p_win:            ${summary.nanPWin}  ← should be 0`);
  console.log(`Rows with NaN p_place_harville: ${summary.nanPPlaceHarv}  ← should be 0`);
  console.log(`Scratched horse rows:           ${summary.scratched}`);
  const tracksLine = [...summary.tracks.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} (${n} races)`)
    .join(', ');
  console.log(`Tracks covered:                 ${tracksLine || '—'}`);
  console.log(
    `Date range:                     ${summary.dateMin ?? '—'} to ${summary.dateMax ?? '—'}`,
  );
  console.log(
    `CSV written:                    ${path.relative(REPO_ROOT, OUT_FILE)}  (${summary.fileSizeMB.toFixed(2)} MB, ${summary.totalRows} data rows)`,
  );

  console.log('');
  console.log('=== P&L RECONCILIATION (settlement_state=settled) ===');
  console.log('                    Harville          Henery');
  console.log(
    `Total stake         ${fmtUsd(recon.harville.stake).padEnd(18)}${fmtUsd(recon.henery.stake)}`,
  );
  console.log(
    `Total returned      ${fmtUsd(recon.harville.returned).padEnd(18)}${fmtUsd(recon.henery.returned)}`,
  );
  console.log(
    `Net P&L             ${fmtUsd(recon.harville.pnl).padEnd(18)}${fmtUsd(recon.henery.pnl)}`,
  );
  console.log(
    `ROI                 ${fmtRoi(recon.harville.pnl, recon.harville.stake).padEnd(18)}${fmtRoi(recon.henery.pnl, recon.henery.stake)}`,
  );

  console.log('');
  console.log('=== CSV-DERIVED CHECK (sum of per-horse pnl_on_horse, settled rows) ===');
  const dHStake = Math.abs(recon.harville.stake - reconFromRows.harville.stake);
  const dHReturned = Math.abs(recon.harville.returned - reconFromRows.harville.returned);
  const dHPnl = Math.abs(recon.harville.pnl - reconFromRows.harville.pnl);
  const dEStake = Math.abs(recon.henery.stake - reconFromRows.henery.stake);
  const dEReturned = Math.abs(recon.henery.returned - reconFromRows.henery.returned);
  const dEPnl = Math.abs(recon.henery.pnl - reconFromRows.henery.pnl);
  const maxDelta = Math.max(dHStake, dHReturned, dHPnl, dEStake, dEReturned, dEPnl);
  console.log(
    `Harville (rows): stake ${fmtUsd(reconFromRows.harville.stake)}, return ${fmtUsd(reconFromRows.harville.returned)}, pnl ${fmtUsd(reconFromRows.harville.pnl)}`,
  );
  console.log(
    `Henery   (rows): stake ${fmtUsd(reconFromRows.henery.stake)}, return ${fmtUsd(reconFromRows.henery.returned)}, pnl ${fmtUsd(reconFromRows.henery.pnl)}`,
  );
  if (maxDelta < 0.005) {
    console.log(`Row-vs-settlement max delta:    ${fmtUsd(maxDelta)}  ✓ reconciled to the penny`);
  } else {
    console.log(
      `Row-vs-settlement max delta:    ${fmtUsd(maxDelta)}  ⚠ rows do not match settlement totals`,
    );
  }

  console.log('');
  console.log('=== INTEGRITY POST-FIX ===');
  console.log(`Race-horse pairs with both models populated:    ${intg.pairsBothModels}`);
  console.log(`Race-horse pairs with only one model:           ${intg.pairsOneModelOnly}`);
  console.log(`Races with analysis_present=true, both models:  ${intg.racesAnalysisBothModels}`);
  console.log(`Races with settlement_state='void':             ${intg.voidRaces}`);
  console.log(`BEL-2026-05-10 races in CSV:                    ${intg.bel20260510Races}`);
  console.log(`2026-05-04 stake delta (harville - henery):     ${fmtUsd(intg.stakeDelta20260504)}`);
  console.log('');
}

main();
