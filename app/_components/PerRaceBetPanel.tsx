'use client';

import { useEffect, useMemo, useState } from 'react';
import type { RaceAnalysis } from '../../lib/types';
import type { BetTicket } from '../../lib/simulation/types';
import { type BetType, type PlacedBet, makeBetId } from './bets';

/** Single source of truth for the dashboard's session budget. The lock-bet-plan
 *  effect in page.tsx reads from here at T-1:00 so the simulation matches what
 *  the user has been previewing. */
export const BUDGET_STORAGE_KEY = 'derbyEdge.budget.v1';

interface BetPlanResponse {
  raceId: string;
  budget: number;
  rationale: string;
  tickets: BetTicket[];
  totalStake: number;
  cached?: boolean;
  cachedAgeMs?: number;
  error?: string;
}

interface PerRaceBetPanelProps {
  analysis: RaceAnalysis;
  bets: PlacedBet[];
  onAddBet: (bet: PlacedBet) => void;
  onRemoveBet: (id: string) => void;
}

export function PerRaceBetPanel({
  analysis,
  bets,
  onAddBet,
  onRemoveBet,
}: PerRaceBetPanelProps) {
  const { race, rows } = analysis;
  const liveHorses = rows.filter((r) => !(r.pWin === 0 && r.signal === 'none'));

  // ── Bet form state ─────────────────────────────────────────────────────
  const [program, setProgram] = useState<string>('');
  const [betType, setBetType] = useState<BetType>('place');
  const [amount, setAmount] = useState<string>('2');

  useEffect(() => {
    // When the race changes, reset the form so we don't carry over stale values.
    setProgram('');
    setBetType('place');
    setAmount('2');
  }, [race.raceId]);

  const horseByProgram = useMemo(
    () => new Map(liveHorses.map((h) => [h.program, h])),
    [liveHorses],
  );

  const canSubmit =
    program !== '' &&
    horseByProgram.has(program) &&
    Number(amount) >= 2 &&
    Number.isInteger(Number(amount));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const horse = horseByProgram.get(program)!;
    const bet: PlacedBet = {
      id: makeBetId(),
      raceId: race.raceId,
      trackCode: race.trackCode,
      raceNumber: race.raceNumber,
      program: horse.program,
      horseName: horse.name,
      betType,
      amount: Math.floor(Number(amount)),
      placedAt: new Date().toISOString(),
    };
    onAddBet(bet);
    setProgram('');
    setAmount('2');
  };

  // ── Per-race AI bet-plan state ─────────────────────────────────────────
  // Budget is a single global session value (persisted to localStorage). When
  // the user changes it, page.tsx's auto-lock effect picks it up at T-1:00.
  const [budget, setBudget] = useState<string>('20');
  const [recLoading, setRecLoading] = useState<boolean>(false);
  const [plan, setPlan] = useState<BetPlanResponse | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

  // Hydrate the budget from localStorage on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(BUDGET_STORAGE_KEY);
      if (stored) {
        const n = Number(stored);
        if (Number.isFinite(n) && n >= 2) setBudget(String(Math.floor(n)));
      }
    } catch {
      // ignore
    }
  }, []);

  // Persist budget on change so the lock effect (page.tsx) sees the same value.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const n = Number(budget);
    if (!Number.isFinite(n) || n < 2) return;
    try {
      window.localStorage.setItem(BUDGET_STORAGE_KEY, String(Math.floor(n)));
    } catch {
      // ignore
    }
  }, [budget]);

  // Reset only the displayed plan when the user switches races — keep the
  // budget value so it carries across races (single session-wide setting).
  useEffect(() => {
    setPlan(null);
    setRecError(null);
  }, [race.raceId]);

  const requestRecommendation = async (): Promise<void> => {
    const budgetNum = Math.floor(Number(budget));
    if (!Number.isFinite(budgetNum) || budgetNum < 2) {
      setRecError('Budget must be a whole dollar amount of at least $2.');
      return;
    }
    setRecLoading(true);
    setRecError(null);
    try {
      const url = `/api/bet-plan?raceId=${encodeURIComponent(race.raceId)}&budget=${budgetNum}`;
      const res = await fetch(url, { method: 'POST', cache: 'no-store' });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as BetPlanResponse;
      setPlan(json);
    } catch (err) {
      setRecError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecLoading(false);
    }
  };

  /** Hand off the plan to the bookmaker chat for an explanation. */
  const requestExplanation = (): void => {
    if (!plan) return;
    const lines: string[] = [];
    lines.push(
      `Walk me through your bet plan for ${race.trackCode} R${race.raceNumber} on a $${plan.budget} budget.`,
    );
    lines.push('');
    lines.push('Tickets:');
    if (plan.tickets.length === 0) {
      lines.push('  (no tickets — you flagged the race as no-play)');
    } else {
      for (const t of plan.tickets) {
        lines.push(`  · $${t.amount} ${formatTicketType(t.type)} on ${formatHorses(t)}`);
      }
    }
    lines.push('');
    lines.push(
      'Why this allocation? Reference the specific edges, pool sizes, and any drift or scratches that drove the call. Keep it focused on this race only.',
    );
    const prompt = lines.join('\n');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('horseplay:open-bookmaker', { detail: { prompt } }),
      );
    }
  };

  const racesBets = bets.filter((b) => b.raceId === race.raceId);

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* ── AI per-race bet plan ─────────────────────────────────────────── */}
      <div className="rounded border border-purple-900 bg-purple-950/30 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-purple-300">
              🎯 Bet recommendation
            </div>
            <div className="text-[10px] text-zinc-500">
              structured tickets · this race · auto-locks at T-1:00 with budget below
            </div>
          </div>
        </div>
        <div className="mb-3 flex items-center gap-2 text-sm">
          <label htmlFor="budget" className="text-zinc-400">
            Budget $
          </label>
          <input
            id="budget"
            type="number"
            min={2}
            step={1}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 font-mono"
          />
          <button
            type="button"
            onClick={() => void requestRecommendation()}
            disabled={recLoading || race.status !== 'open'}
            className="rounded border border-purple-700 bg-purple-900 px-3 py-1 text-xs font-medium text-purple-100 hover:border-purple-500 hover:bg-purple-800 disabled:opacity-50"
          >
            {recLoading ? 'Asking model…' : 'Get AI recommendation'}
          </button>
          {plan && !recLoading && (
            <button
              type="button"
              onClick={requestExplanation}
              className="rounded border border-amber-700 bg-amber-900 px-3 py-1 text-xs font-medium text-amber-100 hover:border-amber-500 hover:bg-amber-800"
              title="Open the bookmaker and ask it to explain this plan"
            >
              🎩 Explain
            </button>
          )}
          {race.status !== 'open' && (
            <span className="text-xs text-zinc-500">
              (race is {race.status} — no wagering)
            </span>
          )}
        </div>
        {recError && (
          <div className="text-sm text-red-300">⚠ {recError}</div>
        )}
        {plan && (
          <div>
            {plan.tickets.length === 0 ? (
              <div className="text-sm text-zinc-300">
                No play — model couldn't find a +EV ticket within ${plan.budget}.
              </div>
            ) : (
              <ul className="space-y-1 text-sm font-mono text-zinc-100">
                {plan.tickets.map((t, i) => (
                  <li key={i} className="flex items-baseline gap-2">
                    <span className="font-bold text-purple-200">
                      ${t.amount}
                    </span>
                    <span className="uppercase tracking-wide text-zinc-300">
                      {formatTicketType(t.type)}
                    </span>
                    <span className="text-zinc-100">{formatHorsesWithNames(t, analysis)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 text-[10px] text-zinc-500">
              total ${plan.totalStake} of ${plan.budget} budget
              {plan.cached ? ' · (cached preview)' : ''}
            </div>
          </div>
        )}
        {!plan && !recError && !recLoading && (
          <div className="text-xs text-zinc-500">
            Set a budget and click <em>Get AI recommendation</em>. The plan
            you see here is what gets locked for the simulation at T-1:00.
          </div>
        )}
      </div>

      {/* ── Bet form ─────────────────────────────────────────────────────── */}
      <div className="rounded border border-blue-900 bg-blue-950/30 px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-blue-300">
              💰 Record a bet you placed
            </div>
            <div className="text-[10px] text-zinc-500">
              tracked locally · resolved when race goes official · win/lose chime
            </div>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-zinc-400">Horse:</label>
            <select
              value={program}
              onChange={(e) => setProgram(e.target.value)}
              className="flex-1 min-w-[160px] rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
            >
              <option value="">— pick a horse —</option>
              {liveHorses.map((h) => (
                <option key={h.program} value={h.program}>
                  #{h.program} {h.name}
                  {h.signal !== 'none' ? ` (${h.signal})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <label className="text-zinc-400">Bet type:</label>
            {(['win', 'place', 'show'] as const).map((t) => (
              <label key={t} className="flex items-center gap-1 text-zinc-200">
                <input
                  type="radio"
                  name="betType"
                  value={t}
                  checked={betType === t}
                  onChange={() => setBetType(t)}
                />
                {t}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-zinc-400">$</label>
            <input
              type="number"
              min={2}
              step={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 font-mono"
            />
            <button
              type="submit"
              disabled={!canSubmit || race.status !== 'open'}
              className="rounded border border-blue-700 bg-blue-900 px-3 py-1 text-xs font-medium text-blue-100 hover:border-blue-500 hover:bg-blue-800 disabled:opacity-50"
            >
              Add bet
            </button>
          </div>
          {race.status !== 'open' && (
            <div className="text-xs text-zinc-500">
              Race is {race.status} — bets can only be added on open races.
            </div>
          )}
        </form>

        {racesBets.length > 0 && (
          <div className="mt-3 border-t border-zinc-800 pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
              Your bets on this race
            </div>
            <ul className="space-y-1 text-xs font-mono">
              {racesBets.map((b) => (
                <li key={b.id} className="flex items-center gap-2">
                  <span className="text-zinc-300">
                    ${b.amount} {b.betType} · #{b.program} {b.horseName}
                  </span>
                  {b.resolved ? (
                    <span
                      className={
                        b.resolved.won ? 'text-green-400' : 'text-red-400'
                      }
                    >
                      {b.resolved.won
                        ? `WON $${b.resolved.payout.toFixed(2)} (+$${b.resolved.profit.toFixed(2)})`
                        : `LOST -$${b.amount.toFixed(2)}`}
                    </span>
                  ) : (
                    <span className="text-yellow-400">pending</span>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemoveBet(b.id)}
                    className="ml-auto text-zinc-500 hover:text-red-400"
                    aria-label="Remove bet"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTicketType(type: BetTicket['type']): string {
  switch (type) {
    case 'win':
      return 'WIN';
    case 'place':
      return 'PLACE';
    case 'show':
      return 'SHOW';
    case 'exacta_straight':
      return 'EXACTA';
    case 'exacta_box':
      return 'EXA BOX';
    case 'trifecta_straight':
      return 'TRIFECTA';
    case 'trifecta_box':
      return 'TRI BOX';
  }
}

/** Just program numbers, used for the chat prompt where horse names would
 *  bloat the message. */
function formatHorses(t: BetTicket): string {
  if (t.type === 'exacta_straight' || t.type === 'trifecta_straight') {
    return t.horses.join(' / ');
  }
  if (t.type === 'exacta_box' || t.type === 'trifecta_box') {
    return t.horses.join(' / ');
  }
  return `#${t.horses[0]}`;
}

/** With horse names resolved from the analysis — shown on screen. */
function formatHorsesWithNames(t: BetTicket, analysis: RaceAnalysis): string {
  const nameOf = (program: string): string => {
    const row = analysis.rows.find((r) => r.program === program);
    return row ? row.name : '';
  };
  if (t.horses.length === 1) {
    const p = t.horses[0];
    return `#${p} ${nameOf(p)}`.trim();
  }
  // exacta/trifecta — show program numbers; names get noisy past 2 horses
  const sep =
    t.type === 'exacta_straight' || t.type === 'trifecta_straight' ? ' over ' : ' / ';
  return t.horses.map((p) => `#${p}`).join(sep);
}
