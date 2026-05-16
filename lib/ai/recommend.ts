import Anthropic from '@anthropic-ai/sdk';
import type { HorseAnalysis, RaceAnalysis } from '../types';

/**
 * Server-side bet recommender. Takes the cached RaceAnalysis[] and asks
 * Anthropic for a concrete bet recommendation under a $10 budget.
 *
 * Output: 1-4 sentences, plain prose, naming specific races + horses + bet
 * sizes. Or "no good bets right now" if the data doesn't support it.
 *
 * The Anthropic call uses prompt caching on the system message — the system
 * prompt rarely changes, but the race data changes every poll, so caching
 * shaves cost off the static portion.
 */

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 350;

const SYSTEM_PROMPT = `You are a betting advisor for Horseplay — a tool that finds +EV pari-mutuel bets at US horse racing tracks. You can recommend WIN, PLACE, or SHOW bets.

The tool's thesis: pari-mutuel WIN pools are large and efficient (track takeout ~16% means win edges are structurally near -16% for everyone — real +EV win bets are rare). PLACE and SHOW pools are smaller and more easily distorted; when somebody dumps a big bet on one horse, those pools end up mispriced relative to the win-pool-implied probability of finishing in the money. THAT is where the +EV bets typically live.

Each horse comes with these classifications:
- "slam_dunk" — the strongest signal. Even the WORST-CASE projected place or show payout (when paired with the heaviest-pool other finisher) still beats the math's fair price. Bet this horse to place or show.
- "lean" — second-tier. The AVERAGE projected payout is at least 5% above fair. Worth a smaller bet.
- "drift" — neutral signal. Live odds drifted >50% from morning line. Needs manual review (could be late info, could be noise). Don't bet on this signal alone.
- "none" — no place/show signal, but the win edge is still listed for completeness.

For each horse you'll see numeric edges in three pools:
- WIN edge — usually negative (~-16%) due to takeout. A POSITIVE win edge is unusual and worth a recommendation.
- PLACE edge — both "floor" (worst-case companion pairing) and "mid" (average). +EV opportunities live here.
- SHOW edge — same shape. Lower variance than place but smaller payouts.

YOUR JOB
The user will tell you their wagering budget for this query in the user message. Recommend specific bets within that budget. Each bet is at least $2 (the pari-mutuel minimum).

OUTPUT FORMAT
- Plain prose, 1-4 sentences total. No bullet points, no markdown lists, no headers.
- Be specific: name the race (track + race number), name the horse (#program + name), the bet type (WIN, PLACE, or SHOW), and the exact dollar amount.
- Briefly say WHY each bet — one phrase per bet (e.g., "biggest mid-edge of the card", "rare positive win edge driven by $2.10 floor", "+8% place edge on the lean tag").
- Do NOT use the words "slam dunk", "slam_dunk", or "SLAM_DUNK" as a generic intensifier. These are classifier labels — reserve them for horses whose signal tag is literally SLAM_DUNK on this race's data. Same rule for "LEAN". For other positive-edge plays, describe the edge directly.
- If there are no good bets right now, say so plainly in one sentence.

CONSTRAINTS
- At most 3 bets total.
- Total wager across all bets must NOT exceed the user's stated budget.
- Each bet must be at least $2 and a whole-dollar amount.
- Strongly prefer slam_dunk signals over leans. Prefer place/show over win unless win edge is unambiguously positive.
- Strongly prefer races within 30 minutes of post (close-to-post pools are most actionable).
- Ignore drifts unless paired with a slam_dunk or lean on the same horse.
- Skip scratched horses.
- Do not recommend any bet on a race with status "closed" or "official" — wagering is closed.
- If the user specifies a single race in their message, recommend only on that race.

Be cold and direct. The user is making real bets with real money based on what you say.`;

export interface RecommendationResult {
  text: string;
  generatedAt: string;
  /** Number of races included in the prompt context. */
  racesConsidered: number;
  /** True when the SDK call ran (vs. a short-circuit because no key / no data). */
  modelCalled: boolean;
  /** Echoed back so the UI can show "Recommendation for $X budget on CD-7". */
  budget: number;
  raceId: string | null;
  error?: string;
}

export interface RecommendationOptions {
  /** If set, the model only sees this race in its context. */
  raceId?: string;
  /** Total wager budget in dollars. Default 10. Minimum 2. */
  budget?: number;
}

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!client) {
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function generateRecommendation(
  races: RaceAnalysis[],
  options: RecommendationOptions = {},
): Promise<RecommendationResult> {
  const generatedAt = new Date().toISOString();
  const budget = Math.max(2, Math.floor(options.budget ?? 10));
  const raceId = options.raceId ?? null;

  const focused = raceId
    ? races.filter((r) => r.race.raceId === raceId)
    : races;
  const openRaces = focused.filter((r) => r.race.status === 'open');

  const c = getClient();
  if (!c) {
    return {
      text: '⚠ AI recommendations unavailable: ANTHROPIC_API_KEY not set in .env. The dashboard’s signal column is still active — green rows are slam dunks.',
      generatedAt,
      racesConsidered: 0,
      modelCalled: false,
      budget,
      raceId,
    };
  }

  if (openRaces.length === 0) {
    return {
      text: raceId
        ? `Race ${raceId} is not open for wagering right now (status check failed or wagering closed).`
        : 'No races are currently open for wagering. Wait for the next race to enter status "open".',
      generatedAt,
      racesConsidered: 0,
      modelCalled: false,
      budget,
      raceId,
    };
  }

  const summary = summarizeRaces(openRaces);
  if (!summary.trim()) {
    return {
      text: 'Open races have no usable signals or pool data yet. The scraper may still be receiving its first WebSocket frames — check back in 30s.',
      generatedAt,
      racesConsidered: 0,
      modelCalled: false,
      budget,
      raceId,
    };
  }

  const focusLine = raceId
    ? `I want to bet ONLY on race ${raceId}. Recommend bets just for that race.`
    : 'Consider every open race below.';
  const userMessage = `${focusLine}\n\nMy total wager budget for this query is $${budget}.\n\nCurrent race state (only OPEN races shown; data is live):\n\n${summary}\n\nWhat bets should I make right now?`;

  try {
    const response = await c.messages.create({
      model: MODEL_ID,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const text = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
    return {
      text: text || '(model returned no text)',
      generatedAt,
      racesConsidered: openRaces.length,
      modelCalled: true,
      budget,
      raceId,
    };
  } catch (err) {
    return {
      text: `⚠ AI recommendation failed: ${err instanceof Error ? err.message : String(err)}. The signal column on the dashboard is still active.`,
      generatedAt,
      racesConsidered: openRaces.length,
      modelCalled: false,
      budget,
      raceId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pure: format the cached races into compact text for the model. Filters
 * to only horses worth talking about (signal != none, OR top-5 by pWin
 * within their race) so we don't waste tokens on long-shots no one's
 * recommending.
 *
 * Exported separately so it can be unit-tested without an Anthropic key.
 */
export function summarizeRaces(races: RaceAnalysis[]): string {
  const parts: string[] = [];

  for (const a of races) {
    const open = a.rows.filter((r) => r.pWin > 0); // skip scratched
    if (open.length === 0) continue;

    // Always include any horse with a signal — and union in the top 5 by pWin
    // so the model knows who the favorites are even if none of them signal.
    const signaled = open.filter((r) => r.signal !== 'none');
    const byPwin = open.slice().sort((x, y) => y.pWin - x.pWin);
    const interestingSet = new Set<string>(signaled.map((r) => r.program));
    for (const row of byPwin.slice(0, 5)) {
      interestingSet.add(row.program);
    }
    const interesting = open.filter((r) => interestingSet.has(r.program));
    if (interesting.length === 0) continue;

    const postTime = a.race.postTimeUtc;
    const mtpHint = mtpDescription(postTime);

    parts.push(
      `--- ${a.race.trackCode} R${a.race.raceNumber} (post ${postTime}${mtpHint}) — ${open.length} live runners ---`,
    );
    parts.push(`prob source: ${a.probSource}`);

    for (const row of interesting) {
      parts.push(formatHorse(row));
    }
    parts.push('');
  }

  return parts.join('\n');
}

function formatHorse(row: HorseAnalysis): string {
  const sig = row.signal === 'none' ? '' : ` [${row.signal.toUpperCase()}]`;
  const cur = row.currentOdds !== null ? row.currentOdds.toFixed(1) : '?';
  const ml = row.mlOdds !== null ? row.mlOdds.toFixed(1) : '?';
  const drift =
    row.mlDrift !== null ? `${(row.mlDrift * 100).toFixed(0)}%` : 'n/a';

  const winFair = row.winFairPayout !== null ? row.winFairPayout.toFixed(2) : '?';
  const winActual = row.winProjected !== null ? row.winProjected.toFixed(2) : '?';
  const winEdge = pct(row.winEdge);

  const placeFair =
    row.harville.placeFairPayout !== null
      ? row.harville.placeFairPayout.toFixed(2)
      : '?';
  const placeMid = row.placeProjected.mid?.toFixed(2) ?? '?';
  const placeFloor = row.placeProjected.floor?.toFixed(2) ?? '?';
  const placeFloorEdge = pct(row.placeEdge.harvilleFloor);
  const placeMidEdge = pct(row.placeEdge.harvilleMid);

  const showFair =
    row.harville.showFairPayout !== null
      ? row.harville.showFairPayout.toFixed(2)
      : '?';
  const showMid = row.showProjected.mid?.toFixed(2) ?? '?';
  const showFloor = row.showProjected.floor?.toFixed(2) ?? '?';
  const showFloorEdge = pct(row.showEdge.harvilleFloor);
  const showMidEdge = pct(row.showEdge.harvilleMid);

  return `#${row.program} ${row.name}: cur ${cur} (ml ${ml}, drift ${drift}), pWin ${row.pWin.toFixed(3)} | win fair ${winFair} actual ${winActual} edge ${winEdge} | place fair ${placeFair} actual ${placeFloor}/${placeMid} edge floor ${placeFloorEdge} mid ${placeMidEdge} | show fair ${showFair} actual ${showFloor}/${showMid} edge floor ${showFloorEdge} mid ${showMidEdge}${sig}`;
}

function pct(v: number | null): string {
  if (v === null) return 'n/a';
  const s = v >= 0 ? '+' : '';
  return `${s}${(v * 100).toFixed(0)}%`;
}

function mtpDescription(postTimeIso: string): string {
  const t = Date.parse(postTimeIso);
  if (!Number.isFinite(t)) return '';
  const seconds = Math.round((t - Date.now()) / 1000);
  if (seconds < 0) return ', past post';
  const m = Math.floor(seconds / 60);
  return `, ${m} min to post`;
}
