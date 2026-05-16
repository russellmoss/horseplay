import { NextResponse } from 'next/server';
import { lockRecommendation } from '../../../../lib/store';
import { getRaceAny } from '../../../../lib/race-data';
import { generateVoicePick } from '../../../../lib/ai/voice-pick';
import { synthesizeSpeech } from '../../../../lib/ai/elevenlabs';
import { prepareTextForTts } from '../../../../lib/ai/speech';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/voice-pick/[raceId]
 * Generates a 1-sentence pick via Claude, synthesizes it via ElevenLabs,
 * returns the audio bytes (mp3) so the dashboard can play it inline.
 *
 * Returns the spoken text in `x-pick-text` response header so the frontend
 * can also display it visually.
 */
export async function GET(
  _req: Request,
  { params }: { params: { raceId: string } },
) {
  const { raceId } = params;
  if (!raceId) {
    return NextResponse.json({ error: 'raceId required' }, { status: 400 });
  }
  const analysis = await getRaceAny(raceId);
  if (!analysis) {
    return NextResponse.json(
      { error: `No cached analysis for race ${raceId}` },
      { status: 404 },
    );
  }

  let text: string;
  try {
    text = await generateVoicePick(analysis);
    // Save the voice pick text on the race's locked-recommendation record
    // so it survives in the xlsx export for post-race analysis.
    const mtpSec = Math.round(
      (Date.parse(analysis.race.postTimeUtc) - Date.now()) / 1000,
    );
    lockRecommendation(raceId, {
      voiceText: text,
      mtpAtLockSec: Number.isFinite(mtpSec) ? mtpSec : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not generate pick: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  const spoken = prepareTextForTts(text);
  let audio: Uint8Array;
  try {
    audio = await synthesizeSpeech(spoken);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not synthesize speech: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  // Wrap in fresh ArrayBuffer for BodyInit compatibility (same trick as the
  // xlsx export route).
  const ab = new ArrayBuffer(audio.byteLength);
  new Uint8Array(ab).set(audio);
  const body = new Blob([ab], { type: 'audio/mpeg' });

  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
      // Stash the spoken text so the UI can show it as a caption.
      'x-pick-text': encodeURIComponent(text),
    },
  });
}
