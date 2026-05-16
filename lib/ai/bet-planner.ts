import Anthropic from '@anthropic-ai/sdk';
import type { RaceAnalysis } from '../types';
import type { BetTicket, LockedBetPlan, ModelKey, TicketType } from '../simulation/types';

/**
 * Generate a structured bet plan for a race at T-1:00 — what tickets we'd
 * place with our $20 budget if we were following the AI's read.
 *
 * Uses Claude tool-calling to force a JSON-shaped response so we get a
 * machine-readable plan back instead of having to parse prose. The model
 * gets the same race state the chat sees and is prompted to maximize EV
 * given the dashboard's signals AND the live exotic pool sizes (so it
 * doesn't allocate to thin pools where the math doesn't work).
 *
 * Returns the plan with totals filled in. Validation happens AFTER this:
 * the caller (the lock endpoint) re-verifies pool guardrails server-side
 * and clamps the total to ≤ $20.
 */

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;
const DEFAULT_STAKE_CAP = 20;

const PLAN_TOOL = {
  name: 'submit_bet_plan',
  description:
    'Submit a structured plan of pari-mutuel tickets to place for this race. Total stake across all tickets MUST be ≤ the budget cap stated in the user message. Each ticket must be a whole-dollar amount ≥ $2 (boxed exotics are total ticket cost, NOT per-combination cost). Pool-size guardrail: do NOT allocate to exacta pools < $1,000 or trifecta pools < $3,000.',
  input_schema: {
    type: 'object',
    required: ['rationale', 'tickets'],
    properties: {
      rationale: {
        type: 'string',
        description:
          'One-paragraph (~80–120 words) explanation of why this allocation maximizes expected return. Reference specific edges, drift, scratches, pool sizes. Plain prose, no markdown.',
      },
      tickets: {
        type: 'array',
        description:
          'Array of ticket objects. Empty array is valid if no race is worth playing (you should still spend the $20 if there are ANY positive-edge plays, but not on pure -EV horses).',
        items: {
          type: 'object',
          required: ['type', 'horses', 'amount'],
          properties: {
            type: {
              type: 'string',
              enum: [
                'win',
                'place',
                'show',
                'exacta_straight',
                'exacta_box',
                'trifecta_straight',
                'trifecta_box',
              ],
            },
            horses: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Program numbers (strings, since coupled entries can be like "1A"). For win/place/show: 1 horse. exacta_straight: [first, second]. exacta_box: 2+ horses. trifecta_straight: [first, second, third]. trifecta_box: 3+ horses.',
            },
            amount: {
              type: 'integer',
              description:
                'TOTAL ticket cost in whole dollars. For boxes this is the box-total, NOT per-combination. Each ticket must be ≥ $2.',
              minimum: 2,
            },
            reason: {
              type: 'string',
              description: 'One short sentence on why this specific ticket.',
            },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a sharp pari-mutuel handicapper allocating a fixed budget across structured tickets at 1 minute to post. The exact dollar cap is given in the user message. Your job: maximize expected return given the dashboard data and live pool sizes.

OUTPUT
Use the submit_bet_plan tool. Do NOT respond in plain text. Every response MUST be a tool call.

ALLOCATION RULES
- TOTAL across all tickets must be ≤ the budget cap stated in the user message (whole dollars).
- Each ticket ≥ $2.
- Empty plan is valid only if every horse in the race has clearly negative EV (rare; usually some edge exists somewhere).
- Spend MORE on stronger signals (slam_dunk > lean), LESS on speculative plays.
- Diversify when the race has multiple plausible outcomes; concentrate when one horse stands out.

POOL-SIZE GUARDRAILS (HARD)
- DO NOT recommend exacta tickets if the exacta pool is < $1,000 — pool too thin to pay fairly.
- DO NOT recommend trifecta tickets if the trifecta pool is < $3,000.
- Default to WPS-only allocation on starved-pool tracks.

EXOTIC TICKET COST RULES (be precise)
- Exacta straight: 1 combination. Cost = ticket amount.
- Exacta box of 2 horses: 2 combinations. If you spend $4 on a box, you're effectively at $2 per combo.
- Exacta box of 3 horses: 6 combinations. $6 box = $1/combo (often below track minimum — prefer $12 = $2/combo).
- Trifecta straight: 1 combo.
- Trifecta box of 3: 6 combos.
- Trifecta box of 4: 24 combos.
- For boxes, account for the cost-multiplier when sizing — e.g. a $20 box of 4 trifecta horses is only ~$0.83/combo, often below track minimum.

REASONING RULES
- Reference SPECIFIC numbers: edges, pool dollars, drift percentages. "place edge mid +6.0% on #5, pool $158K" beats "looks pretty good on #5".
- Never recommend a scratched horse.
- Never recommend a closed/official race (the system shouldn't ask, but verify).
- The "reason" on each ticket is one short sentence. The "rationale" overall is one paragraph.
- Keep the writing analytical, not bro-voice. This is the structured plan, not the chat.

CLASSIFIER-TERM HYGIENE (HARD)
- The strings "SLAM_DUNK", "slam_dunk", and "slam dunk" are CLASSIFIER LABELS, not adjectives. You may use them ONLY when describing a horse whose per-horse signal tag in the input table is literally "SLAM_DUNK". You may NOT invent the term to describe a horse with strong edges but a different signal (LEAN, DRIFT, or NONE), nor as a generic intensifier ("this is a slam dunk play"). For non-SLAM_DUNK horses with positive edges, describe the edge directly (e.g. "place mid edge +8%") without the classifier label. Same rule for "LEAN" — only use it when the input row's signal is literally "LEAN". This keeps downstream prose-based diagnostics able to distinguish classifier output from AI rationalization.`;

export interface BetPlanRequest {
  analysis: RaceAnalysis;
  /** Total wager budget cap in whole dollars. Default 20. Min 2. */
  budget?: number;
  /**
   * Which finishing-order model the AI should reason over (Harville fair
   * prices/edges vs Henery fair prices/edges). Default 'harville' to keep
   * existing callers unchanged. The lock endpoint runs both in parallel
   * for model-comparison evaluation.
   */
  model?: ModelKey;
}

export interface BetPlanResult {
  rationale: string;
  tickets: BetTicket[];
  /** Recomputed total to confirm sum. */
  totalStake: number;
  /** Which model the AI was reasoning over. Echoed for storage. */
  model: ModelKey;
}

export async function generateBetPlan(req: BetPlanRequest): Promise<BetPlanResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const client = new Anthropic({ apiKey });
  const budget = Math.max(2, Math.floor(req.budget ?? DEFAULT_STAKE_CAP));
  const model: ModelKey = req.model ?? 'harville';
  const userMessage = buildUserMessage(req.analysis, budget, model);

  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [PLAN_TOOL] as unknown as Anthropic.Tool[],
    tool_choice: { type: 'tool', name: 'submit_bet_plan' },
    messages: [{ role: 'user', content: userMessage }],
  });

  // The model is forced to call submit_bet_plan; pull the input out.
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('bet-planner: model did not return a tool_use block');
  }
  const input = toolUse.input as {
    rationale?: string;
    tickets?: Array<{
      type?: string;
      horses?: unknown[];
      amount?: number;
      reason?: string;
    }>;
  };

  const tickets: BetTicket[] = (input.tickets ?? []).flatMap((t) => {
    if (!t || typeof t.type !== 'string') return [];
    if (!isTicketType(t.type)) return [];
    if (!Array.isArray(t.horses) || t.horses.length === 0) return [];
    if (typeof t.amount !== 'number' || t.amount < 2 || !Number.isFinite(t.amount)) return [];
    const horses = t.horses
      .map((h) => (typeof h === 'string' ? h.trim() : String(h)))
      .filter((h) => h.length > 0);
    if (horses.length === 0) return [];
    if (!horseCountValidForType(t.type, horses.length)) return [];
    return [
      {
        type: t.type,
        horses,
        amount: Math.floor(t.amount),
        reason: typeof t.reason === 'string' ? t.reason : undefined,
      },
    ];
  });

  const totalStake = tickets.reduce((a, b) => a + b.amount, 0);
  return {
    rationale: typeof input.rationale === 'string' ? input.rationale : '',
    tickets,
    totalStake,
    model,
  };
}

function isTicketType(s: string): s is TicketType {
  return [
    'win',
    'place',
    'show',
    'exacta_straight',
    'exacta_box',
    'trifecta_straight',
    'trifecta_box',
  ].includes(s);
}

function horseCountValidForType(type: string, n: number): boolean {
  switch (type) {
    case 'win':
    case 'place':
    case 'show':
      return n === 1;
    case 'exacta_straight':
      return n === 2;
    case 'exacta_box':
      return n >= 2;
    case 'trifecta_straight':
      return n === 3;
    case 'trifecta_box':
      return n >= 3;
    default:
      return false;
  }
}

function buildUserMessage(
  analysis: RaceAnalysis,
  budget: number,
  model: ModelKey,
): string {
  const r = analysis.race;
  const lines: string[] = [];
  lines.push(`Race: ${r.trackCode} R${r.raceNumber} (status ${r.status})`);
  lines.push(`Post: ${r.postTimeUtc}`);
  lines.push(`Budget cap: $${budget}. Total stake across all tickets MUST NOT exceed this.`);
  // Tell the AI which finishing-order model produced the fair prices below.
  // Stays opaque enough that the AI doesn't bias toward "trust this model
  // more" — it's just a label, the numbers are what matter.
  lines.push(
    `Finishing-order model: ${model.toUpperCase()} (fair prices and edges below derive from this model — treat them as your source of truth).`,
  );
  lines.push('');

  // Pools
  const wpsPools: string[] = [];
  if (r.totalWinPool) wpsPools.push(`win $${r.totalWinPool.toLocaleString()}`);
  if (r.totalPlacePool) wpsPools.push(`place $${r.totalPlacePool.toLocaleString()}`);
  if (r.totalShowPool) wpsPools.push(`show $${r.totalShowPool.toLocaleString()}`);
  if (wpsPools.length > 0) lines.push(`WPS pools: ${wpsPools.join(', ')}`);

  const exoticPools: string[] = [];
  if (r.totalExactaPool) exoticPools.push(`exacta $${r.totalExactaPool.toLocaleString()}`);
  if (r.totalTrifectaPool) exoticPools.push(`trifecta $${r.totalTrifectaPool.toLocaleString()}`);
  if (r.totalSuperfectaPool) exoticPools.push(`super $${r.totalSuperfectaPool.toLocaleString()}`);
  if (exoticPools.length > 0) {
    lines.push(`Exotic pools: ${exoticPools.join(', ')}`);
  } else {
    lines.push('Exotic pools: none reported (treat exotics as off-limits).');
  }
  lines.push('');

  // Scratched
  const scratched = r.horses.filter((h) => h.scratched);
  if (scratched.length > 0) {
    lines.push(
      `Scratched (do NOT include): ${scratched.map((h) => `#${h.program} ${h.name}`).join(', ')}`,
    );
    lines.push('');
  }

  // Per-horse signal table
  lines.push('Per-horse signals (active runners only):');
  const active = analysis.rows.filter((row) => row.pWin > 0);
  const sorted = active.slice().sort((a, b) => b.pWin - a.pWin);
  // Model-keyed accessors. EdgeBundle stores `harvilleX` and `heneryX`
  // separately — pick the pair that matches the selected model.
  const placeMidKey = model === 'henery' ? 'heneryMid' : 'harvilleMid';
  const placeFloorKey = model === 'henery' ? 'heneryFloor' : 'harvilleFloor';
  const showMidKey = placeMidKey;
  const showFloorKey = placeFloorKey;

  for (const row of sorted) {
    const parts: string[] = [];
    parts.push(`#${row.program} ${row.name}`);
    parts.push(`pWin ${row.pWin.toFixed(3)}`);
    const modelOut = row[model];
    if (modelOut.placeFairPayout !== null) {
      parts.push(`PFair $${modelOut.placeFairPayout.toFixed(2)}`);
    }
    if (row.placeProjected.mid !== null) {
      parts.push(`PProj ${row.placeProjected.mid.toFixed(2)}`);
    }
    if (row.placeEdge[placeMidKey] !== null) {
      parts.push(`PMid ${(row.placeEdge[placeMidKey] as number * 100).toFixed(0)}%`);
    }
    if (row.placeEdge[placeFloorKey] !== null) {
      parts.push(`PFloor ${(row.placeEdge[placeFloorKey] as number * 100).toFixed(0)}%`);
    }
    if (modelOut.showFairPayout !== null) {
      parts.push(`SFair $${modelOut.showFairPayout.toFixed(2)}`);
    }
    if (row.showProjected.mid !== null) {
      parts.push(`SProj ${row.showProjected.mid.toFixed(2)}`);
    }
    if (row.showEdge[showMidKey] !== null) {
      parts.push(`SMid ${(row.showEdge[showMidKey] as number * 100).toFixed(0)}%`);
    }
    if (row.showEdge[showFloorKey] !== null) {
      parts.push(`SFloor ${(row.showEdge[showFloorKey] as number * 100).toFixed(0)}%`);
    }
    if (row.signal !== 'none') {
      parts.push(`[${row.signal.toUpperCase()}]`);
    }
    if (row.mlDrift !== null && Math.abs(row.mlDrift) > 0.2) {
      parts.push(`drift ${row.mlDrift > 0 ? '+' : ''}${(row.mlDrift * 100).toFixed(0)}%`);
    }
    lines.push(`  ${parts.join(' | ')}`);
  }

  return lines.join('\n');
}
