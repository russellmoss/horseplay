export type DecimalOdds = number;
export type Dollars = number;

export interface Horse {
  program: string;
  name: string;
  jockey?: string;
  trainer?: string;
  mlOdds: DecimalOdds | null;
  currentOdds: DecimalOdds | null;
  winPoolDollars: Dollars | null;
  placePoolDollars: Dollars | null;
  showPoolDollars: Dollars | null;
  scratched: boolean;
}

export interface Race {
  raceId: string;
  trackCode: string;
  raceNumber: number;
  postTimeUtc: string;
  status: 'open' | 'closed' | 'official';
  horses: Horse[];
  totalWinPool?: Dollars;
  totalPlacePool?: Dollars;
  totalShowPool?: Dollars;
  /**
   * Exotic pool sizes. We don't currently project per-combination payouts,
   * but knowing pool size matters: a probability-fair exacta combo can still
   * be -EV in realization if the pool is too small to actually pay it.
   * FDR wager-type codes:
   *   EX = exacta, TR = trifecta, SU = superfecta, SH5 = super high five
   *   DB = daily double, P3 = pick 3, P6 = pick 6
   */
  totalExactaPool?: Dollars;
  totalTrifectaPool?: Dollars;
  totalSuperfectaPool?: Dollars;
  totalSuperHighFivePool?: Dollars;
  totalDailyDoublePool?: Dollars;
  totalPick3Pool?: Dollars;
  totalPick6Pool?: Dollars;
  lastUpdate: string;
  /** FDR-internal numeric race ID. Required to (re)subscribe to live updates. */
  tvgRaceId?: number;
  /** Populated once the race goes official; carries finish positions and actual payouts. */
  results?: RaceResults | null;
}

export interface RaceResultRunner {
  finishPosition: number;
  program: string;
  name: string;
  /** Per-$2 payouts. Zero for horses outside the relevant top-N. */
  winPayoff: number;
  placePayoff: number;
  showPayoff: number;
}

/**
 * Official exotic payout entry, one per wager type.
 * `selection` is dash-separated program numbers in finish order, e.g. "11-3"
 * for an exacta or "11-3-4" for a trifecta. Match by string equality against
 * a candidate ticket's selection ordering (or against any permutation, for
 * box tickets).
 */
export interface ExoticPayoff {
  wagerCode: string;
  /** Base unit the payoutAmount is per (e.g. 2.0 for exacta, 0.5 for trifecta). */
  wagerAmount: number;
  selection: string;
  payoutAmount: number;
}

export interface RaceResults {
  runners: RaceResultRunner[];
  /** Winning time in seconds, when reported. */
  winningTimeSeconds: number | null;
  /** Official payouts for exotic wagers (EX, TR, SU). Empty for fresh / pending races. */
  exoticPayoffs?: ExoticPayoff[];
}

export interface ModelOutput {
  pPlaceFair: number;
  pShowFair: number;
  placeFairPayout: number | null;
  showFairPayout: number | null;
}

export interface PayoutBand {
  floor: number | null;
  mid: number | null;
  ceiling: number | null;
}

export interface EdgeBundle {
  heuristicFloor: number | null;
  heuristicMid: number | null;
  harvilleFloor: number | null;
  harvilleMid: number | null;
  /**
   * Henery edges run as a SHADOW alongside Harville for model-comparison
   * purposes. Same `projected` band as Harville (the projection is a
   * pool-state estimate, not a model output) — only the `fair` price differs.
   * Not consumed by `classifySignal` for v1.
   */
  heneryFloor: number | null;
  heneryMid: number | null;
}

export type Signal = 'slam_dunk' | 'lean' | 'drift' | 'none';

export interface HorseAnalysis {
  program: string;
  name: string;
  mlOdds: DecimalOdds | null;
  currentOdds: DecimalOdds | null;
  currentFractional: string;
  mlDrift: number | null;
  /** FLB-calibrated win probability (used everywhere downstream). */
  pWin: number;
  /**
   * Uncalibrated public-pool-implied win probability, BEFORE the
   * favorite-longshot bias correction. Useful for observability — the delta
   * between pWinRaw and pWin shows the size of the FLB correction applied.
   * Always equals pWin for `uniform_fallback` source (no correction applied).
   */
  pWinRaw: number;
  heuristic: ModelOutput;
  harville: ModelOutput;
  /**
   * Henery (Stern) finishing-order model output — runs in parallel with
   * Harville. Used by the bet-planner when invoked with model='henery' so
   * we can A/B compare which model produces better post-race P&L.
   */
  henery: ModelOutput;
  placeProjected: PayoutBand;
  showProjected: PayoutBand;
  placeEdge: EdgeBundle;
  showEdge: EdgeBundle;
  /** Win-pool fields. The win pool is the most efficient market — `winEdge`
   * is structurally near -takeout (~-15%) for almost every horse. Useful
   * mostly as a sanity check; +EV win bets are rare. */
  winFairPayout: number | null;
  winProjected: number | null;
  winEdge: number | null;
  signal: Signal;
}

export type ProbSource = 'win_pool' | 'decimal_odds' | 'uniform_fallback';

export interface RaceAnalysis {
  race: Race;
  probSource: ProbSource;
  rows: HorseAnalysis[];
  computedAt: string;
}
