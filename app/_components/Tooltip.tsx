'use client';

import type { ReactNode } from 'react';

export function Tooltip({
  content,
  children,
  width = 320,
}: {
  content: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <span className="group relative inline-flex cursor-help items-center">
      {children}
      <span
        className="invisible absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-pre-wrap rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs leading-relaxed text-zinc-100 opacity-0 shadow-xl transition-opacity duration-150 group-hover:visible group-hover:opacity-100"
        style={{ width }}
      >
        {content}
      </span>
    </span>
  );
}

/**
 * Inline `(?)` glyph that opens the tooltip on hover. Use as `<HelpHint hint="..." />`.
 */
export function HelpHint({ hint, width }: { hint: string; width?: number }) {
  return (
    <Tooltip content={hint} width={width}>
      <span
        aria-label="More info"
        className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-zinc-600 text-[9px] font-bold text-zinc-400 hover:border-zinc-400 hover:text-zinc-200"
      >
        ?
      </span>
    </Tooltip>
  );
}
