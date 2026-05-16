'use client';

/**
 * Bet-outcome chimes:
 *   win  → john-cena.mp3
 *   lose → fuck-you.mp3
 *
 * The first call MUST happen during a user gesture (click) on most browsers;
 * the dashboard primes it via the "🔔 sound: on" toggle.
 */

const WIN_SOUND = '/sounds/john-cena.mp3';
const LOSE_SOUND = '/sounds/fuck-you.mp3';
const VOLUME = 0.7;

function play(src: string): void {
  if (typeof window === 'undefined') return;
  try {
    const audio = new Audio(src);
    audio.volume = VOLUME;
    void audio.play().catch(() => {
      // Browser declined to play (no user gesture yet, etc.). Best-effort.
    });
  } catch {
    // Silent failure.
  }
}

export function playWinSound(): void {
  play(WIN_SOUND);
}

export function playLoseSound(): void {
  play(LOSE_SOUND);
}

/**
 * Used by the "🔔 sound: on" toggle to prime the browser audio policy.
 * Plays the win sound (the more pleasant of the two) so toggling on
 * doesn't punish the user with a "fuck you" out of nowhere.
 */
export function primeAudio(): void {
  playWinSound();
}
