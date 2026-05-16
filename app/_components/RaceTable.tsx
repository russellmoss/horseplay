'use client';

import type { HorseAnalysis, RaceAnalysis, Signal } from '../../lib/types';
import { Tooltip } from './Tooltip';
import { EXPLANATIONS, SIGNAL_ACTIONS } from './explanations';
import {
  formatDecimalOdds,
  formatPayout,
  formatPercent,
  formatProb,
} from './formatters';
import { BackfillButton } from './BackfillButton';

interface RaceTableProps {
  analysis: RaceAnalysis;
}

const SIGNAL_ROW_CLASS: Record<Signal, string> = {
  slam_dunk:
    'bg-green-950/60 hover:bg-green-950/80 border-l-2 border-green-500',
  lean: 'bg-yellow-950/40 hover:bg-yellow-950/60 border-l-2 border-yellow-600',
  drift: 'hover:bg-zinc-800/60 border-l-4 border-red-600',
  none: 'hover:bg-zinc-800/40 border-l-2 border-transparent',
};

const SIGNAL_BADGE_CLASS: Record<Signal, string> = {
  slam_dunk: 'bg-green-600 text-white',
  lean: 'bg-yellow-600 text-zinc-900',
  drift: 'bg-red-600 text-white',
  none: 'bg-zinc-800 text-zinc-500',
};

export function RaceTable({ analysis }: RaceTableProps) {
  const { race, rows } = analysis;

  // Count actionable signals up top
  const slamCount = rows.filter((r) => r.signal === 'slam_dunk').length;
  const leanCount = rows.filter((r) => r.signal === 'lean').length;
  const driftCount = rows.filter((r) => r.signal === 'drift').length;
  // Scratched horses live on the underlying Race, not the analysis rows.
  const scratchedHorses = race.horses.filter((h) => h.scratched);
  const scratchCount = scratchedHorses.length;

  // How stale is this race's data?
  const lastUpdateMs = Date.parse(race.lastUpdate);
  const ageSec = Number.isFinite(lastUpdateMs)
    ? Math.max(0, Math.round((Date.now() - lastUpdateMs) / 1000))
    : null;
  const ageLabel =
    ageSec === null
      ? '—'
      : ageSec < 60
        ? `${ageSec}s ago`
        : ageSec < 3600
          ? `${Math.round(ageSec / 60)}m ago`
          : `${(ageSec / 3600).toFixed(1)}h ago`;
  const isStale = ageSec !== null && ageSec > 90;

  // Are pool dollars empty?
  const totalWin = race.totalWinPool ?? 0;
  const totalPlace = race.totalPlacePool ?? 0;
  const totalShow = race.totalShowPool ?? 0;
  const poolsEmpty = totalWin === 0 && totalPlace === 0 && totalShow === 0;

  return (
    <div className="px-4 py-3">
      {/* Race summary line */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <div className="text-base font-bold text-zinc-100">
          {race.trackCode} R{race.raceNumber}
        </div>
        <div className="text-zinc-400">
          post {new Date(race.postTimeUtc).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
        </div>
        <Tooltip content={EXPLANATIONS.raceStatus}>
          <span
            className={`rounded px-2 py-0.5 text-xs font-mono ${
              race.status === 'open'
                ? 'bg-green-900 text-green-300'
                : race.status === 'official'
                  ? 'bg-zinc-800 text-zinc-400'
                  : 'bg-yellow-900 text-yellow-300'
            }`}
          >
            {race.status}
          </span>
        </Tooltip>
        <Tooltip content={EXPLANATIONS.lastUpdate}>
          <span
            className={`text-xs font-mono ${isStale ? 'text-yellow-400' : 'text-zinc-500'}`}
          >
            updated {ageLabel}
          </span>
        </Tooltip>
        <div className="text-zinc-500">
          win ${totalWin.toLocaleString()}
        </div>
        <div className="text-zinc-500">place ${totalPlace.toLocaleString()}</div>
        <div className="text-zinc-500">show ${totalShow.toLocaleString()}</div>
        {race.totalExactaPool ? (
          <Tooltip content={`Exacta pool size. Under $1K: too thin to bet. Under $5K: fragile. Over $50K: solid.`}>
            <div
              className={`text-xs ${
                race.totalExactaPool >= 50_000
                  ? 'text-green-400'
                  : race.totalExactaPool >= 5_000
                    ? 'text-zinc-500'
                    : 'text-red-400'
              }`}
            >
              EX ${race.totalExactaPool.toLocaleString()}
            </div>
          </Tooltip>
        ) : null}
        {race.totalTrifectaPool ? (
          <Tooltip content={`Trifecta pool size. Under $3K: too thin to bet. Over $30K: solid.`}>
            <div
              className={`text-xs ${
                race.totalTrifectaPool >= 30_000
                  ? 'text-green-400'
                  : race.totalTrifectaPool >= 3_000
                    ? 'text-zinc-500'
                    : 'text-red-400'
              }`}
            >
              TRI ${race.totalTrifectaPool.toLocaleString()}
            </div>
          </Tooltip>
        ) : null}
        {race.totalSuperfectaPool ? (
          <div className="text-xs text-zinc-500">
            SU ${race.totalSuperfectaPool.toLocaleString()}
          </div>
        ) : null}
        {race.totalDailyDoublePool ? (
          <div className="text-xs text-zinc-500">
            DD ${race.totalDailyDoublePool.toLocaleString()}
          </div>
        ) : null}
        {race.totalPick3Pool ? (
          <div className="text-xs text-zinc-500">
            P3 ${race.totalPick3Pool.toLocaleString()}
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-2 text-xs">
          {slamCount > 0 && (
            <span className="rounded bg-green-700 px-2 py-0.5 font-bold text-white">
              {slamCount} slam dunk{slamCount === 1 ? '' : 's'}
            </span>
          )}
          {leanCount > 0 && (
            <span className="rounded bg-yellow-700 px-2 py-0.5 font-bold text-zinc-900">
              {leanCount} lean{leanCount === 1 ? '' : 's'}
            </span>
          )}
          {driftCount > 0 && (
            <span className="rounded bg-red-800 px-2 py-0.5 font-bold text-white">
              {driftCount} drift{driftCount === 1 ? '' : 's'}
            </span>
          )}
          {scratchCount > 0 && (
            <Tooltip
              content={`Scratched: ${scratchedHorses
                .map((h) => `#${h.program} ${h.name}`)
                .join(', ')}. Drift signals on this race may be spurious — pool redistributes when a horse is pulled, which moves live odds without real money flow. Treat DRIFT here skeptically.`}
            >
              <span className="rounded bg-zinc-700 px-2 py-0.5 font-bold text-zinc-100">
                ⚠ {scratchCount} scratch{scratchCount === 1 ? '' : 'es'}
              </span>
            </Tooltip>
          )}
          <a
            href={`/api/export/${encodeURIComponent(race.raceId)}`}
            download
            className="rounded border border-amber-700 bg-amber-900/60 px-2 py-0.5 font-bold text-amber-100 hover:border-amber-500 hover:bg-amber-800"
            title="Download this race as a styled .xlsx with formulas, results, and color-coded signals"
          >
            📥 Race xlsx
          </a>
          <a
            href={`/api/export/day?trackCode=${encodeURIComponent(race.trackCode)}&date=${encodeURIComponent(race.postTimeUtc.slice(0, 10))}`}
            download
            className="rounded border border-emerald-700 bg-emerald-900/60 px-2 py-0.5 font-bold text-emerald-100 hover:border-emerald-500 hover:bg-emerald-800"
            title="Download race-day P&L summary: cumulative simulation across every race on this track today"
          >
            📊 Day summary
          </a>
          <BackfillButton
            trackCode={race.trackCode}
            postDate={race.postTimeUtc.slice(0, 10)}
          />
        </div>
      </div>

      {poolsEmpty && race.status === 'open' && (
        <div className="mb-3 rounded border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
          <span className="font-bold text-zinc-300">No pool data yet for this race.</span>{' '}
          Pari-mutuel pools accumulate over the day; they often look like $0
          until ~10–20 minutes before post when serious money starts flowing.
          Signals can\'t fire without pool data — check back closer to MTP, or
          pick a race with a smaller MTP from the dropdown.
        </div>
      )}

      {/* Show race-results banner if official */}
      {race.results && race.results.runners.length > 0 && (
        <div className="mb-3 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm">
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-zinc-400">
            Official results
            {race.results.winningTimeSeconds !== null && (
              <span className="ml-2 font-mono text-zinc-500">
                {race.results.winningTimeSeconds.toFixed(2)}s
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-zinc-300">
            {race.results.runners.slice(0, 3).map((r) => (
              <div key={r.program} className="font-mono">
                <span className="text-zinc-400">{r.finishPosition}.</span>{' '}
                <span className="text-zinc-100">#{r.program} {r.name}</span>{' '}
                <span className="text-green-400">
                  W ${r.winPayoff.toFixed(2)}
                </span>
                <span className="ml-1 text-blue-400">
                  P ${r.placePayoff.toFixed(2)}
                </span>
                <span className="ml-1 text-zinc-400">
                  S ${r.showPayoff.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main table */}
      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="min-w-full table-fixed text-xs">
          <thead className="bg-zinc-900 text-left uppercase tracking-wide text-zinc-400">
            <tr>
              <Th width={36}>
                <Tooltip content={EXPLANATIONS.programNumber}>#</Tooltip>
              </Th>
              <Th width={200}>
                <Tooltip content={EXPLANATIONS.horseName}>Horse</Tooltip>
              </Th>
              <Th width={56} align="right">
                <Tooltip content={EXPLANATIONS.morningLineOdds}>ML</Tooltip>
              </Th>
              <Th width={56} align="right">
                <Tooltip content={EXPLANATIONS.currentOdds}>Cur</Tooltip>
              </Th>
              <Th width={64} align="right">
                <Tooltip content={EXPLANATIONS.drift_metric}>Δ%</Tooltip>
              </Th>
              <Th width={60} align="right">
                <Tooltip content={EXPLANATIONS.pWin}>p(W)</Tooltip>
              </Th>
              <Th width={64} align="right">
                <Tooltip content={EXPLANATIONS.winActual}>Win $</Tooltip>
              </Th>
              <Th width={64} align="right">
                <Tooltip content={EXPLANATIONS.winFair}>Win fair</Tooltip>
              </Th>
              <Th width={64} align="right">
                <Tooltip content={EXPLANATIONS.winEdge}>Win edge</Tooltip>
              </Th>
              <Th width={140} align="center">
                <Tooltip content={EXPLANATIONS.placeActual}>
                  Place actual (floor / mid / ceil)
                </Tooltip>
              </Th>
              <Th width={100} align="center">
                <Tooltip content={EXPLANATIONS.placeFair}>
                  Place fair (harv · heur)
                </Tooltip>
              </Th>
              <Th width={104} align="center">
                <Tooltip content={EXPLANATIONS.placeEdge}>
                  Place edge (floor · mid)
                </Tooltip>
              </Th>
              <Th width={140} align="center">
                <Tooltip content={EXPLANATIONS.showActual}>
                  Show actual (floor / mid / ceil)
                </Tooltip>
              </Th>
              <Th width={100} align="center">
                <Tooltip content={EXPLANATIONS.showFair}>
                  Show fair (harv · heur)
                </Tooltip>
              </Th>
              <Th width={104} align="center">
                <Tooltip content={EXPLANATIONS.showEdge}>
                  Show edge (floor · mid)
                </Tooltip>
              </Th>
              <Th width={92} align="center">
                <Tooltip content={EXPLANATIONS.signal}>Signal</Tooltip>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.map((row) => (
              <Row key={row.program} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-xs text-zinc-500">
        Probability source: <span className="font-mono">{analysis.probSource}</span> · Computed{' '}
        {new Date(analysis.computedAt).toLocaleTimeString([], { hour12: false })}
      </div>
    </div>
  );
}

function Th({
  children,
  width,
  align = 'left',
}: {
  children: React.ReactNode;
  width: number;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <th
      className="px-2 py-2 font-medium"
      style={{ width, textAlign: align }}
    >
      {children}
    </th>
  );
}

function Row({ row }: { row: HorseAnalysis }) {
  const cls = SIGNAL_ROW_CLASS[row.signal];
  const scratched = row.pWin === 0 && row.signal === 'none';

  if (scratched) {
    return (
      <tr className="text-zinc-600 line-through opacity-50">
        <Td>{row.program}</Td>
        <Td>
          <div className="font-medium">{row.name}</div>
        </Td>
        <Td align="right">{formatDecimalOdds(row.mlOdds)}</Td>
        <Td align="right">—</Td>
        <Td align="right">—</Td>
        <Td align="right">—</Td>
        <Td align="center" colSpan={10}>
          (scratched)
        </Td>
      </tr>
    );
  }

  return (
    <tr className={cls}>
      <Td>
        <span className="font-mono font-bold text-zinc-200">{row.program}</span>
      </Td>
      <Td>
        <div className="font-medium text-zinc-100">{row.name}</div>
        <div className="truncate text-[10px] text-zinc-500">
          {row.currentFractional}
        </div>
      </Td>
      <Td align="right" mono>
        {formatDecimalOdds(row.mlOdds)}
      </Td>
      <Td align="right" mono>
        {formatDecimalOdds(row.currentOdds)}
      </Td>
      <Td
        align="right"
        mono
        className={
          row.mlDrift !== null && row.mlDrift > 0.5
            ? 'text-red-400 font-bold'
            : row.mlDrift !== null && row.mlDrift > 0
              ? 'text-zinc-400'
              : row.mlDrift !== null && row.mlDrift < 0
                ? 'text-zinc-500'
                : ''
        }
      >
        {formatPercent(row.mlDrift, 0)}
      </Td>
      <Td align="right" mono>
        {formatProb(row.pWin)}
      </Td>

      {/* Win actual / fair / edge */}
      <Td align="right" mono>
        <span className="text-zinc-200">{formatPayout(row.winProjected)}</span>
      </Td>
      <Td align="right" mono>
        <span className="text-zinc-400">{formatPayout(row.winFairPayout)}</span>
      </Td>
      <Td align="right" mono>
        <span className={edgeColor(row.winEdge)}>
          {formatPercent(row.winEdge, 0)}
        </span>
      </Td>

      {/* Place actual */}
      <Td align="center" mono>
        <Triple
          floor={row.placeProjected.floor}
          mid={row.placeProjected.mid}
          ceiling={row.placeProjected.ceiling}
        />
      </Td>
      <Td align="center" mono>
        <Pair
          primary={row.harville.placeFairPayout}
          secondary={row.heuristic.placeFairPayout}
        />
      </Td>
      <Td align="center" mono>
        <EdgePair
          floor={row.placeEdge.harvilleFloor}
          mid={row.placeEdge.harvilleMid}
        />
      </Td>

      {/* Show actual */}
      <Td align="center" mono>
        <Triple
          floor={row.showProjected.floor}
          mid={row.showProjected.mid}
          ceiling={row.showProjected.ceiling}
        />
      </Td>
      <Td align="center" mono>
        <Pair
          primary={row.harville.showFairPayout}
          secondary={row.heuristic.showFairPayout}
        />
      </Td>
      <Td align="center" mono>
        <EdgePair
          floor={row.showEdge.harvilleFloor}
          mid={row.showEdge.harvilleMid}
        />
      </Td>

      <Td align="center">
        <Tooltip
          content={
            row.signal === 'slam_dunk'
              ? EXPLANATIONS.slamDunk
              : row.signal === 'lean'
                ? EXPLANATIONS.lean
                : row.signal === 'drift'
                  ? EXPLANATIONS.drift
                  : EXPLANATIONS.none
          }
          width={300}
        >
          <span
            className={`inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase ${SIGNAL_BADGE_CLASS[row.signal]}`}
          >
            {SIGNAL_ACTIONS[row.signal].label}
          </span>
        </Tooltip>
      </Td>
    </tr>
  );
}

function Td({
  children,
  align = 'left',
  mono = false,
  className = '',
  colSpan,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  mono?: boolean;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      className={`px-2 py-1.5 ${mono ? 'font-mono' : ''} ${className}`}
      style={{ textAlign: align }}
      colSpan={colSpan}
    >
      {children}
    </td>
  );
}

function Triple({
  floor,
  mid,
  ceiling,
}: {
  floor: number | null;
  mid: number | null;
  ceiling: number | null;
}) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <span className="text-zinc-500">{formatPayout(floor)}</span>
      <span className="text-zinc-600">·</span>
      <span className="font-bold text-zinc-200">{formatPayout(mid)}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-500">{formatPayout(ceiling)}</span>
    </div>
  );
}

function Pair({
  primary,
  secondary,
}: {
  primary: number | null;
  secondary: number | null;
}) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <span className="font-bold text-zinc-200">{formatPayout(primary)}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-500">{formatPayout(secondary)}</span>
    </div>
  );
}

function edgeColor(e: number | null): string {
  if (e === null) return 'text-zinc-500';
  if (e > 0) return 'text-green-400 font-bold';
  if (e > -0.05) return 'text-zinc-300';
  if (e > -0.2) return 'text-zinc-500';
  return 'text-zinc-600';
}

function EdgePair({
  floor,
  mid,
}: {
  floor: number | null;
  mid: number | null;
}) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <span className={edgeColor(floor)}>{formatPercent(floor, 0)}</span>
      <span className="text-zinc-600">·</span>
      <span className={edgeColor(mid)}>{formatPercent(mid, 0)}</span>
    </div>
  );
}
