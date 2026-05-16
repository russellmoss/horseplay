function readString(key: string, fallback: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function readNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for env var ${key}: ${raw}`);
  }
  return parsed;
}

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  throw new Error(`Invalid boolean for env var ${key}: ${raw}`);
}

function readStringList(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readLogLevel(key: string, fallback: LogLevel): LogLevel {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  throw new Error(`Invalid log level for ${key}: ${raw}`);
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  trackedTracks: string[];
  fdrBaseUrl: string;
  pollCadenceLiveSeconds: number;
  pollCadenceNearSeconds: number;
  pollCadenceFarSeconds: number;
  pollConcurrency: number;
  takeoutWin: number;
  takeoutPlace: number;
  takeoutShow: number;
  signalLeanThreshold: number;
  signalDriftThreshold: number;
  /**
   * Favorite-longshot bias correction exponent applied to win-pool-implied
   * pWin. Literature default is 1.05–1.10. We default to 1.06 (mid-range,
   * conservative). Set to 1.0 to disable the correction.
   */
  flbAlpha: number;
  logLevel: LogLevel;
  dashboardPollMs: number;
  enableSoundAlerts: boolean;
}

export function loadConfig(): Config {
  return {
    trackedTracks: readStringList('TRACKED_TRACKS', ['CD']),
    fdrBaseUrl: readString('FDR_BASE_URL', 'https://racing.fanduel.com'),
    pollCadenceLiveSeconds: readNumber('POLL_CADENCE_LIVE_SECONDS', 15),
    pollCadenceNearSeconds: readNumber('POLL_CADENCE_NEAR_SECONDS', 60),
    pollCadenceFarSeconds: readNumber('POLL_CADENCE_FAR_SECONDS', 300),
    pollConcurrency: readNumber('POLL_CONCURRENCY', 3),
    takeoutWin: readNumber('TAKEOUT_WIN', 0.16),
    takeoutPlace: readNumber('TAKEOUT_PLACE', 0.17),
    takeoutShow: readNumber('TAKEOUT_SHOW', 0.17),
    signalLeanThreshold: readNumber('SIGNAL_LEAN_THRESHOLD', 0.05),
    signalDriftThreshold: readNumber('SIGNAL_DRIFT_THRESHOLD', 0.5),
    flbAlpha: readNumber('FLB_ALPHA', 1.06),
    logLevel: readLogLevel('LOG_LEVEL', 'info'),
    dashboardPollMs: readNumber('DASHBOARD_POLL_MS', 5000),
    enableSoundAlerts: readBoolean('ENABLE_SOUND_ALERTS', true),
  };
}
