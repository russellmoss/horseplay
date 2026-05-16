import { describe, expect, it } from 'vitest';
import { parseFanDuelUrl } from '../lib/scraper/url-parser';

describe('parseFanDuelUrl', () => {
  it('parses the canonical Belmont URL with race param', () => {
    const out = parseFanDuelUrl(
      'https://racing.fanduel.com/racetracks/BEL/belmont-at-the-big-a?race=1',
    );
    expect(out).toEqual({ trackCode: 'BEL', raceNumber: 1 });
  });

  it('parses without the race query param', () => {
    const out = parseFanDuelUrl(
      'https://racing.fanduel.com/racetracks/CD/churchill-downs',
    );
    expect(out).toEqual({ trackCode: 'CD', raceNumber: null });
  });

  it('handles trailing slash with race param', () => {
    const out = parseFanDuelUrl(
      'https://racing.fanduel.com/racetracks/SAR/saratoga/?race=8',
    );
    expect(out).toEqual({ trackCode: 'SAR', raceNumber: 8 });
  });

  it('accepts a URL without a slug after the track code', () => {
    const out = parseFanDuelUrl('https://racing.fanduel.com/racetracks/GP?race=11');
    expect(out).toEqual({ trackCode: 'GP', raceNumber: 11 });
  });

  it('uppercases the track code', () => {
    const out = parseFanDuelUrl(
      'https://racing.fanduel.com/racetracks/bel/belmont-at-the-big-a?race=3',
    );
    expect(out).toEqual({ trackCode: 'BEL', raceNumber: 3 });
  });

  it('accepts protocol-less URLs', () => {
    const out = parseFanDuelUrl('racing.fanduel.com/racetracks/KEE/keeneland?race=4');
    expect(out).toEqual({ trackCode: 'KEE', raceNumber: 4 });
  });

  it('accepts path-only URLs', () => {
    const out = parseFanDuelUrl('/racetracks/AQU/aqueduct?race=2');
    expect(out).toEqual({ trackCode: 'AQU', raceNumber: 2 });
  });

  it('trims whitespace', () => {
    const out = parseFanDuelUrl(
      '   https://racing.fanduel.com/racetracks/BEL/belmont-at-the-big-a?race=1   ',
    );
    expect(out).toEqual({ trackCode: 'BEL', raceNumber: 1 });
  });

  it('returns null for non-FanDuel URLs', () => {
    expect(parseFanDuelUrl('https://example.com/horses')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseFanDuelUrl('')).toBeNull();
    expect(parseFanDuelUrl('   ')).toBeNull();
  });

  it('returns null for malformed paths', () => {
    expect(parseFanDuelUrl('https://racing.fanduel.com/something-else')).toBeNull();
    expect(parseFanDuelUrl('https://racing.fanduel.com/racetracks/')).toBeNull();
  });

  it('handles odd race= values gracefully', () => {
    expect(parseFanDuelUrl('/racetracks/BEL?race=0')).toEqual({
      trackCode: 'BEL',
      raceNumber: null, // 0 is not a valid race number
    });
    expect(parseFanDuelUrl('/racetracks/BEL?race=abc')).toEqual({
      trackCode: 'BEL',
      raceNumber: null,
    });
  });

  it('extracts race param when present alongside other query params', () => {
    const out = parseFanDuelUrl(
      'https://racing.fanduel.com/racetracks/BEL/belmont-at-the-big-a?ref=foo&race=12&utm_source=email',
    );
    expect(out).toEqual({ trackCode: 'BEL', raceNumber: 12 });
  });
});
