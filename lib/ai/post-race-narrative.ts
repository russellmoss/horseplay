import Anthropic from '@anthropic-ai/sdk';
import type { RaceAnalysis } from '../types';
import type { BetSettlement, LockedBetPlan } from '../simulation/types';

/**
 * Generate an analytical, dispassionate post-race narrative explaining why
 * the simulation's bet plan worked or didn't. Generated ONCE when the race
 * goes official and frozen on the locked-rec record.
 *
 * Voice: clean retrospective. NOT the bookmaker bro voice — that's for the
 * live decisions. This is the post-mortem.
 */

const MODEL_ID = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 600;

const SYSTEM_PROMPT = `You are an analytical post-race writer. The user placed a structured bet plan at one minute to post; the race has now been officially called and the plan has been settled. Your job is to write a clean, dispassionate retrospective explaining what happened and why it worked or didn't.

VOICE
- Analytical, not bro. No swearing. No hype. No movie quotes. No "mate" or "dude".
- Plain professional English. Read like a horse-racing newsletter post-mortem, not a chat message.
- Past tense. The race is over.
- No em dashes. Use periods or commas.

STRUCTURE (one paragraph, ~80–140 words)
1. State the outcome briefly (which horses cashed, which didn't, total P&L).
2. Identify the key driver — was it a correct read on a primary horse, a missed scratch effect, a thin pool that paid worse than projected, an exotic that didn't break, etc.
3. One concrete lesson for next time, if a clear one stands out. Avoid "we should have bet differently" 20-20-hindsight platitudes; instead point at specific signal/data tells that would have changed the call.

OUTPUT
Just the paragraph. No headings, no preamble, no "Here's my analysis:".`;

export interface PostRaceNarrativeRequest {
  analysis: RaceAnalysis;
  plan: LockedBetPlan;
  settlement: BetSettlement;
}

export async function generatePostRaceNarrative(
  req: PostRaceNarrativeRequest,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }
  const client = new Anthropic({ apiKey });

  const userMessage = buildUserMessage(req);
  const response = await client.messages.create({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });
  for (const block of response.content) {
    if (block.type === 'text') return block.text.trim();
  }
  throw new Error('post-race-narrative: model returned no text');
}

function buildUserMessage(req: PostRaceNarrativeRequest): string {
  const { analysis, plan, settlement } = req;
  const r = analysis.race;
  const lines: string[] = [];
  lines.push(`Race: ${r.trackCode} R${r.raceNumber}`);
  lines.push(`Status: ${r.status}`);
  if (r.results) {
    const top = r.results.runners
      .slice()
      .sort((a, b) => a.finishPosition - b.finishPosition)
      .slice(0, 4)
      .map(
        (rr) =>
          `${rr.finishPosition}. #${rr.program} ${rr.name} (W $${rr.winPayoff.toFixed(2)} P $${rr.placePayoff.toFixed(2)} S $${rr.showPayoff.toFixed(2)})`,
      )
      .join(', ');
    lines.push(`Official top-4: ${top}`);
    if (r.results.exoticPayoffs && r.results.exoticPayoffs.length > 0) {
      const ex = r.results.exoticPayoffs
        .map((p) => `${p.wagerCode} ${p.selection} = $${p.payoutAmount.toFixed(2)} per $${p.wagerAmount}`)
        .join(', ');
      lines.push(`Exotic payouts: ${ex}`);
    }
  }
  lines.push('');
  lines.push(`Pre-race rationale: ${plan.rationale}`);
  lines.push('');
  lines.push(`Tickets placed (${plan.tickets.length}, total stake $${plan.totalStake}):`);
  for (const t of plan.tickets) {
    lines.push(`  - ${t.type} on #${t.horses.join(',#')}: $${t.amount}${t.reason ? ` (${t.reason})` : ''}`);
  }
  lines.push('');
  lines.push(`Settlement (total return $${settlement.totalReturn.toFixed(2)}, P&L ${settlement.totalProfit >= 0 ? '+' : ''}$${settlement.totalProfit.toFixed(2)}):`);
  for (const t of settlement.tickets) {
    const status = t.cashed
      ? `CASHED $${t.returned.toFixed(2)} (profit ${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)})`
      : `LOST -$${t.amount.toFixed(2)}`;
    lines.push(`  - ${t.type} on #${t.horses.join(',#')}: ${status} — ${t.note ?? ''}`);
  }
  return lines.join('\n');
}
