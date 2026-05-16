/**
 * Pure formatting helpers for the dashboard. Tested in
 * `tests/dashboard.formatters.test.ts`. No side effects, no React.
 */

export function formatDecimalOdds(decimal: number | null): string {
  if (decimal === null || !Number.isFinite(decimal)) return '—';
  if (decimal < 2) return decimal.toFixed(2);
  if (decimal < 10) return decimal.toFixed(1);
  return Math.round(decimal).toString();
}

export function formatPercent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

export function formatPayout(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

export function formatProb(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return p.toFixed(3);
}

export function formatMtp(mtpSeconds: number | null): string {
  if (mtpSeconds === null) return '—';
  if (mtpSeconds < 0) {
    return `+${formatMtp(-mtpSeconds)} past`;
  }
  const min = Math.floor(mtpSeconds / 60);
  const sec = Math.floor(mtpSeconds % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function secondsToPostTime(postTimeUtc: string, nowMs: number): number {
  const postMs = Date.parse(postTimeUtc);
  if (!Number.isFinite(postMs)) return 0;
  return Math.round((postMs - nowMs) / 1000);
}

/**
 * Pick the race the dashboard should display by default. Prefer the OPEN
 * race closest to post; if none open, the most recently OFFICIAL one;
 * else the first race in the list.
 */
export function pickDefaultRaceId<T extends { race: { raceId: string; status: string; postTimeUtc: string } }>(
  races: T[],
): string | null {
  if (races.length === 0) return null;

  const open = races.filter((r) => r.race.status === 'open');
  if (open.length > 0) {
    open.sort(
      (a, b) => Date.parse(a.race.postTimeUtc) - Date.parse(b.race.postTimeUtc),
    );
    return open[0].race.raceId;
  }

  const official = races.filter((r) => r.race.status === 'official');
  if (official.length > 0) {
    official.sort(
      (a, b) => Date.parse(b.race.postTimeUtc) - Date.parse(a.race.postTimeUtc),
    );
    return official[0].race.raceId;
  }

  return races[0].race.raceId;
}

/**
 * Auto-advance: if the currently-selected race has gone closed/official AND
 * there's an OPEN race within `withinSeconds` of post, switch to it. Returns
 * the new raceId (or the current one if no advance is warranted).
 */
export function nextRaceIdIfDue<
  T extends { race: { raceId: string; status: string; postTimeUtc: string } },
>(
  races: T[],
  currentRaceId: string | null,
  nowMs: number,
  withinSeconds = 600,
): string | null {
  if (races.length === 0) return null;
  if (!currentRaceId) return pickDefaultRaceId(races);

  const current = races.find((r) => r.race.raceId === currentRaceId);
  if (!current) return pickDefaultRaceId(races);

  // Only auto-advance when the current race is no longer betable.
  if (current.race.status === 'open') return currentRaceId;

  const open = races.filter(
    (r) =>
      r.race.status === 'open' &&
      Date.parse(r.race.postTimeUtc) - nowMs <= withinSeconds * 1000,
  );
  if (open.length === 0) return currentRaceId;
  open.sort(
    (a, b) => Date.parse(a.race.postTimeUtc) - Date.parse(b.race.postTimeUtc),
  );
  return open[0].race.raceId;
}
