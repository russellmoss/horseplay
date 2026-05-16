'use client';

import { useState } from 'react';

interface AddTrackResponse {
  ok?: true;
  error?: string;
  trackCode?: string;
  raceNumberHint?: number | null;
  trackedTracks?: string[];
}

interface RemoveTrackResponse {
  ok?: true;
  error?: string;
  trackedTracks?: string[];
}

interface AddTrackInputProps {
  /** Currently tracked codes from the runtime status snapshot. */
  trackedTracks: string[];
  /** Default config tracks — these can't be removed (the dropdown would empty). */
  defaultTracks: string[];
  /**
   * Called after a successful add when the URL contained a `?race=N` hint.
   * The dashboard uses this to auto-select that race once it appears in
   * data.races. Args: { trackCode, raceNumber }.
   */
  onTrackAdded?: (info: { trackCode: string; raceNumber: number | null }) => void;
  /** Currently-active track in the dashboard. Highlights its chip. */
  currentTrackCode?: string | null;
  /** Click handler when the user clicks a chip — switches the active track. */
  onSelectTrack?: (trackCode: string) => void;
}

export function AddTrackInput({
  trackedTracks,
  defaultTracks,
  onTrackAdded,
  currentTrackCode,
  onSelectTrack,
}: AddTrackInputProps): JSX.Element {
  const [input, setInput] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const looksLikeUrl = /^https?:\/\//i.test(value) || value.startsWith('/');
      const body = looksLikeUrl ? { url: value } : { trackCode: value };
      const res = await fetch('/api/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as AddTrackResponse;
      if (!res.ok || json.error) {
        setErr(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setInput('');
      const trackCode = json.trackCode ?? '';
      const raceHint = json.raceNumberHint ?? null;
      setInfo(
        raceHint
          ? `Added ${trackCode}. Will auto-select R${raceHint} once its data lands.`
          : `Added ${trackCode}. Re-bootstrapping…`,
      );
      // Auto-clear the info banner after a few seconds
      setTimeout(() => setInfo(null), 6000);
      if (onTrackAdded && trackCode) {
        onTrackAdded({ trackCode, raceNumber: raceHint });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (code: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const res = await fetch('/api/track', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackCode: code }),
      });
      const json = (await res.json()) as RemoveTrackResponse;
      if (!res.ok || json.error) {
        setErr(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setInfo(`Removed ${code}.`);
      setTimeout(() => setInfo(null), 4000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Default tracks (config-driven) get a different style — they're not removable.
  const defaultSet = new Set(defaultTracks);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Paste FanDuel URL or track code (e.g. BEL)"
          disabled={busy}
          className="w-72 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!input.trim() || busy}
          className="rounded border border-amber-700 bg-amber-900 px-2.5 py-1 text-xs font-bold text-amber-100 hover:border-amber-500 hover:bg-amber-800 disabled:opacity-40"
        >
          {busy ? '…' : '+ Add'}
        </button>
      </div>
      {trackedTracks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            tracking:
          </span>
          {trackedTracks.map((t) => {
            const isDefault = defaultSet.has(t);
            const isCurrent = currentTrackCode === t;
            const baseStyle = isCurrent
              ? 'bg-amber-600 text-amber-50 ring-2 ring-amber-300'
              : isDefault
                ? 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                : 'bg-amber-900/60 text-amber-100 hover:bg-amber-800/80';
            return (
              <span
                key={t}
                className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold ${baseStyle}`}
                title={
                  isCurrent
                    ? 'currently viewing — click another to switch'
                    : 'click to switch to this track'
                }
              >
                <button
                  type="button"
                  onClick={() => onSelectTrack?.(t)}
                  disabled={!onSelectTrack || isCurrent}
                  className="font-mono font-bold disabled:cursor-default"
                  aria-label={isCurrent ? `${t} (current track)` : `Switch to ${t}`}
                >
                  {t}
                </button>
                {!isDefault && (
                  <button
                    type="button"
                    onClick={() => void remove(t)}
                    disabled={busy}
                    className={`${
                      isCurrent ? 'text-amber-100' : 'text-amber-300'
                    } hover:text-white`}
                    aria-label={`Remove ${t}`}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {err && (
        <div className="rounded border border-red-800 bg-red-950 px-2 py-1 text-[10px] text-red-200">
          ⚠ {err}
        </div>
      )}
      {info && (
        <div className="rounded border border-amber-800/60 bg-amber-950/50 px-2 py-1 text-[10px] text-amber-200">
          {info}
        </div>
      )}
    </div>
  );
}
