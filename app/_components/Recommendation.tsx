'use client';

import { useEffect, useState, useCallback } from 'react';

interface RecommendationResponse {
  text: string;
  generatedAt: string;
  racesConsidered: number;
  modelCalled: boolean;
  cached: boolean;
  cachedAgeMs: number;
  error?: string;
}

const POLL_INTERVAL_MS = 60_000;

export function Recommendation() {
  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRecommendation = useCallback(async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/recommendation', {
        method: force ? 'POST' : 'GET',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as RecommendationResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRecommendation(false);
    const id = setInterval(() => void fetchRecommendation(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchRecommendation]);

  const isError = data?.error || error;
  const ageSec = data
    ? Math.max(0, Math.round((Date.now() - Date.parse(data.generatedAt)) / 1000))
    : null;

  return (
    <div className="border-b border-zinc-800/60 bg-black/60 px-4 py-3 backdrop-blur-md">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          <div className="text-xs font-bold uppercase tracking-wide text-purple-300">
            🎯 Bet recommendation
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-500">
            $10 budget · ≤3 bets · place/show only
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {loading && !data ? (
            <div className="text-sm text-zinc-400">Asking the model…</div>
          ) : isError ? (
            <div className="text-sm text-red-300">
              {data?.error || error || 'Failed to fetch recommendation.'}
            </div>
          ) : data ? (
            <div className="text-sm leading-relaxed text-zinc-100">
              {data.text}
            </div>
          ) : (
            <div className="text-sm text-zinc-400">No recommendation yet.</div>
          )}
          {data && (
            <div className="mt-1 flex items-center gap-3 text-[10px] text-zinc-500">
              <span>
                {data.modelCalled ? 'sonnet-4-6' : 'no-call'}
                {' · '}
                considered {data.racesConsidered} race{data.racesConsidered === 1 ? '' : 's'}
                {' · '}
                {ageSec !== null ? `${ageSec}s old` : ''}
                {data.cached ? ' (cached)' : ''}
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void fetchRecommendation(true)}
          disabled={loading}
          className="flex-shrink-0 rounded border border-purple-700 bg-purple-950 px-3 py-1.5 text-xs font-medium text-purple-200 hover:border-purple-500 hover:bg-purple-900 disabled:opacity-50"
        >
          {loading ? '…' : '↻ Refresh'}
        </button>
      </div>
    </div>
  );
}
