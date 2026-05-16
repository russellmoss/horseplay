/**
 * Per-track, per-bet-type takeout rates for US (and major North American)
 * thoroughbred tracks. Takeout is the percentage skimmed from each pool
 * before payouts:
 *
 *     net_pool = total_pool × (1 − takeout)
 *
 * Track codes follow FanDuel Racing convention (the same `trackCode` we
 * receive on `Race` objects from the FDR adapter). Unknown codes fall
 * back to the global defaults supplied by the caller (env-var-backed
 * config in `lib/config.ts`), so adding a new track here is purely
 * additive — nothing breaks if a code is missing.
 *
 * Source notes (for future maintainers):
 *   - NYRA, CD, KEE, CA tracks: published 2024–2025 takeout schedules.
 *   - HANA (Horseplayers Association of North America) publishes annual
 *     takeout summaries that consolidate state-by-state filings.
 *   - State racing-commission orders are authoritative when they disagree
 *     with track marketing material.
 *
 * These rates change occasionally — re-verify annually.
 */
export interface TakeoutRates {
  win: number;
  place: number;
  show: number;
  /** Exotic fields are stored for future use by exacta/trifecta payout
   * estimators. analyzeRace() does not consume them today. */
  exacta: number;
  trifecta: number;
  superfecta: number;
}

/**
 * Track-keyed lookup. Codes are uppercase to match FDR. Add tracks here as
 * needed; a missing entry transparently uses the caller's fallback.
 */
export const TRACK_TAKEOUT: Record<string, TakeoutRates> = {
  // --- New York (NYRA) ----------------------------------------------------
  AQU: { win: 0.16, place: 0.16, show: 0.16, exacta: 0.185, trifecta: 0.24, superfecta: 0.24 },
  BEL: { win: 0.16, place: 0.16, show: 0.16, exacta: 0.185, trifecta: 0.24, superfecta: 0.24 },
  SAR: { win: 0.16, place: 0.16, show: 0.16, exacta: 0.185, trifecta: 0.24, superfecta: 0.24 },

  // --- Kentucky -----------------------------------------------------------
  CD:  { win: 0.175, place: 0.175, show: 0.175, exacta: 0.22, trifecta: 0.22, superfecta: 0.22 },
  KEE: { win: 0.175, place: 0.175, show: 0.175, exacta: 0.19, trifecta: 0.22, superfecta: 0.22 },
  ELP: { win: 0.175, place: 0.175, show: 0.175, exacta: 0.22, trifecta: 0.22, superfecta: 0.22 },
  TP:  { win: 0.175, place: 0.175, show: 0.175, exacta: 0.22, trifecta: 0.22, superfecta: 0.22 },
  KD:  { win: 0.165, place: 0.165, show: 0.165, exacta: 0.19, trifecta: 0.22, superfecta: 0.22 },

  // --- California (CHRB-fixed across the circuit) -------------------------
  SA:  { win: 0.154, place: 0.154, show: 0.154, exacta: 0.2268, trifecta: 0.2368, superfecta: 0.2368 },
  DMR: { win: 0.154, place: 0.154, show: 0.154, exacta: 0.2268, trifecta: 0.2368, superfecta: 0.2368 },
  LRC: { win: 0.154, place: 0.154, show: 0.154, exacta: 0.2268, trifecta: 0.2368, superfecta: 0.2368 },
  GG:  { win: 0.154, place: 0.154, show: 0.154, exacta: 0.2268, trifecta: 0.2368, superfecta: 0.2368 },

  // --- Florida ------------------------------------------------------------
  GP:  { win: 0.17, place: 0.17, show: 0.17, exacta: 0.20, trifecta: 0.26, superfecta: 0.26 },
  TAM: { win: 0.18, place: 0.18, show: 0.18, exacta: 0.205, trifecta: 0.255, superfecta: 0.255 },

  // --- Louisiana / Arkansas ----------------------------------------------
  FG:  { win: 0.17, place: 0.17, show: 0.17, exacta: 0.22, trifecta: 0.25, superfecta: 0.25 },
  OP:  { win: 0.17, place: 0.17, show: 0.17, exacta: 0.21, trifecta: 0.22, superfecta: 0.25 },

  // --- Mid-Atlantic -------------------------------------------------------
  LRL: { win: 0.18, place: 0.18, show: 0.18, exacta: 0.21, trifecta: 0.2575, superfecta: 0.2575 },
  PIM: { win: 0.18, place: 0.18, show: 0.18, exacta: 0.21, trifecta: 0.2575, superfecta: 0.2575 },
  PRX: { win: 0.17, place: 0.17, show: 0.17, exacta: 0.20, trifecta: 0.30, superfecta: 0.30 },
  PEN: { win: 0.17, place: 0.17, show: 0.17, exacta: 0.20, trifecta: 0.30, superfecta: 0.30 },
  CT:  { win: 0.1725, place: 0.1725, show: 0.1725, exacta: 0.25, trifecta: 0.25, superfecta: 0.25 },
  MNR: { win: 0.1725, place: 0.1725, show: 0.1725, exacta: 0.19, trifecta: 0.19, superfecta: 0.19 },
  CNL: { win: 0.18, place: 0.18, show: 0.18, exacta: 0.22, trifecta: 0.22, superfecta: 0.22 },

  // --- New Jersey ---------------------------------------------------------
  MTH: { win: 0.17, place: 0.17, show: 0.17, exacta: 0.19, trifecta: 0.25, superfecta: 0.25 },
  MED: { win: 0.17, place: 0.17, show: 0.17, exacta: 0.19, trifecta: 0.25, superfecta: 0.25 },

  // --- New York (non-NYRA) -----------------------------------------------
  FL:  { win: 0.16, place: 0.16, show: 0.16, exacta: 0.19, trifecta: 0.25, superfecta: 0.25 },

  // --- Texas / Oklahoma ---------------------------------------------------
  LS:  { win: 0.18, place: 0.18, show: 0.18, exacta: 0.21, trifecta: 0.25, superfecta: 0.25 },
  HOU: { win: 0.18, place: 0.18, show: 0.18, exacta: 0.21, trifecta: 0.25, superfecta: 0.25 },
  RP:  { win: 0.18, place: 0.18, show: 0.18, exacta: 0.20, trifecta: 0.22, superfecta: 0.22 },
  WRD: { win: 0.18, place: 0.18, show: 0.18, exacta: 0.20, trifecta: 0.22, superfecta: 0.22 },

  // --- Midwest ------------------------------------------------------------
  IND: { win: 0.18, place: 0.18, show: 0.18, exacta: 0.21, trifecta: 0.24, superfecta: 0.24 },
  HAW: { win: 0.17, place: 0.17, show: 0.17, exacta: 0.205, trifecta: 0.25, superfecta: 0.25 },
  PRM: { win: 0.18, place: 0.18, show: 0.18, exacta: 0.22, trifecta: 0.25, superfecta: 0.25 },
  CBY: { win: 0.17, place: 0.17, show: 0.17, exacta: 0.23, trifecta: 0.23, superfecta: 0.23 },
  PID: { win: 0.17, place: 0.17, show: 0.17, exacta: 0.25, trifecta: 0.30, superfecta: 0.30 },

  // --- Canada -------------------------------------------------------------
  WO:  { win: 0.1695, place: 0.1695, show: 0.1695, exacta: 0.2605, trifecta: 0.283, superfecta: 0.283 },
};

/**
 * Resolve W/P/S takeout rates for a track. Returns the table entry when the
 * code is present, otherwise returns the caller's fallback unchanged. The
 * fallback is the env-var-backed global config — so an unknown track quietly
 * uses sensible defaults rather than failing.
 *
 * Exotic rates (exacta/trifecta/superfecta) are not exposed here — read them
 * directly from `TRACK_TAKEOUT[trackCode]` when needed by the bet planner or
 * future exotic-payout estimators.
 */
export function resolveTakeoutForTrack(
  trackCode: string | undefined | null,
  fallback: { win: number; place: number; show: number },
): { win: number; place: number; show: number } {
  if (!trackCode) return fallback;
  const entry = TRACK_TAKEOUT[trackCode];
  if (!entry) return fallback;
  return { win: entry.win, place: entry.place, show: entry.show };
}
