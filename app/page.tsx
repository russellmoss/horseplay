'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Race, RaceAnalysis } from '../lib/types';
import type { ScraperStatus } from '../lib/scraper/runtime';
import { Header } from './_components/Header';
import { Legend } from './_components/Legend';
import { RaceTable } from './_components/RaceTable';
import { BUDGET_STORAGE_KEY, PerRaceBetPanel } from './_components/PerRaceBetPanel';
import { Chat } from './_components/Chat';
import { VideoPanel, readVideoPanelOpenFlag } from './_components/VideoPanel';
import {
  loadBets,
  resolveBet,
  saveBets,
  summarizePnl,
  type PlacedBet,
} from './_components/bets';
import { playLoseSound, playWinSound, primeAudio } from './_components/sound';
import { nextRaceIdIfDue, pickDefaultRaceId } from './_components/formatters';

interface OddsResponse {
  status: ScraperStatus;
  races: RaceAnalysis[];
  count: number;
}

const POLL_INTERVAL_MS = Number(
  process.env.NEXT_PUBLIC_DASHBOARD_POLL_MS ?? '5000',
);

/**
 * Tracks that come from the server-side config (TRACKED_TRACKS env var). These
 * always stay in the dashboard's tracked set; user-added tracks are shown as
 * removable chips alongside them.
 */
const DEFAULT_TRACKS: string[] = ['CD'];

export default function DashboardPage() {
  const [data, setData] = useState<OddsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRaceId, setSelectedRaceId] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(false);
  const [lastApiUpdateMs, setLastApiUpdateMs] = useState<number | null>(null);
  const [bets, setBets] = useState<PlacedBet[]>([]);
  const [resolutionToast, setResolutionToast] = useState<{
    bet: PlacedBet;
    expiresAt: number;
  } | null>(null);
  /**
   * When the user pastes a FanDuel URL with `?race=N`, we stash the (track, race)
   * pair here. The auto-pick effect watches data.races for that track+number to
   * appear (after the new track's bootstrap completes) and selects it once.
   */
  const [pendingTrackFocus, setPendingTrackFocus] = useState<{
    trackCode: string;
    raceNumber: number;
  } | null>(null);
  /**
   * Race IDs we've already announced via ElevenLabs voice pick this session.
   * Prevents double-firing while the same race sits in the T-60s window across
   * multiple poll ticks.
   */
  const [voicePickedRaces, setVoicePickedRaces] = useState<Set<string>>(
    () => new Set(),
  );
  /**
   * Race IDs we've already triggered a lock-recommendation for. Lock fires at
   * T-1:00 and is idempotent server-side; the set just prevents repeated
   * client-side POSTs for the same race during the trigger window.
   */
  const [lockedRecRaces, setLockedRecRaces] = useState<Set<string>>(
    () => new Set(),
  );
  /** Race IDs we've already triggered the structured bet-plan lock for. */
  const [lockedBetPlanRaces, setLockedBetPlanRaces] = useState<Set<string>>(
    () => new Set(),
  );
  /** Caption shown briefly after a voice pick fires, so the user can read along. */
  const [voicePickToast, setVoicePickToast] = useState<{
    text: string;
    expiresAt: number;
  } | null>(null);
  const [videoOpen, setVideoOpen] = useState<boolean>(false);
  const userOverrodeRace = useRef<boolean>(false);
  const soundEnabledRef = useRef<boolean>(false);
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    // Persist so a page reload remembers the preference.
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(
          'derbyEdge.soundEnabled.v1',
          soundEnabled ? '1' : '0',
        );
      } catch {
        // ignore quota errors
      }
    }
  }, [soundEnabled]);

  // ── Load bets + sound preference from localStorage on mount ───────────
  useEffect(() => {
    setBets(loadBets());
    if (typeof window !== 'undefined') {
      try {
        const stored = window.localStorage.getItem('derbyEdge.soundEnabled.v1');
        if (stored === '1') setSoundEnabled(true);
      } catch {
        // ignore
      }
    }
    setVideoOpen(readVideoPanelOpenFlag());
  }, []);

  // ── Poll /api/odds ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const fetchOdds = async () => {
      try {
        const res = await fetch('/api/odds', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as OddsResponse;
        if (cancelled) return;
        setData(json);
        setLastApiUpdateMs(Date.now());
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void fetchOdds();
    const id = setInterval(fetchOdds, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ── Auto-pick / auto-advance the selected race ─────────────────────────
  useEffect(() => {
    if (!data || data.races.length === 0) return;
    const raceIds = new Set(data.races.map((r) => r.race.raceId));

    if (selectedRaceId && !raceIds.has(selectedRaceId)) {
      setSelectedRaceId(null);
      userOverrodeRace.current = false;
      return;
    }

    if (!selectedRaceId) {
      const pick = pickDefaultRaceId(data.races);
      if (pick) setSelectedRaceId(pick);
      return;
    }

    if (!userOverrodeRace.current) {
      const advanced = nextRaceIdIfDue(data.races, selectedRaceId, Date.now());
      if (advanced && advanced !== selectedRaceId) {
        setSelectedRaceId(advanced);
      }
    }
  }, [data, selectedRaceId]);

  // ── Auto-focus a race after a URL-driven track add ──────────────────
  useEffect(() => {
    if (!data || !pendingTrackFocus) return;
    const target = data.races.find(
      (r) =>
        r.race.trackCode === pendingTrackFocus.trackCode &&
        r.race.raceNumber === pendingTrackFocus.raceNumber,
    );
    if (target) {
      setSelectedRaceId(target.race.raceId);
      userOverrodeRace.current = true;
      setPendingTrackFocus(null);
    }
  }, [data, pendingTrackFocus]);

  // ── Voice pick at T-60s ─────────────────────────────────────────────
  useEffect(() => {
    if (!data || !soundEnabledRef.current) return;
    const now = Date.now();
    for (const ra of data.races) {
      if (ra.race.status !== 'open') continue;
      if (voicePickedRaces.has(ra.race.raceId)) continue;
      const mtpSec = (Date.parse(ra.race.postTimeUtc) - now) / 1000;
      if (!Number.isFinite(mtpSec)) continue;
      // Trigger window: T-2:00 through T-1:00 (120s through 60s).
      // We fire EARLY because the pipeline (Claude pick → ElevenLabs synth →
      // browser audio play) takes 5–30s end to end. Triggering at ~T-2:00
      // lands the audio in the user's ear roughly at T-1:30 (typical) to
      // T-1:00 (slow pipeline) — exactly when they want to know what to bet.
      // The wide 60s window absorbs poll-timing edge cases (5s cadence).
      if (mtpSec >= 60 && mtpSec <= 120) {
        // Mark as announced FIRST (before fetch) so a re-render mid-flight
        // doesn't fire a second request.
        setVoicePickedRaces((prev) => {
          const next = new Set(prev);
          next.add(ra.race.raceId);
          return next;
        });
        const raceLabel = `${ra.race.trackCode} R${ra.race.raceNumber}`;
        void (async () => {
          try {
            const res = await fetch(
              `/api/voice-pick/${encodeURIComponent(ra.race.raceId)}`,
              { cache: 'no-store' },
            );
            if (!res.ok) {
              console.warn(`voice-pick ${raceLabel}: HTTP ${res.status}`);
              return;
            }
            const text = decodeURIComponent(
              res.headers.get('x-pick-text') ?? '',
            );
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.onended = () => URL.revokeObjectURL(url);
            audio.onerror = () => URL.revokeObjectURL(url);
            await audio.play().catch((err) => {
              console.warn(
                `voice-pick ${raceLabel}: audio.play() failed`,
                err,
              );
            });
            if (text) {
              setVoicePickToast({
                text: `🔊 ${raceLabel} — ${text}`,
                expiresAt: Date.now() + 15_000,
              });
            }
          } catch (err) {
            console.warn(`voice-pick ${raceLabel} failed:`, err);
          }
        })();
      }
    }
  }, [data, voicePickedRaces]);

  // ── Lock the longer "🎯 Bet recommendation" at T-1:00 ───────────────
  // Server-side endpoint is idempotent; this just makes sure the snapshot
  // gets captured for every race the dashboard sees, regardless of whether
  // the user manually clicked "Get AI recommendation".
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    for (const ra of data.races) {
      if (ra.race.status !== 'open') continue;
      if (lockedRecRaces.has(ra.race.raceId)) continue;
      const mtpSec = (Date.parse(ra.race.postTimeUtc) - now) / 1000;
      if (!Number.isFinite(mtpSec)) continue;
      // Trigger window: T-1:30 through T-0:30. Generation takes ~3-10s, so
      // the lock typically completes around T-1:00 to T-0:50 — captures the
      // model's read on the race at "lock time" for post-race analysis.
      if (mtpSec >= 30 && mtpSec <= 90) {
        setLockedRecRaces((prev) => {
          const next = new Set(prev);
          next.add(ra.race.raceId);
          return next;
        });
        const raceLabel = `${ra.race.trackCode} R${ra.race.raceNumber}`;
        void (async () => {
          try {
            const res = await fetch(
              `/api/lock-recommendation/${encodeURIComponent(ra.race.raceId)}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ budget: 20 }),
              },
            );
            if (!res.ok) {
              console.warn(`lock-rec ${raceLabel}: HTTP ${res.status}`);
            }
          } catch (err) {
            console.warn(`lock-rec ${raceLabel} failed:`, err);
          }
        })();
      }
    }
  }, [data, lockedRecRaces]);

  // ── Lock the structured bet plan at T-1:00 ──────────────────────────
  // Tight window (~T-1:05 through T-0:55): the snapshot the simulation runs
  // against should reflect the state of the race at exactly 1 minute to post,
  // so the export reflects a bet a human could have realistically placed in
  // that final minute. Server is idempotent.
  //
  // Budget comes from the dashboard's session-wide budget (the $ field in the
  // bet panel, persisted to localStorage). Defaults to $20 if unset.
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    for (const ra of data.races) {
      if (ra.race.status !== 'open') continue;
      if (lockedBetPlanRaces.has(ra.race.raceId)) continue;
      const mtpSec = (Date.parse(ra.race.postTimeUtc) - now) / 1000;
      if (!Number.isFinite(mtpSec)) continue;
      // First poll where the race has ≤65s to post triggers the lock. The
      // 45s lower bound prevents back-firing on late-load races we missed.
      if (mtpSec >= 45 && mtpSec <= 65) {
        setLockedBetPlanRaces((prev) => {
          const next = new Set(prev);
          next.add(ra.race.raceId);
          return next;
        });
        const raceLabel = `${ra.race.trackCode} R${ra.race.raceNumber}`;
        // Read the current session budget at lock time.
        let budget = 20;
        if (typeof window !== 'undefined') {
          try {
            const stored = window.localStorage.getItem(BUDGET_STORAGE_KEY);
            if (stored) {
              const n = Number(stored);
              if (Number.isFinite(n) && n >= 2) budget = Math.floor(n);
            }
          } catch {
            // ignore
          }
        }
        void (async () => {
          try {
            const res = await fetch(
              `/api/lock-bet-plan/${encodeURIComponent(ra.race.raceId)}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ budget }),
              },
            );
            if (!res.ok) {
              console.warn(`lock-bet-plan ${raceLabel}: HTTP ${res.status}`);
            }
          } catch (err) {
            console.warn(`lock-bet-plan ${raceLabel} failed:`, err);
          }
        })();
      }
    }
  }, [data, lockedBetPlanRaces]);

  // ── Auto-dismiss the voice-pick toast ───────────────────────────────
  useEffect(() => {
    if (!voicePickToast) return;
    const id = setTimeout(
      () => setVoicePickToast(null),
      Math.max(0, voicePickToast.expiresAt - Date.now()),
    );
    return () => clearTimeout(id);
  }, [voicePickToast]);

  const selectedRace =
    data?.races.find((r) => r.race.raceId === selectedRaceId) ?? null;

  // ── Resolve bets when their race goes official ────────────────────────
  useEffect(() => {
    if (!data) return;
    const racesById = new Map<string, Race>(
      data.races.map((a) => [a.race.raceId, a.race]),
    );
    setBets((prev) => {
      const newlyResolved: PlacedBet[] = [];
      const next = prev.map((bet) => {
        if (bet.resolved) return bet;
        const race = racesById.get(bet.raceId);
        if (!race) return bet;
        const resolution = resolveBet(bet, race);
        if (!resolution) return bet;
        const updated: PlacedBet = { ...bet, resolved: resolution };
        newlyResolved.push(updated);
        return updated;
      });
      if (newlyResolved.length === 0) return prev;
      saveBets(next);
      // Show a toast (visible even with sound off) for the most-recent
      // resolution. If multiple resolve in one tick, prefer the win.
      const winner = newlyResolved.find((b) => b.resolved!.won);
      const toastBet = winner ?? newlyResolved[newlyResolved.length - 1];
      setResolutionToast({
        bet: toastBet,
        expiresAt: Date.now() + 12_000,
      });
      // Defer sound so React state settles. One sound per tick.
      if (soundEnabledRef.current) {
        const anyWon = newlyResolved.some((b) => b.resolved!.won);
        setTimeout(() => {
          if (anyWon) playWinSound();
          else playLoseSound();
        }, 0);
      }
      return next;
    });
  }, [data]);

  // ── Auto-dismiss the resolution toast ─────────────────────────────────
  useEffect(() => {
    if (!resolutionToast) return;
    const id = setTimeout(
      () => setResolutionToast(null),
      Math.max(0, resolutionToast.expiresAt - Date.now()),
    );
    return () => clearTimeout(id);
  }, [resolutionToast]);

  const handleSelectRace = (raceId: string): void => {
    setSelectedRaceId(raceId);
    userOverrodeRace.current = true;
  };

  const handleToggleSound = (): void => {
    setSoundEnabled((prev) => {
      const next = !prev;
      if (next) {
        // Prime browser audio policy with the user gesture.
        primeAudio();
      }
      return next;
    });
  };

  const handleAddBet = useCallback((bet: PlacedBet) => {
    setBets((prev) => {
      const next = [...prev, bet];
      saveBets(next);
      return next;
    });
  }, []);

  const handleRemoveBet = useCallback((id: string) => {
    setBets((prev) => {
      const next = prev.filter((b) => b.id !== id);
      saveBets(next);
      return next;
    });
  }, []);

  const handleClearResolvedBets = useCallback(() => {
    setBets((prev) => {
      const next = prev.filter((b) => !b.resolved);
      saveBets(next);
      return next;
    });
  }, []);

  const pnl = summarizePnl(bets);

  // ── Render states ──────────────────────────────────────────────────────
  if (!data) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100">
        <div className="px-6 py-12 text-center">
          {error ? (
            <div className="text-red-400">
              Failed to reach /api/odds: {error}
            </div>
          ) : (
            <div className="text-zinc-400">Loading…</div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Hero — image background, controls overlaid */}
      <div className="relative isolate overflow-hidden">
        <div
          className="absolute inset-0 -z-10 bg-cover bg-center"
          style={{ backgroundImage: "url('/images/hero.avif')" }}
          aria-hidden
        />
        {/* Subtle dark gradient on top of image so overlaid panels stay legible
            without burying the image entirely. */}
        <div
          className="absolute inset-0 -z-10 bg-gradient-to-b from-black/30 via-black/10 to-black/40"
          aria-hidden
        />
        <Header
          races={data.races}
          selectedRaceId={selectedRaceId}
          onSelectRace={handleSelectRace}
          selectedRace={selectedRace}
          lastApiUpdateMs={lastApiUpdateMs}
          scraperState={data.status.state}
          scraperMessage={data.status.message}
          scraperFramesReceived={data.status.framesReceived}
          scraperLastFrameAt={data.status.lastFrameAt}
          botChallengePending={data.status.botChallengePending ?? false}
          botChallengeDetectedAt={data.status.botChallengeDetectedAt ?? null}
          trackedTracks={data.status.trackedTracks ?? []}
          defaultTracks={DEFAULT_TRACKS}
          onTrackAdded={({ trackCode, raceNumber }) => {
            if (raceNumber !== null) {
              setPendingTrackFocus({ trackCode, raceNumber });
            }
          }}
          soundEnabled={soundEnabled}
          onToggleSound={handleToggleSound}
          viewerMode={data.status.state === 'remote'}
        />
        {/* Spacer so the image actually shows between the header and the
            content below — that's the part the user sees uncovered. */}
        <div className="h-40 md:h-56 lg:h-64" aria-hidden />

        {/* Bet portfolio summary bar */}
        {bets.length > 0 && (
          <div className="border-b border-zinc-800/60 bg-black/60 px-4 py-2 text-xs backdrop-blur-md">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-bold text-zinc-100">Your bets:</span>
              <span className="text-zinc-300">
                {bets.length} total · {pnl.pendingCount} pending · {pnl.wonCount} won · {pnl.lostCount} lost
              </span>
              <span className="text-zinc-400">
                staked <span className="font-mono text-zinc-200">${pnl.staked.toFixed(2)}</span>
              </span>
              <span className="text-zinc-400">
                returned{' '}
                <span className="font-mono text-zinc-200">${pnl.returned.toFixed(2)}</span>
              </span>
              <span
                className={`font-mono font-bold ${
                  pnl.profit > 0
                    ? 'text-green-400'
                    : pnl.profit < 0
                      ? 'text-red-400'
                      : 'text-zinc-300'
                }`}
              >
                P/L {pnl.profit >= 0 ? '+' : ''}${pnl.profit.toFixed(2)}
              </span>
              {(pnl.wonCount + pnl.lostCount) > 0 && (
                <button
                  type="button"
                  onClick={handleClearResolvedBets}
                  className="ml-auto text-zinc-400 hover:text-red-400"
                >
                  clear resolved
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {data.races.length === 0 ? (
        <div className="px-6 py-12 text-center text-zinc-400">
          {data.status.state === 'running'
            ? 'Waiting for the first WebSocket frame from FanDuel… Pool data should arrive within a minute.'
            : 'Scraper is not running. See banner above.'}
        </div>
      ) : selectedRace === null ? (
        <div className="px-6 py-12 text-center text-zinc-400">
          Pick a race from the dropdown to view its analysis.
        </div>
      ) : (
        <>
          <div className="px-4 pt-3">
            <PerRaceBetPanel
              analysis={selectedRace}
              bets={bets}
              onAddBet={handleAddBet}
              onRemoveBet={handleRemoveBet}
            />
          </div>
          <RaceTable analysis={selectedRace} />
          <Legend />
        </>
      )}

      {error && (
        <div className="fixed bottom-4 right-4 max-w-sm rounded border border-red-700 bg-red-950 px-3 py-2 text-xs text-red-200 shadow-lg">
          API error: {error} (retrying every {POLL_INTERVAL_MS / 1000}s)
        </div>
      )}

      {data.status.state !== 'remote' && (
        <Chat
          bets={bets}
          focusedRaceId={selectedRace?.race.raceId ?? null}
          focusedRaceLabel={
            selectedRace
              ? `${selectedRace.race.trackCode} R${selectedRace.race.raceNumber}`
              : null
          }
        />
      )}

      {/* Video toggle — sits just above the chat launcher */}
      <button
        type="button"
        onClick={() => setVideoOpen((v) => !v)}
        className={`fixed bottom-16 left-4 z-40 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold shadow-2xl ${
          videoOpen
            ? 'border-amber-500 bg-amber-700 text-amber-50 hover:bg-amber-600'
            : 'border-amber-700 bg-amber-900 text-amber-100 hover:bg-amber-800'
        }`}
        title={videoOpen ? 'Hide stream panel' : 'Show stream panel'}
      >
        📺 {videoOpen ? 'Hide stream' : 'Watch stream'}
      </button>

      <VideoPanel open={videoOpen} onClose={() => setVideoOpen(false)} />

      {voicePickToast && (
        <div className="fixed bottom-20 right-4 z-50 max-w-md rounded-lg border-2 border-amber-500 bg-amber-950 px-4 py-3 text-amber-100 shadow-2xl">
          <div className="flex items-start gap-3">
            <div className="text-2xl">📢</div>
            <div className="flex-1">
              <div className="text-xs font-bold uppercase tracking-wide opacity-80">
                1 minute to post — voice pick
              </div>
              <div className="mt-1 text-sm font-semibold">
                {voicePickToast.text}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setVoicePickToast(null)}
              className="text-xs opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {resolutionToast && (
        <div
          className={`fixed top-4 right-4 z-50 max-w-md rounded-lg border-2 px-4 py-3 shadow-2xl ${
            resolutionToast.bet.resolved!.won
              ? 'border-green-500 bg-green-950 text-green-100'
              : 'border-red-500 bg-red-950 text-red-100'
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="text-3xl">
              {resolutionToast.bet.resolved!.won ? '🎉' : '💸'}
            </div>
            <div className="flex-1">
              <div className="text-xs font-bold uppercase tracking-wide opacity-80">
                {resolutionToast.bet.resolved!.won ? 'Bet won' : 'Bet lost'}
              </div>
              <div className="mt-0.5 text-base font-bold">
                {resolutionToast.bet.trackCode} R{resolutionToast.bet.raceNumber}{' '}
                — ${resolutionToast.bet.amount} {resolutionToast.bet.betType} on
                #{resolutionToast.bet.program} {resolutionToast.bet.horseName}
              </div>
              <div className="mt-1 font-mono text-sm">
                {resolutionToast.bet.resolved!.won
                  ? `Returned $${resolutionToast.bet.resolved!.payout.toFixed(2)} · Profit +$${resolutionToast.bet.resolved!.profit.toFixed(2)}`
                  : `Lost -$${resolutionToast.bet.amount.toFixed(2)}`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setResolutionToast(null)}
              className="text-xs opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
