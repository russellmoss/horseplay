/**
 * Normalize a string for ElevenLabs TTS so the synthesizer pronounces it
 * the way a human would in racing context. Strips markdown, then rewrites
 * symbols and fractions that the engine reads literally otherwise.
 *
 * Fixes (in order of importance to the dashboard):
 *   - "#5"   → "number 5"          (otherwise "hash 5")
 *   - "9/2"  → "9 to 2"            (otherwise "nine halves" or "9 over 2")
 *   - "12/1" → "12 to 1"           (same)
 *   - "&"    → "and"
 *   - "w/"   → "with"
 *
 * Doesn't touch dollar amounts, percent signs, or decimal numbers — ElevenLabs
 * handles those naturally ($20 → "twenty dollars", 6.5% → "six point five
 * percent", etc.). Trims excess whitespace.
 *
 * The fraction rule uses a lookbehind + lookahead to avoid mangling dates
 * like "5/3/2026" into "5 to 3 to 2026" — neither side may be adjacent to
 * a digit or another slash.
 */
export function prepareTextForTts(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;

  // ── Strip markdown so the synth doesn't pronounce "##" etc. ──────────
  out = out
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|.*$/gm, '')
    .replace(/^---+$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');

  // ── Speech normalizations ────────────────────────────────────────────
  // "#5" → "number 5"  (program numbers in racing)
  out = out.replace(/#(\d+)/g, 'number $1');
  // Fractional odds "9/2" → "9 to 2"; protected from dates like "5/3/2026"
  out = out.replace(/(?<![\d/])(\d+)\/(\d+)(?![\d/])/g, '$1 to $2');
  // "&" → "and" (often appears in handicapping notes)
  out = out.replace(/(?<=\s)&(?=\s)/g, 'and');
  // "w/" → "with " — `\b` won't anchor on the trailing slash since both / and
  // the following space are non-word, so we anchor on the next whitespace.
  out = out.replace(/\bw\/(\s)/g, 'with$1');

  // Collapse runs of blank lines
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}
