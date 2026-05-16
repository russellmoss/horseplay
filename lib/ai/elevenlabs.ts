/**
 * ElevenLabs Text-to-Speech wrapper. Used to speak the bookmaker's "1 minute
 * to post" pick out loud over the dashboard.
 *
 * API docs: https://elevenlabs.io/docs/api-reference/text-to-speech
 */

const ELEVEN_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

/** User-chosen voice for the bookmaker (set 2026-05-03). */
export const DEFAULT_VOICE_ID = 'Cb8NLd0sUB8jI4MW2f9M';

/**
 * Turbo v2 is the fast, low-latency model. Cheaper per character than the
 * multilingual or "v3" models. Quality is plenty good for a 1-sentence pick.
 */
const DEFAULT_MODEL_ID = 'eleven_turbo_v2';

export interface SynthesizeOptions {
  voiceId?: string;
  modelId?: string;
  /** 0 (more variable) → 1 (very stable). 0.4–0.6 is a good speech range. */
  stability?: number;
  /** 0 (loose) → 1 (clings to voice character). */
  similarityBoost?: number;
}

/**
 * Synthesize the given text into an mp3 byte buffer using ElevenLabs.
 * Throws if ELEVENLABS_API_KEY isn't set or the API call fails.
 */
export async function synthesizeSpeech(
  text: string,
  options: SynthesizeOptions = {},
): Promise<Uint8Array> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY not set in .env');
  }
  if (!text || text.trim().length === 0) {
    throw new Error('synthesizeSpeech: empty text');
  }
  const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
  const url = `${ELEVEN_TTS_URL}/${voiceId}`;
  const body = {
    text,
    model_id: options.modelId ?? DEFAULT_MODEL_ID,
    voice_settings: {
      stability: options.stability ?? 0.5,
      similarity_boost: options.similarityBoost ?? 0.75,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(
      `ElevenLabs HTTP ${response.status}: ${errText.slice(0, 300)}`,
    );
  }

  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}
