import { chromium, type BrowserContext, type Page, type Response, type WebSocket } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STATE_PATH = path.resolve('auth/storageState.json');
const CAPTURE_PATH = path.resolve('auth/network-capture.jsonl');
const PROFILE_DIR = path.resolve('auth/chrome-profile');
const MAX_BODY_BYTES = 100 * 1024;

const ALLOW_HOST = [
  /(^|\.)racing\.fanduel\.com$/i,
  /(^|\.)fanduel\.com$/i,
  /(^|\.)tvg\.com$/i,
];

const REDACT_HEADER = /^(authorization|x-csrf-token|x-api-key|x-auth-token)$/i;

function isAllowedUrl(url: string): boolean {
  try {
    return ALLOW_HOST.some((rx) => rx.test(new URL(url).hostname));
  } catch {
    return false;
  }
}

function isAllowedWsUrl(url: string): boolean {
  // Accept ws:// and wss:// against the same host allowlist.
  try {
    const u = new URL(url);
    return ALLOW_HOST.some((rx) => rx.test(u.hostname));
  } catch {
    return false;
  }
}

function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'cookie') {
      out[name] = value
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => {
          const eq = p.indexOf('=');
          return `${eq >= 0 ? p.slice(0, eq) : p}=<REDACTED>`;
        })
        .join('; ');
    } else if (REDACT_HEADER.test(name)) {
      out[name] = '<REDACTED>';
    } else {
      out[name] = value;
    }
  }
  return out;
}

function truncateString(value: string, max: number): { body: string; truncated: boolean } {
  if (value.length <= max) return { body: value, truncated: false };
  return { body: value.slice(0, max) + '...<TRUNCATED>', truncated: true };
}

function truncateBuffer(buf: Buffer, max: number): { body: string; truncated: boolean } {
  if (buf.length <= max) return { body: buf.toString('utf8'), truncated: false };
  return { body: buf.subarray(0, max).toString('utf8') + '...<TRUNCATED>', truncated: true };
}

async function captureResponse(
  resp: Response,
  stream: fs.WriteStream,
  counts: Map<string, number>,
): Promise<void> {
  try {
    const url = resp.url();
    if (!isAllowedUrl(url)) return;
    const ct = (resp.headers()['content-type'] ?? '').toLowerCase();
    if (!ct.includes('json')) return;

    let bodyBuf: Buffer;
    try {
      bodyBuf = await resp.body();
    } catch {
      bodyBuf = Buffer.alloc(0);
    }
    const { body, truncated } = truncateBuffer(bodyBuf, MAX_BODY_BYTES);

    const req = resp.request();
    let requestBody: string | null = null;
    let requestBodyTruncated = false;
    const postData = req.postData();
    if (postData !== null && postData !== undefined && postData.length > 0) {
      const t = truncateString(postData, MAX_BODY_BYTES);
      requestBody = t.body;
      requestBodyTruncated = t.truncated;
    }

    stream.write(
      JSON.stringify({
        kind: 'http',
        ts: new Date().toISOString(),
        url,
        method: req.method(),
        status: resp.status(),
        requestHeaders: sanitizeRequestHeaders(req.headers()),
        responseHeaders: resp.headers(),
        requestBody,
        requestBodyTruncated,
        body,
        truncated,
      }) + '\n',
    );

    const u = new URL(url);
    const pattern = u.origin + u.pathname;
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  } catch {
    // Capture is best-effort; never let one bad response abort the session.
  }
}

function writeWsFrame(
  stream: fs.WriteStream,
  url: string,
  direction: 'sent' | 'received',
  payload: string | Buffer,
  wsCounts: Map<string, number>,
): void {
  try {
    if (!isAllowedWsUrl(url)) return;
    const { body, truncated } = Buffer.isBuffer(payload)
      ? truncateBuffer(payload, MAX_BODY_BYTES)
      : truncateString(payload, MAX_BODY_BYTES);
    stream.write(
      JSON.stringify({
        kind: 'ws',
        ts: new Date().toISOString(),
        url,
        direction,
        body,
        truncated,
      }) + '\n',
    );
    const key = `WS ${direction} ${url}`;
    wsCounts.set(key, (wsCounts.get(key) ?? 0) + 1);
  } catch {
    // best-effort
  }
}

function attachToPage(
  page: Page,
  stream: fs.WriteStream,
  counts: Map<string, number>,
  wsCounts: Map<string, number>,
): void {
  page.on('response', (r) => {
    void captureResponse(r, stream, counts);
  });
  page.on('websocket', (ws: WebSocket) => {
    const url = ws.url();
    if (!isAllowedWsUrl(url)) return;
    ws.on('framesent', ({ payload }) => writeWsFrame(stream, url, 'sent', payload, wsCounts));
    ws.on('framereceived', ({ payload }) => writeWsFrame(stream, url, 'received', payload, wsCounts));
  });
}

async function launchContext(): Promise<BrowserContext> {
  // Bot-detection hardening:
  //  - channel: 'chrome' uses the user's installed Chrome instead of bundled
  //    Chromium (PerimeterX flags Chromium aggressively).
  //  - launchPersistentContext keeps a real profile dir so cookies, history,
  //    and local storage accumulate across runs (PerimeterX learns the
  //    profile is human over time).
  //  - --disable-blink-features=AutomationControlled hides the automation banner.
  //  - viewport: null lets Chrome use its natural window size.
  // First try Chrome; fall back to bundled Chromium if Chrome isn't installed.
  const opts = {
    headless: false,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      ...opts,
      channel: 'chrome',
    });
  } catch (err) {
    console.warn(
      '\n[warn] could not launch installed Chrome; falling back to bundled Chromium.',
    );
    console.warn('[warn] PerimeterX may be more aggressive against Chromium.');
    console.warn('[warn] error:', err instanceof Error ? err.message : String(err));
    return chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

(async () => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await launchContext();

  // Hide automation signals PerimeterX checks for. Init script runs in every
  // page on every navigation, BEFORE FanDuel's JS executes.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // @ts-expect-error window.chrome is not in the lib.dom types
    if (!window.chrome) {
      // @ts-expect-error
      window.chrome = { runtime: {} };
    }
  });

  const stream = fs.createWriteStream(CAPTURE_PATH, { flags: 'w' });
  const counts = new Map<string, number>();
  const wsCounts = new Map<string, number>();

  // Attach to existing pages and any future pages.
  for (const p of context.pages()) attachToPage(p, stream, counts, wsCounts);
  context.on('page', (p) => attachToPage(p, stream, counts, wsCounts));

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://racing.fanduel.com');

  console.log('\n========================================================================');
  console.log(' derby-edge — login + network capture');
  console.log('========================================================================');
  console.log(' 1. Log in to FanDuel Racing in the open browser window.');
  console.log('    If a "Press & Hold" challenge appears, hold it firmly for ~5 sec.');
  console.log('    Persistent profile means subsequent runs should skip the challenge.');
  console.log(' 2. Navigate to a race within ~10 minutes of post.');
  console.log('    Tip: late-card races (R7+ at any track) maximize live activity.');
  console.log(' 3. Click into the program page, then the Win/Place/Show');
  console.log('    or Pools/Probables tabs.');
  console.log(' 4. Stay on the page ~3 minutes letting it auto-refresh.');
  console.log('    Bonus: navigate to 2–3 DIFFERENT races during the capture');
  console.log('    (different track, different race number) — this confirms');
  console.log('    the GraphQL operation is reused across races, which lets the');
  console.log('    scraper template the variables instead of hardcoding one race.');
  console.log(' 5. Return to THIS terminal and press Enter when done.');
  console.log('------------------------------------------------------------------------');
  console.log(' Capturing JSON responses + request bodies + WebSocket frames to:');
  console.log('  ', CAPTURE_PATH);
  console.log('========================================================================\n');

  await new Promise<void>((r) => process.stdin.once('data', () => r()));

  await context.storageState({ path: STATE_PATH });
  stream.end();

  const stat = fs.statSync(CAPTURE_PATH);
  const totalHttp = [...counts.values()].reduce((a, b) => a + b, 0);
  const totalWs = [...wsCounts.values()].reduce((a, b) => a + b, 0);
  const top10 = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topWs = [...wsCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 13)
    .replace(/(\d{8})(\d{4})/, '$1-$2');

  console.log(`\nSession saved   : ${STATE_PATH}`);
  console.log(`Profile dir     : ${PROFILE_DIR}`);
  console.log(`Network capture : ${CAPTURE_PATH} (${(stat.size / 1024).toFixed(1)} KB)`);
  console.log(`                  HTTP records: ${totalHttp}, WebSocket frames: ${totalWs}`);
  console.log('\nTop 10 HTTP URL patterns by frequency:');
  for (const [pattern, count] of top10) {
    console.log(`  ${count.toString().padStart(5)}  ${pattern}`);
  }
  if (topWs.length > 0) {
    console.log('\nTop WebSocket endpoints (frame count):');
    for (const [key, count] of topWs) {
      console.log(`  ${count.toString().padStart(5)}  ${key}`);
    }
  } else {
    console.log('\nNo WebSocket traffic captured (or no FanDuel WS connections opened).');
  }
  console.log('\nTo preserve this capture before re-running, rename it first:');
  console.log(`  mv ${CAPTURE_PATH} auth/network-capture-${stamp}.jsonl`);
  console.log('\nNext step: pnpm run analyze-capture\n');

  await context.close();
  process.exit(0);
})();
