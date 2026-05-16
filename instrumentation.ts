/**
 * Next.js startup hook. Runs once per process when the server boots.
 *
 * Next builds this file for BOTH the Node.js and Edge runtimes by default.
 * Our scraper depends on Playwright + Node built-ins (fs, net, …) which the
 * Edge runtime doesn't have. The conditional dynamic import below is the
 * documented Next.js pattern for splitting Node-only setup from the Edge
 * build — webpack only bundles `./instrumentation-node` for the Node bundle.
 *
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
