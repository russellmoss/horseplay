/**
 * Node-only side of the Next.js instrumentation hook. Pulled in via
 * `instrumentation.ts` only when `process.env.NEXT_RUNTIME === 'nodejs'`,
 * so the Edge bundle never sees Playwright / fs / net.
 *
 * Idempotent across `next dev` HMR rounds via a global flag.
 *
 * Skipped entirely when ENABLE_SCRAPER is not "true" (e.g. on Vercel),
 * so Playwright is never imported in the viewer-only deployment.
 */

export {};

if (process.env.ENABLE_SCRAPER !== 'true') {
  console.log('[derby-edge] instrumentation-node: ENABLE_SCRAPER is not set, skipping scraper boot (viewer mode)');
} else {
  const FLAG = Symbol.for('derbyEdge.booted');
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;

  if (!g[FLAG]) {
    g[FLAG] = true;
    console.log('[derby-edge] instrumentation-node: booting scraper runtime…');
    import('./lib/scraper/runtime').then(({ scraperRuntime }) => {
      scraperRuntime
        .start()
        .then(() => {
          console.log('[derby-edge] scraper runtime status:', scraperRuntime.status().state, '—', scraperRuntime.status().message);
        })
        .catch((err: unknown) => {
          console.error('[derby-edge] scraper runtime threw:', err);
        });
    });
  } else {
    console.log('[derby-edge] instrumentation-node: already booted (HMR), skipping');
  }
}
