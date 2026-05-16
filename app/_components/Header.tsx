'use client';

import { useEffect, useState } from 'react';
import type { RaceAnalysis, ProbSource } from '../../lib/types';
import { Tooltip, HelpHint } from './Tooltip';
import { EXPLANATIONS } from './explanations';
import { formatMtp, secondsToPostTime } from './formatters';
import { playLoseSound } from './sound';
import { AddTrackInput } from './AddTrackInput';

interface HeaderProps {
  races: RaceAnalysis[];
  selectedRaceId: string | null;
  onSelectRace: (raceId: string) => void;
  selectedRace: RaceAnalysis | null;
  lastApiUpdateMs: number | null;
  scraperState: string;
  scraperMessage: string;
  scraperFramesReceived: number;
  scraperLastFrameAt: string | null;
  botChallengePending: boolean;
  botChallengeDetectedAt: string | null;
  trackedTracks: string[];
  defaultTracks: string[];
  onTrackAdded?: (info: { trackCode: string; raceNumber: number | null }) => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  viewerMode?: boolean;
}

export function Header(props: HeaderProps) {
  const {
    races,
    selectedRaceId,
    onSelectRace,
    selectedRace,
    lastApiUpdateMs,
    scraperState,
    scraperMessage,
    scraperFramesReceived,
    scraperLastFrameAt,
    botChallengePending,
    botChallengeDetectedAt,
    trackedTracks,
    defaultTracks,
    onTrackAdded,
    soundEnabled,
    onToggleSound,
    viewerMode,
  } = props;

  const tracks = Array.from(new Set(races.map((r) => r.race.trackCode))).sort();
  const selectedTrack = selectedRace?.race.trackCode ?? tracks[0] ?? null;
  const racesAtTrack = races
    .filter((r) => r.race.trackCode === selectedTrack)
    .sort((a, b) => a.race.raceNumber - b.race.raceNumber);

  // Live ticking countdown
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const mtpSeconds = selectedRace
    ? secondsToPostTime(selectedRace.race.postTimeUtc, nowMs)
    : null;

  const lastUpdateAgoSec =
    lastApiUpdateMs !== null
      ? Math.max(0, Math.round((nowMs - lastApiUpdateMs) / 1000))
      : null;

  const probSource: ProbSource | null = selectedRace?.probSource ?? null;

  const healthy = scraperState === 'running';
  const banner =
    scraperState === 'session_expired'
      ? {
          tone: 'red' as const,
          msg: 'FDR session expired. Stop pnpm dev, run `pnpm run login`, then `pnpm dev` again.',
        }
      : scraperState === 'unhealthy'
        ? { tone: 'red' as const, msg: scraperMessage }
        : scraperState === 'starting'
          ? { tone: 'yellow' as const, msg: 'Scraper starting…' }
          : scraperState === 'stopped'
            ? { tone: 'yellow' as const, msg: 'Scraper not running.' }
            : null;

  const botChallengeAgoSec =
    botChallengePending && botChallengeDetectedAt
      ? Math.max(0, Math.round((nowMs - Date.parse(botChallengeDetectedAt)) / 1000))
      : null;

  return (
    <div className="border-b border-zinc-800/60 bg-black/60 backdrop-blur-md">
      {!viewerMode && botChallengePending && (
        <div className="border-b border-amber-700 bg-amber-950/95 px-4 py-3 text-sm text-amber-100">
          <div className="flex items-start gap-3">
            <div className="text-2xl">🤖</div>
            <div className="flex-1">
              <div className="font-bold uppercase tracking-wide text-amber-200">
                FanDuel wants you to verify you're human
              </div>
              <div className="mt-0.5 text-amber-100/90">
                The scraper hit a "Press &amp; Hold" check. Find the Chrome window the scraper opened (it should be on your taskbar / Cmd+Tab list, titled "racing.fanduel.com") and complete the press &amp; hold there. Pool data will resume on its own once it passes.
                <br />
                <span className="text-amber-300/80 text-xs">
                  Don't see a Chrome window? The scraper is running headless. Stop <code className="font-mono">pnpm dev</code>, then start it again — by default the window will now be visible.
                </span>
                {botChallengeAgoSec !== null && (
                  <span className="ml-2 text-amber-300/70">
                    (detected {botChallengeAgoSec}s ago)
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {!viewerMode && banner && (
        <div
          className={`px-4 py-2 text-sm ${
            banner.tone === 'red'
              ? 'bg-red-950/90 text-red-200'
              : 'bg-yellow-950/90 text-yellow-200'
          }`}
        >
          ⚠ {banner.msg}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <div className="text-2xl font-black tracking-tight text-zinc-100">
          HORSEPLAY
        </div>

        <div className="flex items-center gap-2 text-sm">
          <label className="text-zinc-400">Track:</label>
          <select
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
            value={selectedTrack ?? ''}
            onChange={(e) => {
              // Switch to the first race at the new track
              const tc = e.target.value;
              const firstAtTrack = races
                .filter((r) => r.race.trackCode === tc)
                .sort((a, b) => a.race.raceNumber - b.race.raceNumber)[0];
              if (firstAtTrack) onSelectRace(firstAtTrack.race.raceId);
            }}
          >
            {tracks.length === 0 ? (
              <option>—</option>
            ) : (
              tracks.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="basis-full">
          <AddTrackInput
            trackedTracks={trackedTracks}
            defaultTracks={defaultTracks}
            onTrackAdded={onTrackAdded}
            currentTrackCode={selectedTrack ?? null}
            onSelectTrack={(tc) => {
              const firstAtTrack = races
                .filter((r) => r.race.trackCode === tc)
                .sort((a, b) => a.race.raceNumber - b.race.raceNumber)[0];
              if (firstAtTrack) onSelectRace(firstAtTrack.race.raceId);
            }}
          />
        </div>

        <div className="flex items-center gap-2 text-sm">
          <label className="text-zinc-400">Race:</label>
          <select
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
            value={selectedRaceId ?? ''}
            onChange={(e) => onSelectRace(e.target.value)}
          >
            {racesAtTrack.length === 0 ? (
              <option>—</option>
            ) : (
              racesAtTrack.map((r) => (
                <option key={r.race.raceId} value={r.race.raceId}>
                  R{r.race.raceNumber} ({r.race.status})
                </option>
              ))
            )}
          </select>
        </div>

        <div className="flex items-center gap-1 text-sm">
          <Tooltip content={EXPLANATIONS.mtp}>
            <span className="text-zinc-400">⏱ MTP:</span>
          </Tooltip>
          <span
            className={`font-mono ${
              mtpSeconds !== null && mtpSeconds <= 60 && mtpSeconds > 0
                ? 'text-yellow-400'
                : mtpSeconds !== null && mtpSeconds <= 0
                  ? 'text-red-400'
                  : 'text-zinc-100'
            }`}
          >
            {formatMtp(mtpSeconds)}
          </span>
        </div>

        {probSource && (
          <div className="flex items-center gap-1 text-sm">
            <Tooltip content={EXPLANATIONS.probSource}>
              <span className="text-zinc-400">prob:</span>
            </Tooltip>
            <span
              className={`font-mono text-xs ${
                probSource === 'win_pool'
                  ? 'text-green-400'
                  : probSource === 'decimal_odds'
                    ? 'text-yellow-400'
                    : 'text-red-400'
              }`}
            >
              {probSource}
            </span>
          </div>
        )}

        <div className="flex items-center gap-1 text-sm text-zinc-500">
          <Tooltip content={EXPLANATIONS.lastUpdate}>
            <span>last update:</span>
          </Tooltip>
          <span className="font-mono">
            {lastUpdateAgoSec !== null ? `${lastUpdateAgoSec}s ago` : '—'}
          </span>
        </div>

        {!viewerMode && (
          <div className="flex items-center gap-1 text-xs text-zinc-500">
            <span>scraper:</span>
            <span
              className={`font-mono ${
                healthy ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {scraperState}
            </span>
            <span className="ml-1">({scraperFramesReceived} frames)</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleSound}
            className={`rounded border px-2 py-1 text-xs font-mono ${
              soundEnabled
                ? 'border-green-700 bg-green-950 text-green-300'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400'
            }`}
          >
            🔔 sound: {soundEnabled ? 'on' : 'off'}
          </button>
          {soundEnabled && (
            <Tooltip content="Plays the lose chime so you can confirm audio works in this browser.">
              <button
                type="button"
                onClick={() => playLoseSound()}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-mono text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              >
                test
              </button>
            </Tooltip>
          )}
        </div>

        <HelpHint
          hint={EXPLANATIONS.thesis}
          width={420}
        />
      </div>
    </div>
  );
}
