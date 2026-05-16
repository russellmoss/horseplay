import { NextResponse } from 'next/server';
import { listRaces } from '../../../lib/store';
import { chat, type ChatTurn } from '../../../lib/ai/chat';
import type { PlacedBet } from '../../_components/bets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60; // tool loops can take a few seconds

interface ChatRequestBody {
  messages: ChatTurn[];
  /** Optional: client snapshot of the user's recorded bets (kept in localStorage). */
  bets?: PlacedBet[];
  /** Race the user is currently looking at on the dashboard (drives prompt focus). */
  focusedRaceId?: string | null;
  focusedRaceLabel?: string | null;
  /** True when the user is in voice conversation mode (mic + TTS). */
  conversation?: boolean;
}

export async function POST(req: Request) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.messages)) {
    return NextResponse.json(
      { error: 'messages array required' },
      { status: 400 },
    );
  }
  if (body.messages.length === 0) {
    return NextResponse.json(
      { error: 'messages cannot be empty' },
      { status: 400 },
    );
  }
  if (body.messages.length > 50) {
    return NextResponse.json(
      { error: 'conversation too long; clear chat and start over' },
      { status: 413 },
    );
  }

  const races = listRaces();
  const bets = Array.isArray(body.bets) ? body.bets : [];
  const focusedRaceId =
    typeof body.focusedRaceId === 'string' ? body.focusedRaceId : null;

  const result = await chat({
    messages: body.messages,
    races,
    bets,
    focusedRaceId,
    conversation: body.conversation === true,
  });
  return NextResponse.json(result);
}
