'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PlacedBet } from './bets';
import { prepareTextForTts } from '../../lib/ai/speech';

/**
 * Chat-with-the-bookmaker. Floating button bottom-right; opens a right-side
 * drawer with the conversation. Persists messages in localStorage so they
 * survive page reloads (until "clear chat" is hit).
 */

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string | unknown[]; // string for user simple turns; assistant returns content blocks
}

interface ChatResponse {
  messages: ChatTurn[];
  assistantText: string;
  toolCalls: Array<{ name: string; input: unknown; resultPreview: string }>;
  truncated: boolean;
}

const STORAGE_KEY = 'horseplay.chat.v1';

interface DisplayMessage {
  role: 'user' | 'assistant';
  text: string;
  toolCalls?: Array<{ name: string; input: unknown }>;
}

// Shared TTS prep (markdown stripping + speech normalization for "#5" → "number 5",
// "9/2" → "9 to 2", etc.) lives in lib/ai/speech.ts so the chat, voice picks,
// and /api/tts all stay consistent.
const stripMarkdownForSpeech = prepareTextForTts;

function flattenForDisplay(turn: ChatTurn): DisplayMessage | null {
  if (turn.role === 'user' && typeof turn.content === 'string') {
    return { role: 'user', text: turn.content };
  }
  if (turn.role === 'assistant' && Array.isArray(turn.content)) {
    const textParts: string[] = [];
    const toolCalls: Array<{ name: string; input: unknown }> = [];
    for (const block of turn.content as unknown[]) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: string; text?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text);
      } else if (b.type === 'tool_use' && b.name) {
        toolCalls.push({ name: b.name, input: b.input });
      }
    }
    if (textParts.length === 0 && toolCalls.length === 0) return null;
    return {
      role: 'assistant',
      text: textParts.join('\n').trim(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
  if (turn.role === 'assistant' && typeof turn.content === 'string') {
    return { role: 'assistant', text: turn.content };
  }
  // user turns with tool_results — hide from display
  return null;
}

interface ChatProps {
  bets: PlacedBet[];
  /** The race the user is currently viewing, so the bookmaker can focus on it. */
  focusedRaceId: string | null;
  focusedRaceLabel: string | null;
}

/** Markdown renderers tuned for the bookmaker's tipsheet voice. Heavy use of
 *  amber accents to evoke a racing program; tight spacing so it never feels
 *  like a wall of prose. */
const MD_COMPONENTS = {
  h1: (props: { children?: React.ReactNode }) => (
    <h1 className="mb-2 mt-3 border-b border-amber-800/40 pb-1 text-lg font-extrabold tracking-tight text-amber-200">
      {props.children}
    </h1>
  ),
  h2: (props: { children?: React.ReactNode }) => (
    <h2 className="mb-1.5 mt-3 text-base font-bold text-amber-200">
      {props.children}
    </h2>
  ),
  h3: (props: { children?: React.ReactNode }) => (
    <h3 className="mb-1 mt-2 text-sm font-bold uppercase tracking-wide text-amber-300/90">
      {props.children}
    </h3>
  ),
  p: (props: { children?: React.ReactNode }) => (
    <p className="my-1.5 leading-relaxed text-zinc-100">{props.children}</p>
  ),
  strong: (props: { children?: React.ReactNode }) => (
    <strong className="font-bold text-amber-100">{props.children}</strong>
  ),
  em: (props: { children?: React.ReactNode }) => (
    <em className="italic text-zinc-200">{props.children}</em>
  ),
  ul: (props: { children?: React.ReactNode }) => (
    <ul className="my-1.5 ml-4 list-disc space-y-0.5 text-zinc-200 marker:text-amber-500">
      {props.children}
    </ul>
  ),
  ol: (props: { children?: React.ReactNode }) => (
    <ol className="my-1.5 ml-5 list-decimal space-y-0.5 text-zinc-200 marker:text-amber-500">
      {props.children}
    </ol>
  ),
  li: (props: { children?: React.ReactNode }) => (
    <li className="leading-snug">{props.children}</li>
  ),
  blockquote: (props: { children?: React.ReactNode }) => (
    <blockquote className="my-2 rounded-r-md border-l-4 border-amber-600 bg-amber-950/30 px-3 py-1.5 italic text-amber-100">
      {props.children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-zinc-800" />,
  a: (props: { href?: string; children?: React.ReactNode }) => (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-amber-300 underline decoration-amber-700/60 underline-offset-2 hover:text-amber-200 hover:decoration-amber-400"
    >
      {props.children}
    </a>
  ),
  code: (props: { inline?: boolean; children?: React.ReactNode }) =>
    props.inline ? (
      <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-xs text-amber-200">
        {props.children}
      </code>
    ) : (
      <code className="block overflow-x-auto rounded bg-zinc-900 p-2 font-mono text-xs text-zinc-100">
        {props.children}
      </code>
    ),
  table: (props: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-zinc-800">
      <table className="w-full border-collapse text-xs">{props.children}</table>
    </div>
  ),
  thead: (props: { children?: React.ReactNode }) => (
    <thead className="bg-amber-950/40 text-amber-200">{props.children}</thead>
  ),
  th: (props: { children?: React.ReactNode }) => (
    <th className="border-b border-amber-900/40 px-2 py-1 text-left font-bold">
      {props.children}
    </th>
  ),
  tr: (props: { children?: React.ReactNode }) => (
    <tr className="border-b border-zinc-800 last:border-b-0 hover:bg-zinc-900/40">
      {props.children}
    </tr>
  ),
  td: (props: { children?: React.ReactNode }) => (
    <td className="px-2 py-1 align-top text-zinc-200">{props.children}</td>
  ),
  img: (props: { src?: string; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={props.src}
      alt={props.alt ?? ''}
      className="my-2 max-h-72 w-full rounded-lg border border-zinc-800 object-cover shadow-lg"
      onError={(e) => {
        // Hide broken images instead of showing the broken-image icon.
        (e.currentTarget as HTMLImageElement).style.display = 'none';
      }}
    />
  ),
} as const;

type ConvState = 'idle' | 'listening' | 'thinking' | 'speaking';

export function Chat({ bets, focusedRaceId, focusedRaceLabel }: ChatProps) {
  const [open, setOpen] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  /** Auto-play assistant replies via ElevenLabs TTS. */
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(false);
  /** Conversation mode: mic on, back-and-forth voice loop. */
  const [conversationMode, setConversationMode] = useState<boolean>(false);
  const [convState, setConvState] = useState<ConvState>('idle');
  /** Live interim transcript from the mic, for visual feedback while listening. */
  const [interimText, setInterimText] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** The audio element currently playing a TTS reply. */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** SpeechRecognition instance when in conversation mode. */
  const recognitionRef = useRef<unknown>(null);
  /** Mirror of conversationMode for use inside async callbacks. */
  const conversationModeRef = useRef<boolean>(false);
  /** Mirror of voiceEnabled for use inside async callbacks. */
  const voiceEnabledRef = useRef<boolean>(false);
  /**
   * Index of the last assistant turn we auto-played. We only TTS NEW replies,
   * not pre-existing chat history when the user toggles voice on mid-session.
   */
  const lastPlayedTurnIdxRef = useRef<number>(-1);

  useEffect(() => {
    conversationModeRef.current = conversationMode;
  }, [conversationMode]);
  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  // Load on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setTurns(JSON.parse(raw) as ChatTurn[]);
    } catch {
      // ignore
    }
  }, []);

  // Persist
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(turns));
    } catch {
      // ignore quota
    }
  }, [turns]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [turns, sending]);

  // ── Voice helpers ──────────────────────────────────────────────────

  const stopAudio = useCallback((): void => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.src = '';
      } catch {
        // ignore
      }
      audioRef.current = null;
    }
  }, []);

  /** Speak text via ElevenLabs. Resolves when audio finishes (or fails). */
  const playTts = useCallback(
    async (text: string): Promise<void> => {
      stopAudio();
      try {
        setConvState('speaking');
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          console.warn(`tts: HTTP ${res.status}`);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        await new Promise<void>((resolve) => {
          const audio = new Audio(url);
          audioRef.current = audio;
          const cleanup = (): void => {
            URL.revokeObjectURL(url);
            if (audioRef.current === audio) audioRef.current = null;
            resolve();
          };
          audio.onended = cleanup;
          audio.onerror = cleanup;
          audio.play().catch((err) => {
            console.warn('tts: audio.play() failed', err);
            cleanup();
          });
        });
      } catch (err) {
        console.warn('tts failed:', err);
      } finally {
        setConvState((prev) => (prev === 'speaking' ? 'idle' : prev));
      }
    },
    [stopAudio],
  );

  /** Stop the mic and dispose the recognition instance. */
  const stopListening = useCallback((): void => {
    const rec = recognitionRef.current as
      | { abort?: () => void; stop?: () => void; onresult?: unknown; onend?: unknown; onerror?: unknown }
      | null;
    if (rec) {
      try {
        rec.onresult = null;
        rec.onend = null;
        rec.onerror = null;
        rec.abort?.();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
  }, []);

  /**
   * Send a message to the chat backend. Used by both text submit AND voice
   * conversation flow. Plays the reply aloud if voice is enabled, and if
   * conversation mode is on, restarts listening after the audio finishes.
   */
  const sendMessage = useCallback(
    async (
      text: string,
      opts: { isVoice?: boolean } = {},
    ): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      stopAudio();
      const userTurn: ChatTurn = { role: 'user', content: trimmed };
      const next: ChatTurn[] = [...turns, userTurn];
      setTurns(next);
      setSending(true);
      setError(null);
      if (opts.isVoice) setConvState('thinking');
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: next,
            bets,
            focusedRaceId,
            focusedRaceLabel,
            conversation: opts.isVoice === true,
          }),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }
        const data = (await res.json()) as ChatResponse;
        setTurns(data.messages);
        // Mark this assistant turn as already-handled for voice — we'll play
        // it directly here (so the auto-play effect doesn't double-fire).
        lastPlayedTurnIdxRef.current = data.messages.length - 1;
        const assistantText = data.assistantText.trim();
        const shouldSpeak =
          (voiceEnabledRef.current || opts.isVoice === true) &&
          assistantText.length > 0;
        if (shouldSpeak) {
          await playTts(stripMarkdownForSpeech(assistantText));
        }
        // After the bookmaker finishes speaking, if we're still in conversation
        // mode, kick off the next listening turn.
        if (conversationModeRef.current) {
          // Defer so any state updates settle.
          setTimeout(() => {
            if (conversationModeRef.current) startListening();
          }, 250);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
        setConvState((prev) => (prev === 'thinking' ? 'idle' : prev));
      }
    },
    // Note: startListening is declared below; avoid a cyclical dep by reading
    // it via the ref-driven loop. ESLint will warn on missing dep — intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [turns, sending, bets, focusedRaceId, focusedRaceLabel, playTts, stopAudio],
  );

  /** Start the mic. Browser STT (Chrome/Edge); Firefox unsupported. */
  const startListening = useCallback((): void => {
    if (typeof window === 'undefined') return;
    const SR =
      (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    if (!SR) {
      setError(
        'Voice conversation requires Chrome or Edge — your browser does not support speech recognition.',
      );
      setConversationMode(false);
      return;
    }
    stopListening();
    setInterimText('');
    setConvState('listening');
    try {
      const Ctor = SR as new () => unknown;
      const rec = new Ctor() as {
        continuous: boolean;
        interimResults: boolean;
        lang: string;
        onresult: ((e: unknown) => void) | null;
        onend: (() => void) | null;
        onerror: ((e: unknown) => void) | null;
        start: () => void;
        abort: () => void;
        stop: () => void;
      };
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = 'en-US';
      let finalTranscript = '';
      rec.onresult = (event: unknown) => {
        const e = event as {
          results: ArrayLike<{
            isFinal: boolean;
            0: { transcript: string };
          }> & { length: number };
        };
        let interim = '';
        for (let i = 0; i < e.results.length; i++) {
          const result = e.results[i];
          const transcript = result[0].transcript;
          if (result.isFinal) {
            finalTranscript += transcript;
          } else {
            interim += transcript;
          }
        }
        setInterimText(interim || finalTranscript);
      };
      rec.onerror = (event: unknown) => {
        const e = event as { error?: string };
        if (e.error === 'no-speech' || e.error === 'aborted') {
          // Common, not user-facing errors.
          return;
        }
        console.warn('SpeechRecognition error:', e.error);
        setError(`Mic error: ${e.error ?? 'unknown'}`);
      };
      rec.onend = () => {
        recognitionRef.current = null;
        setConvState((prev) => (prev === 'listening' ? 'idle' : prev));
        const text = finalTranscript.trim();
        setInterimText('');
        if (text.length > 0 && conversationModeRef.current) {
          void sendMessage(text, { isVoice: true });
        } else if (
          conversationModeRef.current &&
          convStateRef.current !== 'speaking' &&
          convStateRef.current !== 'thinking'
        ) {
          // Empty result while still in convo mode — restart listening.
          setTimeout(() => {
            if (conversationModeRef.current) startListening();
          }, 200);
        }
      };
      recognitionRef.current = rec;
      rec.start();
    } catch (err) {
      console.warn('startListening failed:', err);
      setError(err instanceof Error ? err.message : String(err));
      setConvState('idle');
    }
  }, [sendMessage, stopListening]);

  const convStateRef = useRef<ConvState>('idle');
  useEffect(() => {
    convStateRef.current = convState;
  }, [convState]);

  /** Toggle conversation mode on/off. */
  const toggleConversation = useCallback((): void => {
    setConversationMode((prev) => {
      const next = !prev;
      if (next) {
        // Entering conversation mode — also enable voice playback so replies are spoken.
        setVoiceEnabled(true);
        setTimeout(() => {
          conversationModeRef.current = true;
          startListening();
        }, 0);
      } else {
        conversationModeRef.current = false;
        stopListening();
        stopAudio();
        setConvState('idle');
        setInterimText('');
      }
      return next;
    });
  }, [startListening, stopListening, stopAudio]);

  // Auto-play newly-arrived assistant replies (when voice is on but we're
  // NOT in conversation mode; conversation flow handles its own playback).
  useEffect(() => {
    if (!voiceEnabled) return;
    if (conversationMode) return;
    if (turns.length === 0) return;
    const lastIdx = turns.length - 1;
    if (lastIdx <= lastPlayedTurnIdxRef.current) return;
    const last = turns[lastIdx];
    if (last.role !== 'assistant') return;
    const flat = flattenForDisplay(last);
    if (!flat || !flat.text) return;
    lastPlayedTurnIdxRef.current = lastIdx;
    void playTts(stripMarkdownForSpeech(flat.text));
  }, [turns, voiceEnabled, conversationMode, playTts]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListening();
      stopAudio();
    };
  }, [stopListening, stopAudio]);

  // External "open the bookmaker and ask this" event. The bet panel's Explain
  // button dispatches this when the user wants the AI to walk through its
  // structured plan. Detail: { prompt: string }.
  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ prompt?: string } | undefined>;
      setOpen(true);
      const prompt = ce.detail?.prompt?.trim();
      if (prompt) {
        // Defer so the drawer is mounted before we send.
        setTimeout(() => {
          void sendMessage(prompt);
        }, 50);
      }
    };
    window.addEventListener('horseplay:open-bookmaker', handler as EventListener);
    return () => {
      window.removeEventListener('horseplay:open-bookmaker', handler as EventListener);
    };
  }, [sendMessage]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    await sendMessage(text);
  }, [input, sending, sendMessage]);

  const clearChat = (): void => {
    setTurns([]);
    setError(null);
  };

  const display = turns.map(flattenForDisplay).filter((m): m is DisplayMessage => m !== null);

  return (
    <>
      {/* Floating launcher button */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full border border-amber-700 bg-amber-900 px-4 py-2 text-sm font-bold text-amber-100 shadow-2xl hover:bg-amber-800"
      >
        🎩 {open ? 'Close bookmaker' : 'Chat with the bookmaker'}
      </button>

      {/* Backdrop (only when expanded — gives a click target to collapse) */}
      {open && expanded && (
        <button
          type="button"
          aria-label="Collapse chat"
          onClick={() => setExpanded(false)}
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
        />
      )}

      {/* Drawer */}
      {open && (
        <div
          className={
            expanded
              ? 'fixed inset-4 md:inset-10 lg:inset-16 z-50 flex flex-col rounded-2xl border border-amber-900/60 bg-zinc-950 shadow-[0_30px_80px_rgba(0,0,0,0.6)]'
              : 'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl'
          }
        >
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <div>
              <div className="text-sm font-bold text-zinc-100">🎩 The Bookmaker</div>
              <div className="text-[10px] text-zinc-500">
                claude sonnet 4.6 + tavily web search · sees your dashboard data
                {focusedRaceLabel && (
                  <>
                    {' · focused on '}
                    <span className="font-mono text-amber-300">{focusedRaceLabel}</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setVoiceEnabled((v) => {
                    const next = !v;
                    if (!next) stopAudio();
                    return next;
                  });
                }}
                className={`rounded px-2 py-0.5 text-xs font-bold ${
                  voiceEnabled
                    ? 'bg-amber-700 text-amber-50 hover:bg-amber-600'
                    : 'text-zinc-400 hover:text-amber-300'
                }`}
                title={
                  voiceEnabled
                    ? 'Voice replies on — click to mute'
                    : 'Click to read replies aloud'
                }
              >
                {voiceEnabled ? '🔊 Voice' : '🔇 Voice'}
              </button>
              <button
                type="button"
                onClick={toggleConversation}
                className={`rounded px-2 py-0.5 text-xs font-bold ${
                  conversationMode
                    ? 'animate-pulse bg-red-700 text-white hover:bg-red-600'
                    : 'text-zinc-400 hover:text-amber-300'
                }`}
                title={
                  conversationMode
                    ? 'In conversation — click to hang up'
                    : 'Talk to the bookmaker (mic + voice loop)'
                }
              >
                {conversationMode ? '🎙️ Live' : '🎙️ Talk'}
              </button>
              <button
                type="button"
                onClick={clearChat}
                className="text-xs text-zinc-400 hover:text-red-400"
              >
                clear
              </button>
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="text-zinc-400 hover:text-amber-300"
                aria-label={expanded ? 'Collapse to drawer' : 'Expand to full screen'}
                title={expanded ? 'Collapse' : 'Expand'}
              >
                {expanded ? '⤡' : '⤢'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (conversationMode) toggleConversation();
                  setOpen(false);
                }}
                className="text-zinc-400 hover:text-zinc-100"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>

          {conversationMode && (
            <div
              className={`flex items-center gap-3 border-b px-4 py-2 text-xs ${
                convState === 'listening'
                  ? 'border-green-700 bg-green-950/50 text-green-200'
                  : convState === 'thinking'
                    ? 'border-zinc-700 bg-zinc-900 text-zinc-300'
                    : convState === 'speaking'
                      ? 'border-amber-700 bg-amber-950/50 text-amber-200'
                      : 'border-zinc-800 bg-zinc-900/40 text-zinc-400'
              }`}
            >
              <span className="text-lg">
                {convState === 'listening'
                  ? '🎙️'
                  : convState === 'thinking'
                    ? '⏳'
                    : convState === 'speaking'
                      ? '🔊'
                      : '⏸️'}
              </span>
              <div className="flex-1">
                <div className="font-bold uppercase tracking-wide">
                  {convState === 'listening'
                    ? 'Listening… speak now'
                    : convState === 'thinking'
                      ? 'Thinking…'
                      : convState === 'speaking'
                        ? 'Bookmaker speaking…'
                        : 'Idle'}
                </div>
                {interimText && convState === 'listening' && (
                  <div className="mt-0.5 italic text-green-100/90">
                    "{interimText}"
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={toggleConversation}
                className="rounded border border-red-700 bg-red-900/60 px-2 py-0.5 font-bold text-red-100 hover:bg-red-800"
              >
                Hang up
              </button>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {display.length === 0 && (
              <div className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-sm text-zinc-400">
                <div className="mb-1 font-bold text-zinc-300">Try asking:</div>
                <ul className="space-y-1 text-xs">
                  <li>· "What should I bet on the next race?"</li>
                  <li>· "Tell me about the favorite in CD R10"</li>
                  <li>· "Any scratches or jockey changes I should know about?"</li>
                  <li>· "Weather at Churchill today?"</li>
                  <li>· "Why is Knightsbridge's edge negative?"</li>
                </ul>
              </div>
            )}
            {display.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
                    expanded ? 'max-w-[92%]' : 'max-w-[85%]'
                  } ${
                    m.role === 'user'
                      ? 'bg-amber-900/60 text-amber-50'
                      : 'bg-zinc-900 text-zinc-100 ring-1 ring-zinc-800/80'
                  }`}
                >
                  {m.toolCalls && m.toolCalls.length > 0 && (
                    <div className="mb-1.5 space-y-0.5">
                      {m.toolCalls.map((t, j) => (
                        <div
                          key={j}
                          className="text-[10px] font-mono text-zinc-500"
                        >
                          🔍{' '}
                          {t.name === 'tavily_search'
                            ? `searched: "${(t.input as { query?: string }).query ?? ''}"`
                            : `tool: ${t.name}`}
                        </div>
                      ))}
                    </div>
                  )}
                  {m.text &&
                    (m.role === 'assistant' ? (
                      <div className="bookmaker-prose">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                          {m.text}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap">{m.text}</div>
                    ))}
                  {m.role === 'assistant' && m.text && (
                    <button
                      type="button"
                      onClick={() => {
                        void playTts(stripMarkdownForSpeech(m.text));
                      }}
                      className="mt-1.5 text-[10px] text-zinc-500 hover:text-amber-300"
                      title="Read this reply aloud"
                    >
                      🔊 Replay
                    </button>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-zinc-400">
                  <span className="inline-block animate-pulse">…</span> thinking
                </div>
              </div>
            )}
            {error && (
              <div className="rounded border border-red-800 bg-red-950 px-3 py-2 text-xs text-red-200">
                {error}
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="border-t border-zinc-800 px-3 py-2"
          >
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder="Ask the bookmaker… (Enter to send · Shift+Enter newline)"
                disabled={sending}
                className="flex-1 resize-none rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="rounded bg-amber-700 px-3 py-1.5 text-sm font-bold text-amber-50 hover:bg-amber-600 disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
