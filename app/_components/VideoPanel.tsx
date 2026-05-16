'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Floating video panel. Pastes a FanDuel `racing.fanduel.com/video.html?...`
 * URL into the input, embeds it as an iframe with autoplay + fullscreen
 * allowed. The URL persists in localStorage so the panel re-loads to the same
 * stream on next session.
 *
 * Whether FanDuel's video.html page actually allows being iframed depends on
 * their X-Frame-Options / CSP frame-ancestors header. The `player=iframe`
 * query param in the example URL strongly suggests it's designed for embed.
 * If embedding fails we surface a hint and link to open the URL in a new tab.
 */

const STORAGE_URL_KEY = 'horseplay.video.url.v1';
const STORAGE_OPEN_KEY = 'horseplay.video.open.v1';

interface VideoPanelProps {
  /** Whether the panel is visible. The toggle is owned by the parent. */
  open: boolean;
  onClose: () => void;
}

export function VideoPanel({ open, onClose }: VideoPanelProps): JSX.Element | null {
  const [url, setUrl] = useState<string>('');
  const [draftUrl, setDraftUrl] = useState<string>('');
  const [editingUrl, setEditingUrl] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(STORAGE_URL_KEY);
      if (stored) {
        setUrl(stored);
        setDraftUrl(stored);
      } else {
        setEditingUrl(true);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (url) window.localStorage.setItem(STORAGE_URL_KEY, url);
    } catch {
      // ignore
    }
  }, [url]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_OPEN_KEY, open ? '1' : '0');
    } catch {
      // ignore
    }
  }, [open]);

  const applyUrl = (): void => {
    const v = draftUrl.trim();
    if (v.length === 0) return;
    setUrl(v);
    setEditingUrl(false);
  };

  const goFullscreen = (): void => {
    const el = containerRef.current;
    if (!el) return;
    const doc = document as Document & {
      webkitExitFullscreen?: () => void;
      webkitFullscreenElement?: Element;
    };
    const reqFs =
      el.requestFullscreen ||
      (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> })
        .webkitRequestFullscreen;
    if (!reqFs) return;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      void (
        document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.()
      );
    } else {
      void reqFs.call(el);
    }
  };

  /**
   * Open the stream in a separate browser window (popup). This is the reliable
   * path when FanDuel's "Please login" check fails inside the iframe — the
   * popup is a top-level navigation to fanduel.com so it sees the user's real
   * session cookies. Sized for a typical race-stream window.
   */
  const openInPopup = (): void => {
    if (!url) return;
    const features = [
      'width=720',
      'height=480',
      'menubar=no',
      'toolbar=no',
      'location=no',
      'status=no',
      'resizable=yes',
      'scrollbars=no',
    ].join(',');
    window.open(url, 'horseplay-stream', features);
  };

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      className="fixed bottom-20 left-4 z-30 flex w-[480px] flex-col rounded-lg border border-amber-900/60 bg-zinc-950 shadow-2xl"
      style={{ resize: 'both', overflow: 'hidden', minWidth: 320, minHeight: 240 }}
    >
      {/* Header: URL input + controls */}
      <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/80 px-2 py-1.5 text-xs">
        <span className="text-amber-300">📺</span>
        {editingUrl ? (
          <>
            <input
              type="text"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyUrl();
                }
              }}
              placeholder="Paste FanDuel video URL (https://racing.fanduel.com/video.html?…)"
              autoFocus
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-100 placeholder:text-zinc-600"
            />
            <button
              type="button"
              onClick={applyUrl}
              disabled={draftUrl.trim().length === 0}
              className="rounded border border-amber-700 bg-amber-900 px-2 py-0.5 font-bold text-amber-100 hover:bg-amber-800 disabled:opacity-40"
            >
              Load
            </button>
            {url && (
              <button
                type="button"
                onClick={() => {
                  setDraftUrl(url);
                  setEditingUrl(false);
                }}
                className="text-zinc-400 hover:text-zinc-100"
                title="Cancel edit"
              >
                ✕
              </button>
            )}
          </>
        ) : (
          <>
            <span
              className="flex-1 truncate text-zinc-400"
              title={url}
            >
              {url || '(no URL set)'}
            </span>
            <button
              type="button"
              onClick={() => setEditingUrl(true)}
              className="text-zinc-400 hover:text-amber-300"
              title="Change URL"
            >
              ✎
            </button>
            {url && (
              <button
                type="button"
                onClick={openInPopup}
                className="rounded border border-amber-700 bg-amber-900 px-1.5 py-0.5 text-[10px] font-bold text-amber-100 hover:bg-amber-800"
                title="Open the stream in a popup window — fixes the 'Please login' error caused by browser third-party cookie blocking"
              >
                🪟 Popup
              </button>
            )}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-400 hover:text-amber-300"
                title="Open in new tab"
              >
                ↗
              </a>
            )}
            <button
              type="button"
              onClick={goFullscreen}
              className="text-zinc-400 hover:text-amber-300"
              title="Fullscreen"
            >
              ⛶
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-100"
              title="Close"
            >
              ✕
            </button>
          </>
        )}
      </div>

      {/* iframe — only render once we have a URL */}
      <div className="relative flex-1 bg-black">
        {url ? (
          <iframe
            ref={iframeRef}
            src={url}
            title="Race stream"
            className="h-full w-full border-0"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer-when-downgrade"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 py-8 text-center text-xs text-zinc-500">
            Paste a FanDuel video URL above. They look like
            <br />
            <code className="mt-1 font-mono text-zinc-400">
              https://racing.fanduel.com/video.html?src=…
            </code>
          </div>
        )}
      </div>

      {/* Cross-origin login hint */}
      {url && (
        <div className="border-t border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[10px] leading-tight text-zinc-500">
          Seeing &quot;Please login in the main site&quot;? That&apos;s your browser blocking
          third-party cookies in the iframe. Click{' '}
          <button
            type="button"
            onClick={openInPopup}
            className="font-bold text-amber-300 underline hover:text-amber-200"
          >
            🪟 Popup
          </button>{' '}
          above to open the stream in a separate window — works every time.
        </div>
      )}
    </div>
  );
}

/** Read the persisted "is the panel open?" flag. */
export function readVideoPanelOpenFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
