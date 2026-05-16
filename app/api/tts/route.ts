import { NextResponse } from 'next/server';
import { synthesizeSpeech } from '../../../lib/ai/elevenlabs';
import { prepareTextForTts } from '../../../lib/ai/speech';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

interface TtsRequestBody {
  text: string;
  voiceId?: string;
}

/**
 * POST /api/tts — generic ElevenLabs synthesis. Accepts { text } and returns
 * mp3 bytes. Used by the chat drawer to read assistant replies aloud and by
 * conversation mode for the back-and-forth voice loop.
 */
export async function POST(req: Request) {
  let body: TtsRequestBody;
  try {
    body = (await req.json()) as TtsRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return NextResponse.json({ error: 'text required' }, { status: 400 });
  }
  // ElevenLabs caps single-call requests at ~5000 chars on most plans. Trim
  // defensively. The bookmaker's longer paragraphs sometimes exceed.
  // Also normalize for speech (#5 → number 5, 9/2 → 9 to 2, etc.) — clients
  // SHOULD have already done this, but apply server-side as a safety net so
  // any caller (including future ones) gets correct pronunciation.
  const normalized = prepareTextForTts(body.text);
  const text = normalized.length > 4500 ? normalized.slice(0, 4500) : normalized;

  let audio: Uint8Array;
  try {
    audio = await synthesizeSpeech(text, {
      voiceId: body.voiceId,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `TTS failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  const ab = new ArrayBuffer(audio.byteLength);
  new Uint8Array(ab).set(audio);
  const blob = new Blob([ab], { type: 'audio/mpeg' });

  return new NextResponse(blob, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
    },
  });
}
