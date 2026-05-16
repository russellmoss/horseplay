import * as fs from 'fs';
import * as path from 'path';
import type { FdrRaceUpdate } from './adapter';

/**
 * Records every FDR frame for a race that's running (status `RO`) or finished
 * (results populated), so we can answer the question:
 *
 *   "Does FDR emit an 'unofficial' frame — finishPosition populated but
 *    payoffs still zero — before the official frame?"
 *
 * If yes, we can fire a faster winner signal in the UI than the current
 * "wait for results.runners.length > 0" gate (which catches both stages).
 *
 * Writes append-only JSONL to `auth/finish-frames.jsonl`. The whole `auth/`
 * directory is gitignored so this never leaks.
 *
 * Each line is one record. Schema:
 *   ts:                ISO timestamp of when WE received the frame
 *   raceId:            FDR race id, e.g. "CD-11"
 *   tvgRaceId:         numeric tvg id
 *   statusCode:        FDR status.code on this frame
 *   hasResults:        results object present and non-null
 *   runnersCount:      number of result runners with finishPosition set
 *   allPayoffsZero:    true if every runner has winPayoff === 0 (i.e. unofficial)
 *   anyPayoffNonZero:  true if any runner has a non-zero payoff (i.e. official)
 *   frame:             the raw FdrRaceUpdate JSON
 *
 * Grep recipe after a race finishes:
 *   grep 'CD-11' auth/finish-frames.jsonl | jq '{ts, statusCode, hasResults, runnersCount, allPayoffsZero, anyPayoffNonZero}'
 */

const LOG_PATH = path.join(process.cwd(), 'auth', 'finish-frames.jsonl');

interface RecorderState {
  /** Track raceIds we've ever logged for, so a single race doesn't spam from
   *  unrelated tracks across the JSONL. */
  loggedRaceIds: Set<string>;
}

const STATE: RecorderState = { loggedRaceIds: new Set() };

/**
 * Append a frame to the log if and only if it represents a running or
 * finished race. Pre-post (`O` / `IC` / `MO`) frames are ignored — those are
 * already in the regular network captures.
 *
 * Synchronous fs.appendFileSync is fine here: small payloads (few KB), not
 * on a hot path (only fires for one running race at a time per tracked track).
 */
export function recordIfFinishing(update: FdrRaceUpdate): void {
  const statusCode = update.status?.code;
  const hasResults =
    update.results !== null &&
    update.results !== undefined &&
    Array.isArray(update.results.runners);
  const isRunningOrFinished = statusCode === 'RO' || hasResults;
  if (!isRunningOrFinished) return;

  const runners = hasResults && update.results ? update.results.runners : [];
  const runnersCount = runners.length;
  const payoffs = runners.map((r) => Number(r.winPayoff ?? 0));
  const allPayoffsZero =
    payoffs.length > 0 && payoffs.every((p) => p === 0);
  const anyPayoffNonZero = payoffs.some((p) => p > 0);

  const record = {
    ts: new Date().toISOString(),
    raceId: update.id,
    tvgRaceId: update.tvgRaceId,
    statusCode: statusCode ?? null,
    hasResults,
    runnersCount,
    allPayoffsZero,
    anyPayoffNonZero,
    frame: update,
  };

  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
    if (!STATE.loggedRaceIds.has(update.id)) {
      STATE.loggedRaceIds.add(update.id);
      console.log(
        `[finish-recorder] ${update.id} status=${statusCode} hasResults=${hasResults} runners=${runnersCount} → logging to ${LOG_PATH}`,
      );
    }
  } catch (err) {
    // Don't let logging failures kill the scraper.
    console.warn(
      '[finish-recorder] failed to append frame:',
      err instanceof Error ? err.message : err,
    );
  }
}
