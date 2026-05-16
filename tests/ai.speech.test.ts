import { describe, expect, it } from 'vitest';
import { prepareTextForTts } from '../lib/ai/speech';

describe('prepareTextForTts', () => {
  it('replaces #5 with "number 5"', () => {
    expect(prepareTextForTts('Bet on #5 Yellow Card')).toBe(
      'Bet on number 5 Yellow Card',
    );
  });

  it('replaces multiple program numbers', () => {
    expect(prepareTextForTts('I like #1, #5, and #12')).toBe(
      'I like number 1, number 5, and number 12',
    );
  });

  it('replaces fractional odds 9/2 with "9 to 2"', () => {
    expect(prepareTextForTts('Renegade is 9/2 ML')).toBe(
      'Renegade is 9 to 2 ML',
    );
  });

  it('replaces 12/1 odds correctly', () => {
    expect(prepareTextForTts('Out of the Woods drifted to 12/1')).toBe(
      'Out of the Woods drifted to 12 to 1',
    );
  });

  it('handles 1/2 (the original gotcha) correctly', () => {
    expect(prepareTextForTts('Heavy chalk at 1/2')).toBe(
      'Heavy chalk at 1 to 2',
    );
  });

  it('does NOT mangle dates like 5/3/2026', () => {
    expect(prepareTextForTts('Race date 5/3/2026 at Belmont')).toBe(
      'Race date 5/3/2026 at Belmont',
    );
  });

  it('does NOT mangle numeric paths or versions', () => {
    expect(prepareTextForTts('See 1/2/3/4 in the docs')).toBe(
      'See 1/2/3/4 in the docs',
    );
  });

  it('strips markdown headings, bold, and lists', () => {
    const input = '## Top Pick\n\n**#5 Yellow Card** is the move.\n\n- Reason 1\n- Reason 2';
    const out = prepareTextForTts(input);
    expect(out).not.toContain('##');
    expect(out).not.toContain('**');
    expect(out).toContain('number 5');
    expect(out).toContain('Yellow Card is the move.');
  });

  it('removes table rows', () => {
    const input = '| Horse | Bet |\n| --- | --- |\n| #5 | Place |';
    const out = prepareTextForTts(input);
    expect(out).not.toContain('|');
    expect(out).not.toContain('---');
  });

  it('handles ampersand in context', () => {
    expect(prepareTextForTts('Cox & Saez are a 29% combo')).toBe(
      'Cox and Saez are a 29% combo',
    );
  });

  it('handles "w/" abbreviation', () => {
    expect(prepareTextForTts('Cox w/ Saez are 29%')).toBe(
      'Cox with Saez are 29%',
    );
  });

  it('combines fixes in one sentence', () => {
    const input = '**Twenty bucks place on #5 Yellow Card** (9/2). Cox & Saez locked in.';
    expect(prepareTextForTts(input)).toBe(
      'Twenty bucks place on number 5 Yellow Card (9 to 2). Cox and Saez locked in.',
    );
  });

  it('returns empty string for empty/null input', () => {
    expect(prepareTextForTts('')).toBe('');
    expect(prepareTextForTts(null as unknown as string)).toBe('');
  });

  it('trims whitespace', () => {
    expect(prepareTextForTts('   hello   ')).toBe('hello');
  });
});
