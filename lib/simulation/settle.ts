import type { Race, RaceResults } from '../types';
import type {
  BetSettlement,
  BetTicket,
  LockedBetPlan,
  SettledTicket,
} from './types';

/**
 * Settle a locked bet plan against the official results of a race.
 *
 * For Win/Place/Show we use the per-runner payoffs we already capture in
 * `RaceResults.runners[]`. For exotic tickets we look up the matching
 * `RaceResults.exoticPayoffs[]` entry by selection string (or any
 * permutation, for box tickets) and prorate the official payout to the
 * ticket's stake.
 *
 * Wager units (the `wagerAmount` on FDR's payoff entries) vary:
 *   - Win/Place/Show: typically per $2
 *   - Exacta: per $2
 *   - Trifecta: per $0.50
 *   - Superfecta: per $1 or $0.10 depending on track
 *
 * Returned dollars per ticket = (ticket.amount / wagerUnit) × payoutPerUnit
 * for a CASHED ticket. For boxes, the ticket.amount is the box-total cost,
 * and only ONE permutation of the box matches the actual outcome — so the
 * effective per-combo stake is `amount / numCombos`, and the cashing combo
 * pays out at that per-combo stake. (The other combos lose; net is the same
 * as `(amount / numCombos / wagerUnit) × payoutPerUnit`.)
 */

export function settleBetPlan(
  plan: LockedBetPlan,
  race: Race,
): BetSettlement | null {
  // Still pending: results haven't come back at all.
  if (!race.results) return null;

  // Void detection. A canceled / postponed / all-scratched race comes back
  // with a `results` object but no usable finishing positions. Real-world
  // pari-mutuel behavior is refund-in-full, NOT loss — every previously these
  // races showed up as silent −100% ROI data points because the settler used
  // to return null (so they stayed pending forever) or, if any runner record
  // existed without a finishPosition, the WPS path would mark every ticket
  // as `cashed=false`. Treat as 'void' instead.
  const hasUsableResults =
    race.results.runners.length > 0 &&
    race.results.runners.some((r) => Number.isFinite(r.finishPosition) && r.finishPosition > 0);
  if (!hasUsableResults) {
    return voidSettlement(plan);
  }

  const settled = plan.tickets.map((ticket) => settleTicket(ticket, race.results!));
  const totalStake = plan.tickets.reduce((a, t) => a + t.amount, 0);
  const totalReturn = settled.reduce((a, s) => a + s.returned, 0);

  return {
    raceId: plan.raceId,
    settledAt: new Date().toISOString(),
    tickets: settled,
    totalStake,
    totalReturn,
    totalProfit: totalReturn - totalStake,
    state: 'settled',
  };
}

/**
 * Build a void settlement: every ticket refunds, profit is 0. Note text on
 * each ticket calls out the void so post-hoc analysis can tell it apart from
 * a normal loss. Mirrors how the track itself would handle a canceled race.
 */
function voidSettlement(plan: LockedBetPlan): BetSettlement {
  const tickets: SettledTicket[] = plan.tickets.map((t) => ({
    ...t,
    cashed: false,
    payoutPerUnit: 0,
    wagerUnit: 2,
    returned: t.amount, // refund in full
    profit: 0,
    note: 'Race void — no usable finishing positions; ticket refunded.',
  }));
  const totalStake = plan.tickets.reduce((a, t) => a + t.amount, 0);
  return {
    raceId: plan.raceId,
    settledAt: new Date().toISOString(),
    tickets,
    totalStake,
    totalReturn: totalStake,
    totalProfit: 0,
    state: 'void',
  };
}

function settleTicket(ticket: BetTicket, results: RaceResults): SettledTicket {
  const finishOrder = results.runners
    .slice()
    .sort((a, b) => a.finishPosition - b.finishPosition)
    .map((r) => r.program);

  switch (ticket.type) {
    case 'win':
      return settleWPS(ticket, results, finishOrder, 1);
    case 'place':
      return settleWPS(ticket, results, finishOrder, 2);
    case 'show':
      return settleWPS(ticket, results, finishOrder, 3);
    case 'exacta_straight':
      return settleExoticStraight(ticket, results, finishOrder, 'EX', 2);
    case 'exacta_box':
      return settleExoticBox(ticket, results, finishOrder, 'EX', 2, 2);
    case 'trifecta_straight':
      return settleExoticStraight(ticket, results, finishOrder, 'TR', 3);
    case 'trifecta_box':
      return settleExoticBox(ticket, results, finishOrder, 'TR', 3, 3);
    default:
      return failedTicket(ticket, 'unknown ticket type');
  }
}

/** Win/Place/Show settlement against runner-level official payoffs. */
function settleWPS(
  ticket: BetTicket,
  results: RaceResults,
  finishOrder: string[],
  topN: 1 | 2 | 3,
): SettledTicket {
  const program = ticket.horses[0];
  const topNPrograms = new Set(finishOrder.slice(0, topN));
  const cashed = topNPrograms.has(program);
  const wagerUnit = 2;
  if (!cashed) {
    return {
      ...ticket,
      cashed: false,
      payoutPerUnit: 0,
      wagerUnit,
      returned: 0,
      profit: -ticket.amount,
      note: `#${program} finished out of the top ${topN}.`,
    };
  }
  const runner = results.runners.find((r) => r.program === program);
  if (!runner) {
    return failedTicket(ticket, `no result entry for #${program}`);
  }
  const payoutPerUnit =
    ticket.type === 'win'
      ? runner.winPayoff
      : ticket.type === 'place'
        ? runner.placePayoff
        : runner.showPayoff;
  const returned = (ticket.amount / wagerUnit) * payoutPerUnit;
  return {
    ...ticket,
    cashed: true,
    payoutPerUnit,
    wagerUnit,
    returned,
    profit: returned - ticket.amount,
    note: `#${program} finished ${runner.finishPosition} — paid $${payoutPerUnit.toFixed(2)} per $${wagerUnit}.`,
  };
}

/**
 * Exotic STRAIGHT settlement: ticket selection must match official finish
 * exactly for the top-N positions.
 */
function settleExoticStraight(
  ticket: BetTicket,
  results: RaceResults,
  finishOrder: string[],
  wagerCode: 'EX' | 'TR' | 'SU',
  topN: 2 | 3 | 4,
): SettledTicket {
  if (ticket.horses.length !== topN) {
    return failedTicket(ticket, 'wrong horse count for straight ticket');
  }
  const ticketSelection = ticket.horses.join('-');
  const officialSelection = finishOrder.slice(0, topN).join('-');
  const cashed = ticketSelection === officialSelection;
  const payoffEntry = (results.exoticPayoffs ?? []).find(
    (p) => p.wagerCode === wagerCode && p.selection === officialSelection,
  );
  const wagerUnit = payoffEntry?.wagerAmount ?? defaultWagerUnit(wagerCode);
  if (!cashed) {
    return {
      ...ticket,
      cashed: false,
      payoutPerUnit: 0,
      wagerUnit,
      returned: 0,
      profit: -ticket.amount,
      note: `Selection ${ticketSelection} ≠ official ${officialSelection}.`,
    };
  }
  if (!payoffEntry) {
    return failedTicket(
      ticket,
      `cashed selection ${officialSelection} but no ${wagerCode} payoff entry was reported`,
    );
  }
  const returned = (ticket.amount / wagerUnit) * payoffEntry.payoutAmount;
  return {
    ...ticket,
    cashed: true,
    payoutPerUnit: payoffEntry.payoutAmount,
    wagerUnit,
    returned,
    profit: returned - ticket.amount,
    note: `${ticketSelection} matched official — paid $${payoffEntry.payoutAmount.toFixed(2)} per $${wagerUnit}.`,
  };
}

/**
 * Exotic BOX settlement: cashes if any permutation of `ticket.horses` of size
 * topN matches the official finish. Per-combo stake = amount / numCombos.
 * The single matching combo pays at that per-combo stake.
 */
function settleExoticBox(
  ticket: BetTicket,
  results: RaceResults,
  finishOrder: string[],
  wagerCode: 'EX' | 'TR' | 'SU',
  topN: 2 | 3 | 4,
  minHorses: 2 | 3 | 4,
): SettledTicket {
  if (ticket.horses.length < minHorses) {
    return failedTicket(ticket, 'box needs at least minHorses');
  }
  const officialTopN = finishOrder.slice(0, topN);
  const ticketSet = new Set(ticket.horses);
  // For a box to cash, EVERY one of the official top-N programs must be in
  // the box. (And there are no extra constraints — the order is anything.)
  const cashed = officialTopN.every((p) => ticketSet.has(p));
  const numCombos = boxCombos(ticket.horses.length, topN);
  const officialSelection = officialTopN.join('-');
  const payoffEntry = (results.exoticPayoffs ?? []).find(
    (p) => p.wagerCode === wagerCode && p.selection === officialSelection,
  );
  const wagerUnit = payoffEntry?.wagerAmount ?? defaultWagerUnit(wagerCode);
  if (!cashed) {
    return {
      ...ticket,
      cashed: false,
      payoutPerUnit: 0,
      wagerUnit,
      returned: 0,
      profit: -ticket.amount,
      note: `Box {${ticket.horses.join(',')}} did not cover top-${topN} ${officialTopN.join('-')}.`,
    };
  }
  if (!payoffEntry) {
    return failedTicket(
      ticket,
      `cashed box but no ${wagerCode} payoff entry was reported`,
    );
  }
  // Per-combo stake = total / number of permutations the box covers.
  const perComboStake = ticket.amount / numCombos;
  const returned = (perComboStake / wagerUnit) * payoffEntry.payoutAmount;
  return {
    ...ticket,
    cashed: true,
    payoutPerUnit: payoffEntry.payoutAmount,
    wagerUnit,
    returned,
    profit: returned - ticket.amount,
    note: `Box covered ${officialTopN.join('-')} (${numCombos} combos × $${perComboStake.toFixed(2)} ea, paid $${payoffEntry.payoutAmount.toFixed(2)} per $${wagerUnit}).`,
  };
}

/** Number of permutations in a box of N horses choosing topN positions. */
function boxCombos(n: number, topN: 2 | 3 | 4): number {
  // P(n, k) = n! / (n-k)!
  if (n < topN) return 0;
  let p = 1;
  for (let i = 0; i < topN; i++) p *= n - i;
  return p;
}

function defaultWagerUnit(code: 'EX' | 'TR' | 'SU'): number {
  // Common track defaults when FDR doesn't report a specific unit.
  if (code === 'EX') return 2;
  if (code === 'TR') return 0.5;
  if (code === 'SU') return 1;
  return 2;
}

function failedTicket(ticket: BetTicket, note: string): SettledTicket {
  return {
    ...ticket,
    cashed: false,
    payoutPerUnit: 0,
    wagerUnit: 2,
    returned: 0,
    profit: -ticket.amount,
    note,
  };
}
