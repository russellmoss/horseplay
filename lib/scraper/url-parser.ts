/**
 * Parse FanDuel Racing URLs into the bits the scraper needs.
 *
 * Examples we accept:
 *   https://racing.fanduel.com/racetracks/BEL/belmont-at-the-big-a?race=1
 *   https://racing.fanduel.com/racetracks/CD/churchill-downs
 *   racing.fanduel.com/racetracks/SAR/saratoga?race=8
 *   /racetracks/GP/gulfstream-park?race=11
 *
 * The track code is whatever sits between `/racetracks/` and the next `/` —
 * we don't validate against a known list because FanDuel's roster shifts
 * constantly and the FDR GraphQL endpoint will surface "no races today" for
 * a bad code, which is the right place for that error.
 */

export interface ParsedFanDuelUrl {
  /** FDR track code, e.g. "BEL", "CD", "SAR", "GP". Always uppercase. */
  trackCode: string;
  /** Specific race number from the `?race=N` query param, if present. */
  raceNumber: number | null;
}

const TRACK_CODE_RE = /\/racetracks\/([A-Za-z0-9]+)(?:\/|$|\?)/;
const RACE_QUERY_RE = /[?&]race=(\d+)/i;

export function parseFanDuelUrl(input: string): ParsedFanDuelUrl | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const trackMatch = TRACK_CODE_RE.exec(trimmed);
  if (!trackMatch) return null;
  const trackCode = trackMatch[1].toUpperCase();
  if (trackCode.length === 0) return null;

  const raceMatch = RACE_QUERY_RE.exec(trimmed);
  let raceNumber: number | null = null;
  if (raceMatch) {
    const n = Number(raceMatch[1]);
    if (Number.isFinite(n) && n > 0) raceNumber = Math.floor(n);
  }

  return { trackCode, raceNumber };
}
