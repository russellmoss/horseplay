import type { Race } from '../../lib/types';

export type BetType = 'win' | 'place' | 'show';

export interface PlacedBet {
  id: string;
  raceId: string;
  trackCode: string;
  raceNumber: number;
  program: string;
  horseName: string;
  betType: BetType;
  /** Dollars wagered. Whole-dollar amount, ≥ 2. */
  amount: number;
  /** ISO timestamp when the user recorded the bet. */
  placedAt: string;
  /** Set once the race goes official and we have results. */
  resolved?: BetResolution;
}

export interface BetResolution {
  won: boolean;
  /** Per-$2 payoff from FDR results. 0 if the horse lost (or finished outside the money for this bet type). */
  payoffPer2: number;
  /** Total $ returned to bettor (stake + profit, or 0 if lost). */
  payout: number;
  /** payout − amount. Negative for losses. */
  profit: number;
  resolvedAt: string;
}

const STORAGE_KEY = 'derbyEdge.bets.v1';

/**
 * Pure: given a placed bet and a final-race object, decide whether the bet
 * won and compute the payout. Returns null if the race isn't ready to be
 * resolved yet (not official, no results, or horse not in results).
 */
export function resolveBet(
  bet: PlacedBet,
  race: Race,
  now = () => new Date().toISOString(),
): BetResolution | null {
  if (race.status !== 'official') return null;
  if (!race.results || race.results.runners.length === 0) return null;

  const finisher = race.results.runners.find(
    (r) => r.program === bet.program,
  );

  // Horse not in the results array → DNF / scratched after lock / data
  // gap. Treat as a loss; no refund visibility.
  if (!finisher) {
    return {
      won: false,
      payoffPer2: 0,
      payout: 0,
      profit: -bet.amount,
      resolvedAt: now(),
    };
  }

  let payoffPer2 = 0;
  switch (bet.betType) {
    case 'win':
      payoffPer2 = finisher.winPayoff;
      break;
    case 'place':
      payoffPer2 = finisher.placePayoff;
      break;
    case 'show':
      payoffPer2 = finisher.showPayoff;
      break;
  }

  // payoffPer2 > 0 ↔ won. FDR sets it to 0 for outside-the-money positions.
  if (payoffPer2 <= 0) {
    return {
      won: false,
      payoffPer2: 0,
      payout: 0,
      profit: -bet.amount,
      resolvedAt: now(),
    };
  }

  const units = bet.amount / 2;
  const payout = +(units * payoffPer2).toFixed(2);
  const profit = +(payout - bet.amount).toFixed(2);
  return {
    won: true,
    payoffPer2,
    payout,
    profit,
    resolvedAt: now(),
  };
}

/** Browser-only. Returns [] in non-browser contexts. */
export function loadBets(): PlacedBet[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as PlacedBet[];
  } catch {
    return [];
  }
}

export function saveBets(bets: PlacedBet[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bets));
  } catch {
    // Quota exceeded etc. — silently drop.
  }
}

export function makeBetId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as { randomUUID(): string }).randomUUID();
  }
  return `bet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function summarizePnl(bets: PlacedBet[]): {
  staked: number;
  returned: number;
  profit: number;
  pendingCount: number;
  wonCount: number;
  lostCount: number;
} {
  let staked = 0;
  let returned = 0;
  let pendingCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  for (const bet of bets) {
    staked += bet.amount;
    if (!bet.resolved) {
      pendingCount += 1;
      continue;
    }
    returned += bet.resolved.payout;
    if (bet.resolved.won) wonCount += 1;
    else lostCount += 1;
  }
  return {
    staked: +staked.toFixed(2),
    returned: +returned.toFixed(2),
    profit: +(returned - staked).toFixed(2),
    pendingCount,
    wonCount,
    lostCount,
  };
}
