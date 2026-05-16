# /discover-fdr

Run this command when you need to discover or refresh the FanDuel Racing JSON endpoints that power the live tote board. This is the only manual, in-browser step in the derby-edge build.

## What this command does

Walks the user through capturing FanDuel Racing's internal JSON endpoints via Chrome DevTools, then writes the findings to `auth/discovered-endpoints.md` so the schema adapter (`lib/scraper/adapter.ts`) can be wired up against the actual response shapes.

## When to run

- First-time setup, after `pnpm run login` succeeds
- Whenever the scraper starts returning 4xx/5xx persistently (FDR may have changed their API)
- Whenever the dashboard starts showing nulls in fields that previously had data
- After any extended outage (>72 hours)

## Procedure (paste this checklist into the chat verbatim)

> I'm going to walk you through capturing FanDuel Racing's live odds endpoints. Have a desktop Chrome window ready and confirm you're logged in to https://racing.fanduel.com.
>
> **Step 1.** Pick any race that's within 10 minutes of post time (doesn't have to be a race you're betting). Navigate to its live odds page. Reply with the URL when you're there.
>
> **Step 2.** Open DevTools (`Cmd+Opt+I`), go to the Network tab, and filter to `Fetch/XHR`. Click "Clear" to start fresh.
>
> **Step 3.** Click the "Win/Place/Show" or "Pools" tab in the FDR UI to trigger network activity. Wait ~30 seconds for at least one full refresh cycle.
>
> **Step 4.** Identify candidate requests. Look for paths containing: `tote`, `pool`, `wager`, `odds`, `race`, `event`, `runners`, `live`. Click each one → Response tab → check whether the JSON contains per-horse pool dollar amounts (Win, Place, Show).
>
> **Step 5.** For each useful endpoint, right-click → Copy → Copy as cURL. Paste each cURL into the chat.
>
> **Step 6.** I'll parse the cURLs and write `auth/discovered-endpoints.md` documenting URL patterns, required headers, and response schemas. Then I'll generate or update `lib/scraper/adapter.ts` against the actual shapes.

## Output contract

After this command completes, the following must exist:

1. `auth/discovered-endpoints.md` — one section per endpoint, with URL pattern, required headers (note which are auto-provided by Playwright's session vs. which are static), observed refresh cadence, and a sanitized sample response body.
2. `lib/scraper/adapter.ts` — implements `adaptFdrToRace()` against the documented shapes. If pool dollars are split across multiple endpoints, the adapter composes them by program number.
3. A passing contract test in `tests/adapter.test.ts` using a mocked input that matches one documented response.

## Fallback behavior

If after thorough inspection FDR does not expose Place pool or Show pool dollars in any endpoint:

- Document that finding explicitly in `auth/discovered-endpoints.md` under a `## Pool data availability` section.
- Implement the adapter using only Win odds / Win pool, falling through to the decimal-odds probability path described in `IMPLEMENTATION.md` §6.1.
- The dashboard will render `—` in projected Place/Show payout cells with a tooltip "FDR does not expose this pool publicly."
- ML-drift signals continue to work normally.

## Security reminders

- The cURLs you paste contain session cookies. Sanitize before committing — the `auth/` directory is gitignored, but err on the side of caution.
- Never paste your FanDuel password. The session cookie is sufficient.
- If you accidentally commit a session token, treat it as compromised: rotate by clicking "Sign out of all devices" in your FDR account settings, then re-run `pnpm run login`.
