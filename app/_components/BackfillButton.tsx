'use client';

import { useState } from 'react';

interface BackfillResult {
  raceLabel: string;
  generatedPlan: boolean;
  settled: boolean;
  generatedNarrative: boolean;
  alreadyComplete: boolean;
  skipReason?: string;
  error?: string;
}

interface BackfillResponse {
  trackCode: string;
  postDate: string;
  total: number;
  results: BackfillResult[];
}

interface BackfillButtonProps {
  trackCode: string;
  postDate: string;
}

export function BackfillButton({ trackCode, postDate }: BackfillButtonProps): JSX.Element {
  const [busy, setBusy] = useState<boolean>(false);
  const [summary, setSummary] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setSummary(null);
    try {
      const url = `/api/backfill-day?trackCode=${encodeURIComponent(trackCode)}&date=${encodeURIComponent(postDate)}`;
      const res = await fetch(url, { method: 'POST' });
      const data = (await res.json()) as BackfillResponse | { error: string };
      if ('error' in data) {
        setSummary(`error: ${data.error}`);
        return;
      }
      const planned = data.results.filter((r) => r.generatedPlan).length;
      const settled = data.results.filter((r) => r.settled).length;
      const narrated = data.results.filter((r) => r.generatedNarrative).length;
      const skipped = data.results.filter((r) => r.skipReason).length;
      const errored = data.results.filter((r) => r.error).length;
      setSummary(
        `${data.total} races · ${planned} planned · ${settled} settled · ${narrated} narrated · ${skipped} skipped · ${errored} errors`,
      );
    } catch (err) {
      setSummary(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="rounded border border-blue-700 bg-blue-900/60 px-2 py-0.5 text-xs font-bold text-blue-100 hover:border-blue-500 hover:bg-blue-800 disabled:opacity-50"
        title="Generate bet plans + settle/narrate every cached race for this track on this day. Idempotent."
      >
        {busy ? '…' : '🔄 Backfill day'}
      </button>
      {summary && (
        <span className="text-[10px] text-zinc-400">{summary}</span>
      )}
    </span>
  );
}
