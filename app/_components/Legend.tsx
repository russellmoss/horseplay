'use client';

import { EXPLANATIONS, SIGNAL_ACTIONS } from './explanations';

const TONE_CLASSES = {
  green: 'border-green-700 bg-green-950 text-green-200',
  yellow: 'border-yellow-700 bg-yellow-950 text-yellow-200',
  red: 'border-red-700 bg-red-950 text-red-200',
  gray: 'border-zinc-700 bg-zinc-900 text-zinc-400',
} as const;

export function Legend() {
  return (
    <div className="border-b border-zinc-800 bg-zinc-950/40 px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <div className="font-bold text-zinc-200">How to read this:</div>
        <div className="flex-1 text-zinc-400">{EXPLANATIONS.thesis}</div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(['slam_dunk', 'lean', 'drift', 'none'] as const).map((sig) => {
          const def = SIGNAL_ACTIONS[sig];
          return (
            <div
              key={sig}
              className={`rounded border px-3 py-2 ${TONE_CLASSES[def.tone]}`}
            >
              <div className="text-xs font-bold uppercase tracking-wide">{def.label}</div>
              <div className="mt-1 text-xs leading-relaxed">{def.action}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
