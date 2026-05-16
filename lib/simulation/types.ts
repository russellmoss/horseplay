/**
 * Types for the live betting simulation: structured tickets the AI plans at
 * T-1:00, plus settlement against official results.
 */

export type TicketType =
  | 'win'
  | 'place'
  | 'show'
  | 'exacta_straight'
  | 'exacta_box'
  | 'trifecta_straight'
  | 'trifecta_box';

export interface BetTicket {
  type: TicketType;
  /**
   * Program numbers selected on this ticket.
   *   win/place/show:      single horse, e.g. ['5']
   *   exacta_straight:     [first, second]    — order matters
   *   exacta_box:          [a, b, ...]        — N(N-1) permutations
   *   trifecta_straight:   [first, second, third]
   *   trifecta_box:        [a, b, c, ...]     — N(N-1)(N-2) permutations
   */
  horses: string[];
  /**
   * Total ticket cost in whole dollars (what you pay at the window).
   * For boxed tickets this is the box-total, NOT the per-combination amount.
   */
  amount: number;
  /** AI's per-ticket reasoning (one short sentence). */
  reason?: string;
}

/**
 * Which finishing-order model produced the prices/edges the bet planner
 * was reasoning over. Used to A/B compare post-race P&L between models.
 */
export type ModelKey = 'harville' | 'henery';

export interface LockedBetPlan {
  raceId: string;
  /** ISO timestamp the plan was generated. */
  lockedAt: string;
  tickets: BetTicket[];
  /** Sum of ticket.amount across all tickets. Should be ≤ $20. */
  totalStake: number;
  /** AI's overall rationale for this allocation. */
  rationale: string;
  /**
   * Which model the AI was shown when picking these tickets. Set on every
   * plan locked since the model-comparison feature shipped; older plans
   * (pre-feature) lack this and should be treated as 'harville'.
   */
  model?: ModelKey;
  /**
   * Post-race analytical writeup, generated ONCE when the race goes official
   * and frozen here. Dispassionate, not the bookmaker bro voice. Only
   * generated for the Harville plan to keep API costs bounded.
   */
  postRaceNarrative?: string;
  postRaceNarrativeAt?: string;
}

/**
 * One ticket plus its outcome after settlement against official results.
 */
export interface SettledTicket extends BetTicket {
  /** True if any combination on the ticket matched the official outcome. */
  cashed: boolean;
  /** Official payout per the wager unit (e.g. per $2 for WPS/Exacta, per $0.50 for Trifecta). */
  payoutPerUnit: number;
  /** Wager unit used (2.0 for WPS/Exacta, 0.5 for Trifecta default — taken from FDR). */
  wagerUnit: number;
  /** Total dollars returned for this ticket (0 if it lost). */
  returned: number;
  /** returned − amount. */
  profit: number;
  /** Why it cashed or didn't, terse. */
  note?: string;
}

/**
 * Race-level settlement state:
 *   - 'settled': the race ran and official results came back; ticket outcomes
 *     reflect real cash/loss.
 *   - 'void': the race was voided (canceled, postponed, all-runners-scratched,
 *     or otherwise produced no finishing positions). Real-world pari-mutuel
 *     behavior on a voided race is refund-in-full, so we store totalReturn =
 *     totalStake and totalProfit = 0. The CSV/evaluator filters these out of
 *     ROI calculations so they don't masquerade as silent −100% data points.
 *
 * Field is optional for back-compat with settlements persisted before it was
 * introduced; missing means 'settled'.
 */
export type SettlementState = 'settled' | 'void';

export interface BetSettlement {
  raceId: string;
  /** ISO timestamp the settlement ran. */
  settledAt: string;
  tickets: SettledTicket[];
  /** Sum of ticket.amount. */
  totalStake: number;
  /** Sum of ticket.returned. For 'void' settlements this equals totalStake. */
  totalReturn: number;
  /** totalReturn − totalStake. For 'void' settlements this equals 0. */
  totalProfit: number;
  /** See SettlementState. Optional; absent means 'settled' for back-compat. */
  state?: SettlementState;
}
