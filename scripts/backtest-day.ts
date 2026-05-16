/**
 * One-day backtest. Reads the 14 per-race xlsx exports under `export/`, applies
 * two betting policies side-by-side, and writes a styled comparison xlsx.
 *
 *   Policy A — One bet per race: $20 on the single best signal in the race.
 *   Policy B — Spread per race: $20 split equally across all signals in the
 *              top signal tier (slam_dunk if any exist, else lean).
 *
 * Bet selection rules (both policies):
 *   - Only SLAM_DUNK and LEAN horses qualify. DRIFT is a flag, not a bet.
 *   - For each qualifying horse, pick place vs show by which pool's edge fired:
 *       SLAM_DUNK → pool with positive Harville floor edge (larger if both)
 *       LEAN      → pool with Harville mid edge > 0.05 (larger if both)
 *   - Cash if horse finished top-2 (place) or top-3 (show).
 *   - Payout per $2 ticket × (stake/$2) = total return.
 */

import ExcelJS from 'exceljs';
import * as path from 'path';

const EXPORT_DIR = path.join(process.cwd(), 'export');
const FILES: Array<{ file: string; raceLabel: string }> = [
  { file: 'CD-R1-2026-05-02.xlsx', raceLabel: 'CD R1' },
  { file: 'CD-R2-2026-05-02.xlsx', raceLabel: 'CD R2' },
  { file: 'CD-R3-2026-05-02.xlsx', raceLabel: 'CD R3' },
  { file: 'CD-R4-2026-05-02.xlsx', raceLabel: 'CD R4' },
  { file: 'CD-R5-2026-05-02.xlsx', raceLabel: 'CD R5' },
  { file: 'CD-R6-2026-05-02.xlsx', raceLabel: 'CD R6' },
  { file: 'CD-R7-2026-05-02.xlsx', raceLabel: 'CD R7' },
  { file: 'CD-R8-2026-05-02.xlsx', raceLabel: 'CD R8' },
  { file: 'CD-R9-2026-05-02.xlsx', raceLabel: 'CD R9' },
  { file: 'CD-R10-2026-05-02.xlsx', raceLabel: 'CD R10' },
  { file: 'CD-R11-2026-05-02.xlsx', raceLabel: 'CD R11' },
  { file: 'CD-R12-2026-05-02.xlsx', raceLabel: 'CD R12' },
  { file: 'CD-R13-2026-05-03.xlsx', raceLabel: 'CD R13' },
  { file: 'CD-R14-2026-05-03.xlsx', raceLabel: 'CD R14' },
];

const STAKE_PER_RACE = 20; // dollars
const LEAN_THRESHOLD = 0.05;

type Pool = 'place' | 'show';
type Signal = 'slam_dunk' | 'lean' | 'drift' | 'none' | 'scratched';

interface HorseRow {
  program: string;
  name: string;
  signal: Signal;
  placeFairHarv: number | null;
  placeProjMid: number | null;
  placeEdgeHarvFloor: number | null;
  placeEdgeHarvMid: number | null;
  showFairHarv: number | null;
  showProjMid: number | null;
  showEdgeHarvFloor: number | null;
  showEdgeHarvMid: number | null;
}

interface OfficialResult {
  pos: number;
  program: string;
  name: string;
  winPayoff: number;
  placePayoff: number;
  showPayoff: number;
}

interface RaceData {
  raceLabel: string;
  totalWin: number | null;
  totalPlace: number | null;
  totalShow: number | null;
  status: string;
  horses: HorseRow[];
  results: OfficialResult[];
}

interface Bet {
  horseProgram: string;
  horseName: string;
  pool: Pool;
  signal: Signal;
  edge: number;
  fair: number;
  projMid: number;
  stake: number;
}

interface BetOutcome extends Bet {
  finishPos: number | null;
  cashed: boolean;
  payoffPer2: number;
  returned: number;
  profit: number;
}

interface RacePolicyResult {
  raceLabel: string;
  bets: BetOutcome[];
  staked: number;
  returned: number;
  profit: number;
  reason?: string; // for skipped races
}

// ── XLSX Reading ──────────────────────────────────────────────────────────

function cellNumber(v: ExcelJS.CellValue): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && 'result' in v) {
    const r = (v as { result?: unknown }).result;
    return typeof r === 'number' && Number.isFinite(r) ? r : null;
  }
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function cellString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && 'result' in v) return String((v as { result?: unknown }).result ?? '');
  if (typeof v === 'object' && 'richText' in v) {
    return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('');
  }
  return String(v);
}

function parseSignal(s: string): Signal {
  const u = s.trim().toUpperCase();
  if (u === 'SLAM DUNK') return 'slam_dunk';
  if (u === 'LEAN') return 'lean';
  if (u === 'DRIFT') return 'drift';
  if (u === 'SCRATCHED') return 'scratched';
  return 'none';
}

async function readRace(filePath: string, raceLabel: string): Promise<RaceData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  // Summary tab has the official results
  const summary = wb.worksheets[0];
  let totalWin: number | null = null;
  let totalPlace: number | null = null;
  let totalShow: number | null = null;
  let status = '';
  summary.eachRow({ includeEmpty: false }, (row) => {
    const a = cellString(row.getCell(1).value);
    const b = row.getCell(2).value;
    if (a === 'Status') status = cellString(b);
    if (a === 'Total Win pool') totalWin = cellNumber(b);
    if (a === 'Total Place pool') totalPlace = cellNumber(b);
    if (a === 'Total Show pool') totalShow = cellNumber(b);
  });

  // Find official results section
  const results: OfficialResult[] = [];
  let inResults = false;
  let resultsHeaderSeen = false;
  summary.eachRow({ includeEmpty: false }, (row) => {
    const c1 = cellString(row.getCell(1).value);
    if (c1 === 'OFFICIAL RESULTS') {
      inResults = true;
      return;
    }
    if (!inResults) return;
    if (c1 === 'PER-HORSE ANALYSIS' || c1 === 'LEGEND') {
      inResults = false;
      return;
    }
    if (c1 === 'Pos') {
      resultsHeaderSeen = true;
      return;
    }
    if (!resultsHeaderSeen) return;
    const pos = cellNumber(row.getCell(1).value);
    const program = cellString(row.getCell(2).value);
    const name = cellString(row.getCell(3).value);
    if (pos !== null && program) {
      results.push({
        pos,
        program,
        name,
        winPayoff: cellNumber(row.getCell(4).value) ?? 0,
        placePayoff: cellNumber(row.getCell(5).value) ?? 0,
        showPayoff: cellNumber(row.getCell(6).value) ?? 0,
      });
    }
  });

  // Full Analysis tab has per-horse signals + edges
  const fullName = wb.worksheets.find((w) => w.name.startsWith('Full '));
  if (!fullName) {
    throw new Error(`No "Full" sheet in ${filePath}`);
  }
  const horses: HorseRow[] = [];
  // Header row is row 2; data starts at row 3
  const lastRow = fullName.actualRowCount;
  for (let r = 3; r <= lastRow; r++) {
    const program = cellString(fullName.getCell(r, 1).value);
    if (!program) continue;
    horses.push({
      program,
      name: cellString(fullName.getCell(r, 2).value),
      signal: parseSignal(cellString(fullName.getCell(r, 35).value)),
      placeFairHarv: cellNumber(fullName.getCell(r, 19).value),
      placeProjMid: cellNumber(fullName.getCell(r, 17).value),
      placeEdgeHarvFloor: cellNumber(fullName.getCell(r, 21).value),
      placeEdgeHarvMid: cellNumber(fullName.getCell(r, 22).value),
      showFairHarv: cellNumber(fullName.getCell(r, 29).value),
      showProjMid: cellNumber(fullName.getCell(r, 27).value),
      showEdgeHarvFloor: cellNumber(fullName.getCell(r, 31).value),
      showEdgeHarvMid: cellNumber(fullName.getCell(r, 32).value),
    });
  }

  return {
    raceLabel,
    totalWin,
    totalPlace,
    totalShow,
    status,
    horses,
    results,
  };
}

// ── Bet selection ─────────────────────────────────────────────────────────

interface Candidate {
  program: string;
  name: string;
  signal: 'slam_dunk' | 'lean';
  pool: Pool;
  edge: number;
  fair: number;
  projMid: number;
}

function makeCandidate(
  h: HorseRow,
): Candidate | null {
  if (h.signal !== 'slam_dunk' && h.signal !== 'lean') return null;

  // Choose pool by which side fired.
  let pool: Pool;
  let edge: number;
  let fair: number;
  let projMid: number;

  if (h.signal === 'slam_dunk') {
    const p = h.placeEdgeHarvFloor ?? -Infinity;
    const s = h.showEdgeHarvFloor ?? -Infinity;
    if (p > 0 && s > 0) {
      pool = p >= s ? 'place' : 'show';
    } else if (p > 0) {
      pool = 'place';
    } else if (s > 0) {
      pool = 'show';
    } else {
      return null; // shouldn't happen — slam_dunk requires positive floor
    }
    edge = pool === 'place' ? p : s;
  } else {
    // lean
    const p = h.placeEdgeHarvMid ?? -Infinity;
    const s = h.showEdgeHarvMid ?? -Infinity;
    if (p > LEAN_THRESHOLD && s > LEAN_THRESHOLD) {
      pool = p >= s ? 'place' : 'show';
    } else if (p > LEAN_THRESHOLD) {
      pool = 'place';
    } else if (s > LEAN_THRESHOLD) {
      pool = 'show';
    } else {
      return null;
    }
    edge = pool === 'place' ? p : s;
  }

  fair = pool === 'place' ? (h.placeFairHarv ?? 0) : (h.showFairHarv ?? 0);
  projMid = pool === 'place' ? (h.placeProjMid ?? 0) : (h.showProjMid ?? 0);

  return {
    program: h.program,
    name: h.name,
    signal: h.signal,
    pool,
    edge,
    fair,
    projMid,
  };
}

function selectCandidates(race: RaceData): Candidate[] {
  const out: Candidate[] = [];
  for (const h of race.horses) {
    const c = makeCandidate(h);
    if (c) out.push(c);
  }
  return out;
}

// Policy A: pick single best signal in race
function pickPolicyA(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  const slamDunks = candidates.filter((c) => c.signal === 'slam_dunk');
  const pool = slamDunks.length > 0 ? slamDunks : candidates;
  // Highest edge wins
  return pool.slice().sort((a, b) => b.edge - a.edge)[0];
}

// Policy B: split $20 across the highest signal tier present, edge-weighted with whole-dollar rounding
interface AllocatedBet {
  candidate: Candidate;
  stake: number;
}

function pickPolicyB(candidates: Candidate[]): AllocatedBet[] {
  if (candidates.length === 0) return [];
  const slamDunks = candidates.filter((c) => c.signal === 'slam_dunk');
  const pool = slamDunks.length > 0 ? slamDunks : candidates;

  const n = pool.length;
  if (n === 1) return [{ candidate: pool[0], stake: STAKE_PER_RACE }];

  // Edge-weighted base allocation, then round to whole dollars while preserving total.
  const edges = pool.map((c) => Math.max(c.edge, 0.0001));
  const sumE = edges.reduce((a, b) => a + b, 0);
  const rawShares = edges.map((e) => (e / sumE) * STAKE_PER_RACE);
  // Floor each, then distribute remainder to highest-edge horses
  const floored = rawShares.map(Math.floor);
  let used = floored.reduce((a, b) => a + b, 0);
  let remainder = STAKE_PER_RACE - used;
  // Sort by raw share descending (largest edge gets remainder $1s first)
  const order = pool
    .map((_, i) => i)
    .sort((a, b) => rawShares[b] - rawShares[a]);
  for (const idx of order) {
    if (remainder <= 0) break;
    floored[idx] += 1;
    remainder -= 1;
  }
  // Drop any bets under $2 (pari-mutuel minimum) by reallocating to the rest
  const result: AllocatedBet[] = [];
  for (let i = 0; i < pool.length; i++) {
    if (floored[i] >= 2) {
      result.push({ candidate: pool[i], stake: floored[i] });
    }
  }
  // If we dropped bets, redistribute their stake to the top by edge
  const totalAfter = result.reduce((a, b) => a + b.stake, 0);
  let leftover = STAKE_PER_RACE - totalAfter;
  if (leftover > 0 && result.length > 0) {
    result.sort((a, b) => b.candidate.edge - a.candidate.edge);
    let i = 0;
    while (leftover > 0) {
      result[i % result.length].stake += 1;
      leftover -= 1;
      i++;
    }
  }
  return result;
}

// ── Outcome computation ──────────────────────────────────────────────────

function settleBet(
  candidate: Candidate,
  stake: number,
  results: OfficialResult[],
): BetOutcome {
  const result = results.find((r) => r.program === candidate.program);
  const finishPos = result?.pos ?? null;
  const cashes =
    result !== undefined &&
    ((candidate.pool === 'place' && (result.pos === 1 || result.pos === 2)) ||
      (candidate.pool === 'show' && (result.pos === 1 || result.pos === 2 || result.pos === 3)));
  const payoffPer2 = cashes
    ? candidate.pool === 'place'
      ? result!.placePayoff
      : result!.showPayoff
    : 0;
  const tickets = stake / 2;
  const returned = cashes ? tickets * payoffPer2 : 0;
  return {
    horseProgram: candidate.program,
    horseName: candidate.name,
    pool: candidate.pool,
    signal: candidate.signal,
    edge: candidate.edge,
    fair: candidate.fair,
    projMid: candidate.projMid,
    stake,
    finishPos,
    cashed: cashes,
    payoffPer2,
    returned,
    profit: returned - stake,
  };
}

function runPolicyA(race: RaceData): RacePolicyResult {
  const candidates = selectCandidates(race);
  if (race.results.length === 0) {
    return {
      raceLabel: race.raceLabel,
      bets: [],
      staked: 0,
      returned: 0,
      profit: 0,
      reason: 'no_official_results',
    };
  }
  const pick = pickPolicyA(candidates);
  if (!pick) {
    return {
      raceLabel: race.raceLabel,
      bets: [],
      staked: 0,
      returned: 0,
      profit: 0,
      reason: 'no_qualifying_signal',
    };
  }
  const outcome = settleBet(pick, STAKE_PER_RACE, race.results);
  return {
    raceLabel: race.raceLabel,
    bets: [outcome],
    staked: STAKE_PER_RACE,
    returned: outcome.returned,
    profit: outcome.profit,
  };
}

function runPolicyB(race: RaceData): RacePolicyResult {
  const candidates = selectCandidates(race);
  if (race.results.length === 0) {
    return {
      raceLabel: race.raceLabel,
      bets: [],
      staked: 0,
      returned: 0,
      profit: 0,
      reason: 'no_official_results',
    };
  }
  const allocations = pickPolicyB(candidates);
  if (allocations.length === 0) {
    return {
      raceLabel: race.raceLabel,
      bets: [],
      staked: 0,
      returned: 0,
      profit: 0,
      reason: 'no_qualifying_signal',
    };
  }
  const outcomes = allocations.map((a) => settleBet(a.candidate, a.stake, race.results));
  const staked = outcomes.reduce((a, b) => a + b.stake, 0);
  const returned = outcomes.reduce((a, b) => a + b.returned, 0);
  return {
    raceLabel: race.raceLabel,
    bets: outcomes,
    staked,
    returned,
    profit: returned - staked,
  };
}

// ── Output xlsx ──────────────────────────────────────────────────────────

const COLORS = {
  titleFill: 'FF1F2937',
  titleText: 'FFFEF3C7',
  subtitleFill: 'FF111827',
  subtitleText: 'FFFCD34D',
  narrativeFill: 'FF18181B',
  narrativeText: 'FFE5E7EB',
  headerFill: 'FF374151',
  headerText: 'FFF3F4F6',
  cellFill: 'FF1F2937',
  cellText: 'FFE5E7EB',
  cashedFill: 'FF14532D',
  cashedText: 'FFD1FAE5',
  lostFill: 'FF7F1D1D',
  lostText: 'FFFEE2E2',
  skipFill: 'FF27272A',
  skipText: 'FF9CA3AF',
  profitGreenFill: 'FF166534',
  profitGreenText: 'FFFFFFFF',
  profitRedFill: 'FFB91C1C',
  profitRedText: 'FFFFFFFF',
  border: 'FF52525B',
};

function fillCell(
  cell: ExcelJS.Cell,
  fill: string,
  text: string,
  bold = false,
  size?: number,
): void {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  cell.font = { color: { argb: text }, bold, size };
  cell.border = {
    top: { style: 'thin', color: { argb: COLORS.border } },
    bottom: { style: 'thin', color: { argb: COLORS.border } },
    left: { style: 'thin', color: { argb: COLORS.border } },
    right: { style: 'thin', color: { argb: COLORS.border } },
  };
}

function writeNarrative(
  ws: ExcelJS.Worksheet,
  startRow: number,
  cols: number,
  paragraphs: string[],
): number {
  let r = startRow;
  for (const p of paragraphs) {
    ws.mergeCells(r, 1, r, cols);
    const c = ws.getCell(r, 1);
    c.value = p;
    fillCell(c, COLORS.narrativeFill, COLORS.narrativeText);
    c.alignment = { wrapText: true, vertical: 'top', horizontal: 'left' };
    // Auto-grow row height a bit for long paragraphs
    const lines = Math.max(1, Math.ceil(p.length / 110));
    ws.getRow(r).height = 14 * lines + 6;
    r++;
  }
  return r;
}

function writeSectionTitle(
  ws: ExcelJS.Worksheet,
  row: number,
  cols: number,
  text: string,
  size = 13,
): void {
  ws.mergeCells(row, 1, row, cols);
  const c = ws.getCell(row, 1);
  c.value = text;
  fillCell(c, COLORS.titleFill, COLORS.titleText, true, size);
  c.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(row).height = 24;
}

function writeKpiTable(
  ws: ExcelJS.Worksheet,
  startRow: number,
  policyName: string,
  result: { totalRaces: number; betsPlaced: number; cashedBets: number; staked: number; returned: number; profit: number; racesWithBets: number; racesSkipped: number },
): number {
  // Header row
  const headers = [
    'Policy',
    'Races',
    'Races bet',
    'Races skipped',
    'Tickets',
    'Tickets cashed',
    'Hit rate',
    'Staked',
    'Returned',
    'Net P/L',
    'ROI',
  ];
  headers.forEach((h, i) => {
    const c = ws.getCell(startRow, i + 1);
    c.value = h;
    fillCell(c, COLORS.headerFill, COLORS.headerText, true);
    c.alignment = { horizontal: 'center', wrapText: true };
  });

  const r = startRow + 1;
  const hitRate = result.betsPlaced > 0 ? result.cashedBets / result.betsPlaced : 0;
  const roi = result.staked > 0 ? result.profit / result.staked : 0;

  const profitFill = result.profit >= 0 ? COLORS.profitGreenFill : COLORS.profitRedFill;
  const profitText = result.profit >= 0 ? COLORS.profitGreenText : COLORS.profitRedText;

  const cells: Array<[ExcelJS.CellValue, string?, string?, string?]> = [
    [policyName, COLORS.cellFill, COLORS.cellText],
    [result.totalRaces, COLORS.cellFill, COLORS.cellText],
    [result.racesWithBets, COLORS.cellFill, COLORS.cellText],
    [result.racesSkipped, COLORS.cellFill, COLORS.cellText],
    [result.betsPlaced, COLORS.cellFill, COLORS.cellText],
    [result.cashedBets, COLORS.cellFill, COLORS.cellText],
    [hitRate, COLORS.cellFill, COLORS.cellText, '0.0%'],
    [result.staked, COLORS.cellFill, COLORS.cellText, '"$"#,##0.00'],
    [result.returned, COLORS.cellFill, COLORS.cellText, '"$"#,##0.00'],
    [result.profit, profitFill, profitText, '"$"#,##0.00'],
    [roi, profitFill, profitText, '0.0%'],
  ];
  cells.forEach(([value, fill, text, fmt], i) => {
    const c = ws.getCell(r, i + 1);
    c.value = value;
    fillCell(c, fill ?? COLORS.cellFill, text ?? COLORS.cellText, i === 0 || i === 9 || i === 10);
    if (fmt) c.numFmt = fmt;
    c.alignment = { horizontal: 'center' };
  });

  return r + 1;
}

function aggregate(
  raceResults: RacePolicyResult[],
): { totalRaces: number; betsPlaced: number; cashedBets: number; staked: number; returned: number; profit: number; racesWithBets: number; racesSkipped: number } {
  let staked = 0;
  let returned = 0;
  let profit = 0;
  let cashedBets = 0;
  let betsPlaced = 0;
  let racesWithBets = 0;
  let racesSkipped = 0;
  for (const r of raceResults) {
    staked += r.staked;
    returned += r.returned;
    profit += r.profit;
    betsPlaced += r.bets.length;
    cashedBets += r.bets.filter((b) => b.cashed).length;
    if (r.bets.length > 0) racesWithBets++;
    else racesSkipped++;
  }
  return {
    totalRaces: raceResults.length,
    betsPlaced,
    cashedBets,
    staked,
    returned,
    profit,
    racesWithBets,
    racesSkipped,
  };
}

function writeRaceDetailHeader(ws: ExcelJS.Worksheet, row: number): void {
  const headers = [
    'Race',
    'Horse',
    'Signal',
    'Pool',
    'Edge',
    'Fair $',
    'Proj Mid $',
    'Stake',
    'Finish',
    'Cashed?',
    'Payoff/$2',
    'Returned',
    'Net',
  ];
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h;
    fillCell(c, COLORS.headerFill, COLORS.headerText, true);
    c.alignment = { horizontal: 'center' };
  });
  ws.getRow(row).height = 22;
}

function writeRaceDetailRow(
  ws: ExcelJS.Worksheet,
  row: number,
  raceLabel: string,
  outcome: BetOutcome,
): void {
  const fill = outcome.cashed ? COLORS.cashedFill : COLORS.lostFill;
  const text = outcome.cashed ? COLORS.cashedText : COLORS.lostText;
  const cells: Array<[ExcelJS.CellValue, string?]> = [
    [raceLabel],
    [`#${outcome.horseProgram} ${outcome.horseName}`],
    [outcome.signal === 'slam_dunk' ? 'SLAM DUNK' : 'LEAN'],
    [outcome.pool.toUpperCase()],
    [outcome.edge, '0.0%'],
    [outcome.fair, '"$"#,##0.00'],
    [outcome.projMid, '"$"#,##0.00'],
    [outcome.stake, '"$"#,##0'],
    [outcome.finishPos ?? '—'],
    [outcome.cashed ? 'YES' : 'NO'],
    [outcome.payoffPer2 || '', '"$"#,##0.00'],
    [outcome.returned, '"$"#,##0.00'],
    [outcome.profit, '"$"#,##0.00'],
  ];
  cells.forEach(([v, fmt], i) => {
    const c = ws.getCell(row, i + 1);
    c.value = v;
    fillCell(c, fill, text, i === 12);
    if (fmt) c.numFmt = fmt;
    c.alignment = { horizontal: i === 1 ? 'left' : 'center' };
  });
}

function writeSkippedRaceRow(
  ws: ExcelJS.Worksheet,
  row: number,
  raceLabel: string,
  reason: string,
): void {
  const cells = [raceLabel, '(no bet)', reason, '', '', '', '', 0, '—', '—', '', 0, 0];
  cells.forEach((v, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = v;
    fillCell(c, COLORS.skipFill, COLORS.skipText);
    if (i === 7) c.numFmt = '"$"#,##0';
    if (i === 11 || i === 12) c.numFmt = '"$"#,##0.00';
    c.alignment = { horizontal: i === 1 || i === 2 ? 'left' : 'center' };
  });
}

async function main(): Promise<void> {
  console.log('Reading races…');
  const races: RaceData[] = [];
  for (const { file, raceLabel } of FILES) {
    const fp = path.join(EXPORT_DIR, file);
    const r = await readRace(fp, raceLabel);
    races.push(r);
    console.log(`  ${raceLabel}: ${r.horses.length} horses, ${r.results.length} official results`);
  }

  console.log('Running policies…');
  const aResults = races.map(runPolicyA);
  const bResults = races.map(runPolicyB);
  const aTotals = aggregate(aResults);
  const bTotals = aggregate(bResults);

  console.log('\n── Policy A (one bet per race) ──');
  console.log(aTotals);
  console.log('\n── Policy B (spread across signals) ──');
  console.log(bTotals);

  // ── Build the output workbook ─────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Horseplay';
  wb.created = new Date();

  // Sheet 1: Backtest Summary
  const ws = wb.addWorksheet('Backtest', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const COLS = 11;
  for (let i = 1; i <= COLS; i++) ws.getColumn(i).width = 13;
  ws.getColumn(2).width = 22;

  // Title
  writeSectionTitle(ws, 1, COLS, 'Horseplay Backtest — May 2–3, 2026 (CD R1–R14)', 16);
  ws.getRow(1).height = 30;

  // Subtitle
  ws.mergeCells(2, 1, 2, COLS);
  const sub = ws.getCell(2, 1);
  sub.value = `${races.length} races · stake $${STAKE_PER_RACE} per race · two policies compared`;
  fillCell(sub, COLORS.subtitleFill, COLORS.subtitleText, true, 11);
  sub.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(2).height = 20;

  // Pre-table narrative
  let row = 4;
  row = writeNarrative(ws, row, COLS, [
    'METHOD AND ASSUMPTIONS',
    'This backtest replays the day of CD May 2–3, 2026 using the per-race xlsx exports as the source of truth. Each race export already contains the live FanDuel pool snapshot taken at compute time plus the official finish-position payoffs. The backtest never re-simulates the math; it uses the exported signals and edges as the bet-selection input and the exported official Place $ / Show $ payoffs as the realized outcome.',
    `Stake budget: a flat $${STAKE_PER_RACE} per race. If no horse in a race carried a SLAM_DUNK or LEAN signal, the race is skipped and zero dollars are staked. DRIFT is treated as a flag, not a recommendation, so DRIFT-only signals never trigger a bet (this matches the spec).`,
    'Bet-type selection per qualifying horse: SLAM_DUNK bets the pool whose Harville FLOOR edge is positive (place if Place Edge Harv Floor > 0, show if Show Edge Harv Floor > 0; if both, the larger floor edge wins). LEAN bets the pool whose Harville MID edge clears the 5% threshold (same tiebreak rule). When both pools qualify on the same horse, only the larger-edge pool gets the ticket; we do not double-bet a single horse.',
    'POLICY A — One bet per race. Pick the single best signal in the race (SLAM_DUNK beats LEAN, ties broken by edge size). Stake $20 on that one ticket. This is the most concentrated policy: maximum exposure to one bet but only when the signal is unambiguous.',
    `POLICY B — Spread $20 across signals. Identify the highest signal tier present in the race (SLAM_DUNK if any exist, otherwise LEAN). Allocate the $${STAKE_PER_RACE} budget edge-weighted across all qualifying horses in that tier, rounded to whole dollars (pari-mutuel minimum is $2). If only one horse qualifies, Policy B collapses to Policy A for that race. This is the more diversified policy: lower variance per race, more transactions, spread risk.`,
    'Cash conditions: a place ticket cashes if the horse finished 1st or 2nd; a show ticket cashes if 1st, 2nd, or 3rd. Return = (stake / $2) × officialPayoff. Profit = Return − Stake. A losing ticket returns $0 and the full stake is lost.',
    'What this backtest does NOT capture: timing risk (we used the snapshot at compute time, not what was on the board when you would have actually placed the bet), liquidity at FanDuel for actual ticket fills, late scratches affecting projected payouts, or any subjective handicapping override beyond the dashboard signals.',
  ]);

  row += 1;
  writeSectionTitle(ws, row, COLS, 'P&L Summary — Both Policies Side-by-Side', 14);
  row += 1;
  row = writeKpiTable(ws, row, 'Policy A (single best signal)', aTotals);
  row = writeKpiTable(ws, row, 'Policy B (spread across signals)', bTotals);

  // Post-table narrative
  row += 1;
  const aProfitWord = aTotals.profit >= 0 ? 'profit' : 'loss';
  const bProfitWord = bTotals.profit >= 0 ? 'profit' : 'loss';
  const winner =
    aTotals.profit > bTotals.profit
      ? 'Policy A came out ahead'
      : aTotals.profit < bTotals.profit
        ? 'Policy B came out ahead'
        : 'Both policies tied';

  row = writeNarrative(ws, row, COLS, [
    'WHAT HAPPENED',
    `Across the ${races.length}-race card with ${aTotals.racesWithBets} qualifying races for Policy A and ${bTotals.racesWithBets} for Policy B, ${winner}. Policy A staked $${aTotals.staked.toFixed(2)} across ${aTotals.betsPlaced} tickets and ended with a net ${aProfitWord} of $${Math.abs(aTotals.profit).toFixed(2)} (ROI ${(aTotals.profit / Math.max(1, aTotals.staked) * 100).toFixed(1)}%). Policy B staked $${bTotals.staked.toFixed(2)} across ${bTotals.betsPlaced} tickets and ended with a net ${bProfitWord} of $${Math.abs(bTotals.profit).toFixed(2)} (ROI ${(bTotals.profit / Math.max(1, bTotals.staked) * 100).toFixed(1)}%).`,
    `Hit rates: Policy A cashed ${aTotals.cashedBets}/${aTotals.betsPlaced} tickets (${(aTotals.cashedBets / Math.max(1, aTotals.betsPlaced) * 100).toFixed(0)}%), Policy B cashed ${bTotals.cashedBets}/${bTotals.betsPlaced} (${(bTotals.cashedBets / Math.max(1, bTotals.betsPlaced) * 100).toFixed(0)}%). Hit rate alone is not a proxy for profit because pari-mutuel payouts vary by horse — a 30%-hit-rate run on longshot place tickets can outearn a 70%-hit-rate run on heavy chalk show tickets.`,
    'How to read this: pari-mutuel takeout is structurally negative-sum, so any honest backtest where the policy is calibrated correctly should show ROI between roughly −15% (the takeout) and a small positive number when the model is working. Big positive ROI on a single day is more likely variance than skill — wait for the multi-day sample to grow before reading too much into one card. Big negative ROI in a card with all-LEAN bets and no SLAM_DUNKs is consistent with the LEAN threshold being too aggressive (the worked example in horseplay.md showed exactly this on R5).',
    'For per-bet detail and to see exactly which signal/horse combos drove the result, see the "Per-Race Detail (A)" and "Per-Race Detail (B)" tabs.',
  ]);

  // Sheet 2: Per-Race Detail (A)
  const wsA = wb.addWorksheet('Per-Race Detail (A)', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });
  for (let i = 1; i <= 13; i++) wsA.getColumn(i).width = 13;
  wsA.getColumn(2).width = 26;
  writeSectionTitle(wsA, 1, 13, 'Policy A — One bet per race ($20 on best signal)', 13);
  writeRaceDetailHeader(wsA, 2);
  let r2 = 3;
  for (const result of aResults) {
    if (result.bets.length === 0) {
      writeSkippedRaceRow(wsA, r2, result.raceLabel, result.reason ?? 'no_bet');
    } else {
      for (const bet of result.bets) {
        writeRaceDetailRow(wsA, r2, result.raceLabel, bet);
      }
    }
    r2++;
  }
  // Totals row
  const totalsRowA = r2 + 1;
  const totalsCellsA: Array<[string | number, string?]> = [
    ['TOTALS', undefined],
    ['', undefined],
    ['', undefined],
    ['', undefined],
    ['', undefined],
    ['', undefined],
    ['', undefined],
    [aTotals.staked, '"$"#,##0.00'],
    ['', undefined],
    [`${aTotals.cashedBets}/${aTotals.betsPlaced}`, undefined],
    ['', undefined],
    [aTotals.returned, '"$"#,##0.00'],
    [aTotals.profit, '"$"#,##0.00'],
  ];
  totalsCellsA.forEach(([v, fmt], i) => {
    const c = wsA.getCell(totalsRowA, i + 1);
    c.value = v;
    const fill = aTotals.profit >= 0 ? COLORS.profitGreenFill : COLORS.profitRedFill;
    const text = aTotals.profit >= 0 ? COLORS.profitGreenText : COLORS.profitRedText;
    fillCell(c, fill, text, true);
    if (fmt) c.numFmt = fmt;
    c.alignment = { horizontal: 'center' };
  });

  // Sheet 3: Per-Race Detail (B)
  const wsB = wb.addWorksheet('Per-Race Detail (B)', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });
  for (let i = 1; i <= 13; i++) wsB.getColumn(i).width = 13;
  wsB.getColumn(2).width = 26;
  writeSectionTitle(wsB, 1, 13, 'Policy B — Spread $20 across signals', 13);
  writeRaceDetailHeader(wsB, 2);
  let r3 = 3;
  for (const result of bResults) {
    if (result.bets.length === 0) {
      writeSkippedRaceRow(wsB, r3, result.raceLabel, result.reason ?? 'no_bet');
      r3++;
    } else {
      for (const bet of result.bets) {
        writeRaceDetailRow(wsB, r3, result.raceLabel, bet);
        r3++;
      }
    }
  }
  const totalsRowB = r3 + 1;
  const totalsCellsB: Array<[string | number, string?]> = [
    ['TOTALS', undefined],
    ['', undefined],
    ['', undefined],
    ['', undefined],
    ['', undefined],
    ['', undefined],
    ['', undefined],
    [bTotals.staked, '"$"#,##0.00'],
    ['', undefined],
    [`${bTotals.cashedBets}/${bTotals.betsPlaced}`, undefined],
    ['', undefined],
    [bTotals.returned, '"$"#,##0.00'],
    [bTotals.profit, '"$"#,##0.00'],
  ];
  totalsCellsB.forEach(([v, fmt], i) => {
    const c = wsB.getCell(totalsRowB, i + 1);
    c.value = v;
    const fill = bTotals.profit >= 0 ? COLORS.profitGreenFill : COLORS.profitRedFill;
    const text = bTotals.profit >= 0 ? COLORS.profitGreenText : COLORS.profitRedText;
    fillCell(c, fill, text, true);
    if (fmt) c.numFmt = fmt;
    c.alignment = { horizontal: 'center' };
  });

  const outPath = path.join(EXPORT_DIR, 'backtest-2026-05-02-day.xlsx');
  await wb.xlsx.writeFile(outPath);
  console.log(`\nWrote ${outPath}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
