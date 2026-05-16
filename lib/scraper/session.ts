import { chromium, type BrowserContext, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Long-lived Playwright session for the scraper. Loads `auth/storageState.json`
 * (or the persistent profile dir) so requests are authed against FDR. Carries
 * the same bot-detection hardening as `scripts/login.ts` — installed Chrome
 * via `channel: 'chrome'`, stealth init script, persistent profile.
 *
 * Two consumers:
 *   - `lib/scraper/fetch.ts` uses `context.request` for authed HTTP GraphQL.
 *   - `lib/scraper/poller.ts` uses the page to host a WebSocket subscription
 *     opened from the page context (so cookies + origin headers are correct).
 */

const STATE_PATH = path.resolve('auth/storageState.json');
const PROFILE_DIR = path.resolve('auth/chrome-profile');

export interface Session {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export interface OpenSessionOptions {
  /** Default true — set false for interactive debugging. */
  headless?: boolean;
  /** Override the initial navigation URL. Defaults to https://racing.fanduel.com/. */
  startUrl?: string;
}

export async function openSession(options: OpenSessionOptions = {}): Promise<Session> {
  const headless = options.headless ?? true;
  const startUrl = options.startUrl ?? 'https://racing.fanduel.com/';

  const profileExists = fs.existsSync(PROFILE_DIR);
  const stateExists = fs.existsSync(STATE_PATH);

  if (!profileExists && !stateExists) {
    throw new Error(
      'No saved FDR session found. Run `pnpm run login` to create auth/storageState.json or auth/chrome-profile/.',
    );
  }

  const launchArgs = ['--disable-blink-features=AutomationControlled'];

  // Persistent profile preferred — it accumulates trust signals against
  // PerimeterX over time and survives bot-detection challenges that a fresh
  // ephemeral context would trip.
  if (profileExists) {
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        viewport: null,
        args: launchArgs,
        channel: 'chrome',
      });
    } catch {
      // Chrome not installed at the default path; fall back to bundled Chromium.
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        viewport: null,
        args: launchArgs,
      });
    }
    await applyStealth(context);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(startUrl);
    return {
      context,
      page,
      close: async () => {
        await context.close();
      },
    };
  }

  // Ephemeral context with storageState fallback.
  const browser = await chromium.launch({
    headless,
    args: launchArgs,
  });
  const context = await browser.newContext({
    storageState: STATE_PATH,
    viewport: null,
  });
  await applyStealth(context);
  const page = await context.newPage();
  await page.goto(startUrl);
  return {
    context,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

async function applyStealth(context: BrowserContext): Promise<void> {
  // tsx (esbuild) injects `__name(fn, 'name')` wrappers around named functions
  // to preserve Function.prototype.name. When we ship transpiled code into
  // the page via page.evaluate, the browser has no `__name`. Shim it as a
  // no-op so injected code can run. The string-form init script is NOT
  // itself transpiled by esbuild, so it stays clean.
  await context.addInitScript({
    content:
      'globalThis.__name = globalThis.__name || function (fn) { return fn; };',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // @ts-expect-error window.chrome is not in lib.dom types
    if (!window.chrome) {
      // @ts-expect-error
      window.chrome = { runtime: {} };
    }
  });
}
