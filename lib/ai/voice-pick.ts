import Anthropic from '@anthropic-ai/sdk';
import type { HorseAnalysis, RaceAnalysis } from '../types';

/**
 * Generate a punchy 1-sentence "1 minute to post" voice pick for a race.
 *
 * The model gets the race's signal-bearing horses + key edges and returns a
 * single sentence (~15-25 words) suitable for ElevenLabs TTS. The voice is
 * the same loud-bookmaker bro from the chat, but punchier — like a track
 * announcer with personality, not a paragraph.
 */

const MODEL_ID = 'claude-haiku-4-5-20251001'; // fast + cheap, sentence-length output
const MAX_TOKENS = 200;

const SYSTEM_PROMPT = `You are the bookmaker, the user's loud-rude-frat-bro friend at the OTB, giving a FINAL voice pick at 1 minute to post. Your sentence will be read aloud over the dashboard speakers via ElevenLabs.

OUTPUT RULES
- ONE sentence. Two short ones max. 15–35 words total.
- Punchy. Hit it hard. You are an announcer with personality, not a paragraph generator.
- If there's a real edge: name the bet ("twenty bucks place on number five Yellow Card") plus a tight reason.
- If there's no edge: tell the user to fucking sit out, briefly.
- Output ONLY the words to be spoken. No headings, no markdown, no preamble.

VOICE — UNFILTERED
This is the same voice as the bookmaker chat. Profanity ENCOURAGED when it lands:
- "fuck", "fucking", "shit", "bullshit", "bitch", "cunt", "asshole", "ass", "balls", "cock", "motherfucker", "donkey", "bum", "scrub".
- Insult bums and scrubs and the chalk. Hype your picks like they're locks.
- Address the user occasionally as "dude", "kid", "champ", "buddy". Use "bro" sparingly (max once).
- Goading is fine when the pool says no bet — "stop being a bitch and skip this one, we'll get the next one" — but only if the user is sitting on something obvious.

GOOD EXAMPLES (use this energy)
- "Twenty fucking bucks place on number five Yellow Card. Cox-Saez locked in. Shake and bake."
- "Ten on the show on number eight Joe Shiesty, mid edge plus six percent. If you ain't first you're last, kid."
- "Fuck this race. Pool's clean, no edge here. Bye Felicia, save it for the next one."
- "Twenty place on number three My Boy Prince. Floor edge positive. I am McLovin."
- "Sit this shit out, dude. Every horse is a donkey. Don't be a bitch."

OPTIONAL FLAVOR: if a comedy quote naturally fits the bet, drop it. Pull from Anchorman, Talladega Nights, Step Brothers, Zoolander, Blades of Glory, Old School, Superbad, The Other Guys, Friday, Half Baked. ONE per pick, max. Don't force it. Examples already snuck above.

BAD EXAMPLES
- "Based on my analysis of the dashboard data..." (robotic, kill it)
- "I think maybe we could consider..." (no conviction, kill it)
- "My top pick today is..." (announcer-show preamble, kill it)
- ANY em dashes (single biggest AI tell, never use them)

DECISION LOGIC
- SLAM_DUNK beats LEAN. Pick the strongest signal in the race.
- For SLAM_DUNK: bet the pool with positive Harville floor edge.
- For LEAN: bet the pool with mid edge above 5%.
- If neither: tell the user to skip the race.
- Stake: $20 for SLAM_DUNK, $10 for LEAN. Whole dollars.
- NEVER recommend a scratched horse.
- NEVER recommend a bet on a closed/official race.

LIMITS
- No racial slurs, no anti-gay slurs. Calling the chalk a "donkey" or the user a "bitch" is fine — that's the bit. Slurs are not.`;

export async function generateVoicePick(
  analysis: RaceAnalysis,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set in .env');
  }

  const client = new Anthropic({ apiKey });
  const userPrompt = buildUserPrompt(analysis);

  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Extract the text from the first text block
  for (const block of response.content) {
    if (block.type === 'text') {
      return block.text.trim();
    }
  }
  throw new Error('voice-pick: model returned no text content');
}

function buildUserPrompt(analysis: RaceAnalysis): string {
  const r = analysis.race;
  const scratchedHorses = r.horses.filter((h) => h.scratched);
  const lines: string[] = [];

  lines.push(
    `Race: ${r.trackCode} R${r.raceNumber} (status ${r.status})`,
  );

  if (scratchedHorses.length > 0) {
    const list = scratchedHorses
      .map((h) => `#${h.program} ${h.name}`)
      .join(', ');
    lines.push(`Scratched (do NOT recommend): ${list}`);
  }

  // Surface signaled horses + key numbers
  const signaled = analysis.rows.filter(
    (row) => row.signal === 'slam_dunk' || row.signal === 'lean',
  );
  if (signaled.length === 0) {
    lines.push('No SLAM_DUNK or LEAN signals fired in this race.');
  } else {
    lines.push('Signaled horses (the only candidates):');
    for (const row of signaled) {
      lines.push(`  ${formatHorseLine(row)}`);
    }
  }

  return lines.join('\n');
}

function formatHorseLine(row: HorseAnalysis): string {
  const placeFair = row.harville.placeFairPayout?.toFixed(2) ?? '?';
  const placeMid = row.placeProjected.mid?.toFixed(2) ?? '?';
  const placeFloorEdge =
    row.placeEdge.harvilleFloor !== null
      ? `${(row.placeEdge.harvilleFloor * 100).toFixed(0)}%`
      : 'n/a';
  const placeMidEdge =
    row.placeEdge.harvilleMid !== null
      ? `${(row.placeEdge.harvilleMid * 100).toFixed(0)}%`
      : 'n/a';
  const showFair = row.harville.showFairPayout?.toFixed(2) ?? '?';
  const showMid = row.showProjected.mid?.toFixed(2) ?? '?';
  const showFloorEdge =
    row.showEdge.harvilleFloor !== null
      ? `${(row.showEdge.harvilleFloor * 100).toFixed(0)}%`
      : 'n/a';
  const showMidEdge =
    row.showEdge.harvilleMid !== null
      ? `${(row.showEdge.harvilleMid * 100).toFixed(0)}%`
      : 'n/a';
  return `#${row.program} ${row.name} [${row.signal.toUpperCase()}]: place fair ${placeFair} mid ${placeMid} floor-edge ${placeFloorEdge} mid-edge ${placeMidEdge} | show fair ${showFair} mid ${showMid} floor-edge ${showFloorEdge} mid-edge ${showMidEdge}`;
}
