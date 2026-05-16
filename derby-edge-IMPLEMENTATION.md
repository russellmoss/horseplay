# derby-edge — Implementation Guide

A live pari-mutuel arbitrage signal tool for US horse racing. Scrapes Win, Place, and Show pool data from FanDuel Racing (TVG), computes "fair" Place/Show payouts from the Win pool, flags +EV bets when actual projected payouts exceed fair, and tracks morning-line drift.

This document is the single source of truth for Claude Code. Everything needed to build the v1 is here. The only step that requires the human in the loop is the **FanDuel Racing endpoint discovery** in §8 — everything else is buildable from this spec.

---

## 1. Problem statement

**Thesis (from Ryan):** the Win pool is the most efficient market because it has the most volume. The Place and Show pools are smaller and get distorted when somebody dumps a big bet on a single horse. Because of the $2.10 minimum payout floor on a $2 bet, that distortion mathematically forces *other* horses' Place/Show payouts higher than they "should" be relative to their Win-pool-implied probability of finishing in the money. Those moments are +EV bets.

Two signals to surface:

1. **Pool arbitrage:** for each horse, compute the "fair" Place and Show payout implied by its Win-pool probability. Compare to the actual projected Place/Show payout (computed from the live pool dollars). When actual ≥ fair, flag.
2. **Morning-line drift:** for each horse, compute `(current_odds − ml_odds) / ml_odds`. Big positive drifts (e.g., ML 5/1, currently 10/1) are bet candidates per Ryan's heuristic.

Both signals run live, on every race on the card, refreshing every 15s within 10 min of post.

---

## 2. Acceptance criteria

The tool ships when all of the following are true:

- [ ] One-time login via `npm run login` produces a persistent Playwright `storageState.json` that survives across scraper runs.
- [ ] Scraper polls FanDuel Racing for all of today's races at one or more configured tracks (default: Churchill Downs).
- [ ] For each race, the scraper retrieves Win, Place, and Show pool dollars per horse, plus current and morning-line odds.
- [ ] Math engine outputs both **Heuristic (Ryan's)** and **Harville** fair-price models side by side.
- [ ] Dashboard renders a sortable table per race showing: program #, name, ML odds, current odds, drift %, p(win), Place actual (floor/mid/ceiling), Place fair (heur + harv), Place edge %, Show actual (floor/mid/ceiling), Show fair (heur + harv), Show edge %.
- [ ] Rows where `floor_payout ≥ fair_payout` (under either model) are highlighted green ("slam-dunk").
- [ ] Rows where `mid_payout > fair_payout × 1.05` are highlighted yellow.
- [ ] ML drift > +50% renders a red border on the row.
- [ ] Audible chime (one-shot, dismissible) plays when a new +EV signal appears.
- [ ] All math is unit-tested against fixtures in `/fixtures/` so Russell can validate without live data.
- [ ] README documents the FanDuel endpoint discovery procedure step-by-step.

**Out of scope for v1:** automatic bet placement, Kelly sizing, exotics (exacta/trifecta/super), historical analytics, multi-track parallelization, mobile responsive design.

---

## 3. Architecture (locked)

| Decision | Choice |
|---|---|
| Language | TypeScript (strict) |
| Framework | Next.js 14 App Router |
| Auth | Playwright with persistent `storageState.json` |
| Scraper runtime | Node.js, in-process with Next.js (server actions / route handlers) |
| State | In-memory (Map keyed by raceId), no DB for v1 |
| Polling | Server-side interval; client polls `/api/odds` every 5s |
| Styling | Tailwind (default Next.js scaffold) |
| Tests | Vitest |
| Package mgr | pnpm |

No DB. No auth. No deploy target. This runs locally on Russell's machine with `pnpm dev` and that's the entire deployment story.

---

## 4. Project structure

```
derby-edge/
  app/
    layout.tsx
    page.tsx                      # dashboard (client component)
    api/
      odds/route.ts                # GET → cached analysis for all tracked races
      refresh/route.ts             # POST → force scraper refresh
      session/route.ts             # GET → reports session health
  lib/
    math/
      probability.ts               # win pool / odds → normalized probs
      heuristic.ts                 # Ryan's ½ / ⅓ model
      harville.ts                  # Harville place / show probabilities
      payouts.ts                   # projected place/show payouts from pools
      ev.ts                        # edge calc + signal classification
      odds.ts                      # decimal ↔ fractional helpers
      index.ts                     # re-exports + analyzeRace() facade
    scraper/
      session.ts                   # Playwright context lifecycle
      fetch.ts                     # authenticated request helper
      adapter.ts                   # FDR JSON → internal Race shape
      poller.ts                    # interval scheduler with backoff
    types.ts                       # Race, Horse, Analysis, Signal
    store.ts                       # in-memory race state
    config.ts                      # tracks, polling cadences, takeouts
  scripts/
    login.ts                       # Playwright login + network capture (writes auth/storageState.json + auth/network-capture.jsonl)
    analyze-capture.ts             # parses auth/network-capture.jsonl, identifies pool-bearing endpoints
  fixtures/
    derby-2024-final.json          # known race for math validation
    sample-6-horse.json            # synthetic small race
  tests/
    math.probability.test.ts
    math.heuristic.test.ts
    math.harville.test.ts
    math.payouts.test.ts
    math.ev.test.ts
    adapter.test.ts                # adapter contract test (mocked input)
  auth/
    .gitignore                     # ignore storageState.json
  .env.example
  README.md
  package.json
  next.config.ts
  tsconfig.json
  playwright.config.ts
  vitest.config.ts
```

---

## 5. Type definitions

```ts
// lib/types.ts

export type DecimalOdds = number;           // e.g., 6.0 for 5/1
export type Dollars = number;                // pool $

export interface Horse {
  program: string;                           // '1', '1A', '7'
  name: string;
  jockey?: string;
  trainer?: string;
  mlOdds: DecimalOdds | null;                // morning line, decimal
  currentOdds: DecimalOdds | null;           // live, decimal
  winPoolDollars: Dollars | null;
  placePoolDollars: Dollars | null;
  showPoolDollars: Dollars | null;
  scratched: boolean;
}

export interface Race {
  raceId: string;                            // FDR-issued or composite
  trackCode: string;                         // 'CD', 'BEL', etc.
  raceNumber: number;
  postTimeUtc: string;                       // ISO 8601
  status: 'open' | 'closed' | 'official';
  horses: Horse[];
  totalWinPool?: Dollars;
  totalPlacePool?: Dollars;
  totalShowPool?: Dollars;
  lastUpdate: string;                        // ISO 8601
}

export interface ModelOutput {
  pPlaceFair: number;
  pShowFair: number;
  placeFairPayout: number | null;            // per $2 bet
  showFairPayout: number | null;
}

export interface PayoutBand {
  floor: number | null;                      // worst-case projection
  mid: number | null;                        // average across companions
  ceiling: number | null;                    // best-case projection
}

export interface HorseAnalysis {
  program: string;
  name: string;
  mlOdds: DecimalOdds | null;
  currentOdds: DecimalOdds | null;
  currentFractional: string;
  mlDrift: number | null;                    // (current - ml) / ml
  pWin: number;                              // normalized
  heuristic: ModelOutput;
  harville: ModelOutput;
  placeProjected: PayoutBand;
  showProjected: PayoutBand;
  placeEdge: { heuristicFloor: number | null; heuristicMid: number | null; harvilleFloor: number | null; harvilleMid: number | null };
  showEdge:  { heuristicFloor: number | null; heuristicMid: number | null; harvilleFloor: number | null; harvilleMid: number | null };
  signal: 'slam_dunk' | 'lean' | 'drift' | 'none';
}

export interface RaceAnalysis {
  race: Race;
  probSource: 'win_pool' | 'decimal_odds' | 'uniform_fallback';
  rows: HorseAnalysis[];
  computedAt: string;
}
```

---

## 6. Math specification

All math is pure functions. Every formula below maps to a unit test.

### 6.1 Probability extraction

**From Win pool dollars** (preferred when available):

```
p_i = win_pool_i / Σ win_pool_j
```

Already normalized to sum to 1.

**From displayed decimal odds** (fallback):

```
p_i_raw = 1 / decimal_odds_i
p_i = p_i_raw / Σ p_j_raw            // strips the overround
```

**Probability source priority:** win_pool → decimal_odds → uniform fallback. Source must be reported in `RaceAnalysis.probSource`.

### 6.2 Heuristic model (Ryan's)

Ryan's mental model: top-2 finishers cash Place, top-3 cash Show. Horses with higher win prob proportionally more likely to be in the money.

```
p_place_fair_i = min(0.999, 2 × p_i)
p_show_fair_i  = min(0.999, 3 × p_i)
```

This is wrong in detail (a horse with p_win = 0.6 cannot have p_place = 1.2) but correct in spirit for sub-1/3 favorites, which is most of the field. Cap at 0.999.

### 6.3 Harville model

Standard order-statistics model. Assumes finishing positions are independent draws weighted by win probability.

**P(horse i finishes 2nd):**

```
P(2nd_i) = Σ_{j ≠ i}  p_j × p_i / (1 − p_j)
```

**Place probability:**

```
p_place_i = p_i + P(2nd_i)
```

**P(horse i finishes 3rd):**

```
P(3rd_i) = Σ_{j ≠ i} Σ_{k ≠ i, k ≠ j}  p_j × (p_k / (1 − p_j)) × (p_i / (1 − p_j − p_k))
```

**Show probability:**

```
p_show_i = p_place_i + P(3rd_i)
```

Numerical guard: if any denominator ≤ 0, skip that term (a horse with p ≥ 1 in the prob vector breaks the model — should never happen with normalized input but guard anyway).

Complexity: O(n³) for show, n ≤ 20 → ~8000 ops per race per refresh. Negligible.

### 6.4 Fair payout per $2 bet

For any model, the breakeven payout per $2 bet at a fair probability `p` is:

```
fair_payout = 2 / p
```

This is the price at which EV = 0 over many trials.

### 6.5 Projected Place / Show payouts from pools

Standard pari-mutuel mechanics. US Place/Show takeout typically ~17% (parameterize: `config.takeout.place`, `config.takeout.show`). $2.10 minimum payout floor. 5% breakage rounds *down* to the nearest $0.10.

**Place payout for horse i, given companion j is the other top-2 finisher:**

```
net_pool       = total_place_pool × (1 − takeout)
leftover       = net_pool − place_pool_i − place_pool_j
return_per_$2  = 2 + leftover / place_pool_i
breaked        = floor(return_per_$2 × 10) / 10
final_payout   = max(2.10, breaked)
```

The companion `j` is unknown ex ante, so compute scenarios:

- **Floor** (worst payout for i): pair with `j` having the **largest** `place_pool_j` (largest j drains more from leftover).
- **Ceiling** (best payout for i): pair with `j` having the **smallest** `place_pool_j` (longshot j leaves more in leftover).
- **Mid**: simple average across all valid `j ≠ i`.

**Show payout** is the same shape but with two companions `j` and `k`, and the leftover split among **three** finishing pools rather than two. That extra factor does not cancel against the per-$2 conversion the way it does for place, so the show formula carries an explicit `2/3`:

```
return_per_$2 = 2 + (2/3) × (net − show_i − show_j − show_k) / show_i
```

Derivation: each winning pool gets `leftover / 3`. The bettor on horse `i` holds a `$2 / show_i` share of that pool, so per-$2 return = `2 × (show_i + leftover/3) / show_i = 2 + (2/3)(leftover/show_i)`. Dropping the `2/3` overstates show payouts by ~50%.

- **Floor:** pair with the two horses having the largest show pools.
- **Ceiling:** pair with the two horses having the smallest show pools.
- **Mid:** average across all unordered pairs `{j, k}` with `j ≠ k ≠ i`. Each scenario's payout is broken individually; mid is the simple arithmetic mean of those broken payouts (and therefore may end in fractions of a tenth — invariant 6 applies to floor and ceiling, which correspond to actual finishing scenarios).

The same "break each scenario, then average" rule applies to place mid.

### 6.6 Edge

```
edge = (actual_payout / fair_payout) − 1
```

Positive = +EV at the projected payout. Compute four edges per horse (heuristic-floor, heuristic-mid, harville-floor, harville-mid) for each of Place and Show.

### 6.7 Signal classification

For each horse, evaluate in order:

1. If `placeEdge.harvilleFloor > 0` OR `showEdge.harvilleFloor > 0` → `slam_dunk`
2. Else if `placeEdge.harvilleMid > 0.05` OR `showEdge.harvilleMid > 0.05` → `lean`
3. Else if `mlDrift > 0.5` → `drift`
4. Else → `none`

Heuristic edges shown in the UI but not used for signal classification (Harville is the source of truth; heuristic is reference).

### 6.8 Morning-line drift

```
ml_drift = (current_odds − ml_odds) / ml_odds
```

Both in decimal. Positive = horse is lengthening (drifting out, less money than expected). Negative = shortening (more money than expected).

---

## 7. Project setup commands

```bash
pnpm create next-app@14 derby-edge --typescript --tailwind --app --no-src-dir --import-alias "@/*"
cd derby-edge
pnpm add -D playwright @types/node vitest @vitest/ui tsx
pnpm exec playwright install chromium
```

Add to `package.json`:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "login": "tsx scripts/login.ts",
    "analyze-capture": "tsx scripts/analyze-capture.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

---

## 8. FanDuel Racing endpoint discovery (automated, ~5 min interactive)

Russell does this once. Output: `auth/discovered-endpoints.md` documenting URL patterns, required headers, refresh cadences, and sample response shapes that inform `lib/scraper/adapter.ts`.

### Procedure

1. **Capture.** Run `pnpm run login`. The script (see §11) opens a headless:false Chromium, attaches a `page.on('response')` listener filtered to JSON responses from `racing.fanduel.com`, `*.fanduel.com`, and `*.tvg.com`, and writes a JSONL log to `auth/network-capture.jsonl`. Russell logs in by hand, navigates to any race within 10 min of post (Churchill Downs late races are a good target — they run after the Derby, long card), clicks the program page, then the Win/Place/Show or Pools/Probables tabs, and stays on the page ~3 minutes letting it auto-refresh. When done, press Enter in the terminal — `storageState.json` is saved, capture stops, and the script prints a summary (response count, top 10 URL patterns by frequency, capture file size).

2. **Analyze.** Run `pnpm run analyze-capture`. The script (`scripts/analyze-capture.ts`) reads `auth/network-capture.jsonl` and identifies pool-bearing endpoints using these heuristics:
   - Numeric fields named `*pool*`, `*pool_total*`, `*win_pool*`, `*place_pool*`, `*show_pool*`, `*amount_*`, `*total*`, or `*dollars*` (case-insensitive).
   - Per-runner arrays where any numeric field has values `> 1000` consistently across entries (likely pool dollars or odds).
   - URL patterns clustered by template (replace numeric IDs with `:id`, race IDs with `:raceId`, etc.).
   It prints a ranked list of candidate endpoints with: URL pattern, observed refresh cadence (mean Δt between captures), sample field paths that look like pools, and a small redacted sample response.

3. **Document.** Claude Code (in a fresh session, fed the analyze output and the relevant JSONL excerpts) writes `auth/discovered-endpoints.md` with one section per useful endpoint, in the format below.

4. **Pause for review.** Russell reads `auth/discovered-endpoints.md` before Phase 4 starts, so the adapter is built against verified shapes.

### What `auth/discovered-endpoints.md` should contain per endpoint

```markdown
### Endpoint: GET /api/...
- URL pattern: https://...?raceId={raceId}
- Required headers: cookie (handled by Playwright session), x-csrf-token (?), accept: application/json
- Refresh cadence observed: every ~20s (during the <10 min pre-post window)
- Response shape:
  {
    "raceId": "...",
    "horses": [
      { "programNumber": "1", "name": "...", "winOdds": "5/1", "winPool": 12345, "placePool": 4321, "showPool": 2109 }
    ]
  }
- Sample (redacted) response: see auth/network-capture.jsonl line N
```

### If the data is split across endpoints

Document each separately. The adapter will compose them by `programNumber` (or whatever the join key turns out to be).

### Manual DevTools fallback (only if the automated capture misses everything)

If `pnpm run analyze-capture` finds zero pool-bearing endpoints (e.g., FDR served only HTML or used non-JSON transport like protobuf, or the heuristics didn't match anything), fall back to the manual DevTools workflow:

1. Open Chrome, sign in to FDR.
2. Open DevTools (`Cmd+Opt+I`) → Network tab → filter Fetch/XHR.
3. Navigate to a race within 10 min of post; click the Live Odds or Pools tab.
4. Watch for periodic requests every 15–30s. Look for paths containing `tote`, `pool`, `wager`, `odds`, `race`, `event`.
5. For each useful endpoint, right-click → Copy → Copy as cURL, paste into `auth/discovered-endpoints.md`, sanitize cookie values.

Use this only when the automated path produces nothing. The captured-and-analyzed path is faster and less error-prone in the common case.

### If pool dollars are not exposed in any endpoint at all

Fallback path: scrape live decimal odds (which will be exposed somewhere) and use the decimal-odds probability path (§6.1). Place/Show actual payouts cannot be computed without pool dollars, so the arbitrage signal degrades to ML drift only. Document this as the v1 fallback in `auth/discovered-endpoints.md` under a `## Pool data availability` section.

---

## 9. Schema adapter pattern

`lib/scraper/adapter.ts` is the *only* file that knows about FDR's JSON shape. It exports one function:

```ts
export function adaptFdrToRace(
  meta: FdrRaceMetaResponse,
  pools: FdrPoolsResponse,
  odds: FdrOddsResponse,
): Race
```

If discovery (§8) reveals different actual response shapes, edit only this file — the math engine, dashboard, and store all consume the internal `Race` type and don't care.

Adapter responsibilities:

- Convert fractional odds (e.g., `"5/1"`) to decimal (`6.0`) via `lib/math/odds.ts`.
- Filter scratched horses (set `scratched: true`, don't drop — UI may show them grayed).
- Default missing fields to `null`, not `0` or `undefined`.
- Validate: throw if `horses.length === 0` or if all win pools are zero with no odds available.
- Stamp `lastUpdate` with current ISO timestamp.

---

## 10. Polling strategy

`lib/scraper/poller.ts` schedules requests per race:

| Time to post | Cadence |
|---|---|
| > 60 min | 5 min |
| 10–60 min | 60 sec |
| < 10 min | 15 sec |
| Race closed (gates open) | 5 sec until status = `official`, then stop |
| Race official | no further polls |

Concurrency cap: max 3 in-flight requests at a time.

Backoff: on 5xx, retry with exponential backoff (2s, 4s, 8s, max 30s). On 401/403, mark session as needing re-auth and stop polling — UI surfaces a "Run `pnpm run login`" banner.

Cache: store the latest `RaceAnalysis` in `lib/store.ts` keyed by `raceId`. Dashboard reads from this cache.

---

## 11. Session management

`scripts/login.ts` does two jobs: (a) save a persistent Playwright session to `auth/storageState.json`, and (b) capture every JSON response from FanDuel-family domains during the same browser session into `auth/network-capture.jsonl` so §8 can be done without DevTools.

```ts
import { chromium, type Response } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STATE_PATH = path.resolve('auth/storageState.json');
const CAPTURE_PATH = path.resolve('auth/network-capture.jsonl');
const MAX_BODY_BYTES = 100 * 1024; // 100 KB hard cap per response body

const ALLOW_HOST = [
  /(^|\.)racing\.fanduel\.com$/i,
  /(^|\.)fanduel\.com$/i,
  /(^|\.)tvg\.com$/i,
];

const REDACT_HEADER = /^(authorization|x-csrf-token|x-api-key|x-auth-token)$/i;

function isAllowedUrl(url: string): boolean {
  try { return ALLOW_HOST.some((rx) => rx.test(new URL(url).hostname)); }
  catch { return false; }
}

function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'cookie') {
      // Keep cookie NAMES, redact VALUES.
      out[name] = value.split(';').map((s) => s.trim()).filter(Boolean).map((p) => {
        const eq = p.indexOf('=');
        return `${eq >= 0 ? p.slice(0, eq) : p}=<REDACTED>`;
      }).join('; ');
    } else if (REDACT_HEADER.test(name)) {
      out[name] = '<REDACTED>';
    } else {
      out[name] = value;
    }
  }
  return out;
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
    try { bodyBuf = await resp.body(); }
    catch { bodyBuf = Buffer.alloc(0); }
    const truncated = bodyBuf.length > MAX_BODY_BYTES;
    const body = truncated
      ? bodyBuf.subarray(0, MAX_BODY_BYTES).toString('utf8') + '...<TRUNCATED>'
      : bodyBuf.toString('utf8');

    const req = resp.request();
    stream.write(JSON.stringify({
      ts: new Date().toISOString(),
      url,
      method: req.method(),
      status: resp.status(),
      requestHeaders: sanitizeRequestHeaders(req.headers()),
      responseHeaders: resp.headers(),
      body,
      truncated,
    }) + '\n');

    const u = new URL(url);
    const pattern = u.origin + u.pathname;
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  } catch {
    // Capture is best-effort; never let one bad response abort the session.
  }
}

(async () => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const stateExists = fs.existsSync(STATE_PATH);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(stateExists ? { storageState: STATE_PATH } : {});
  const page = await context.newPage();

  const stream = fs.createWriteStream(CAPTURE_PATH, { flags: 'w' });
  const counts = new Map<string, number>();
  page.on('response', (r) => { void captureResponse(r, stream, counts); });

  await page.goto('https://racing.fanduel.com');

  console.log('\n========================================================================');
  console.log(' derby-edge — login + network capture');
  console.log('========================================================================');
  console.log(' 1. Log in to FanDuel Racing in the open browser window.');
  console.log(' 2. Navigate to any race within 10 minutes of post.');
  console.log('    Tip: Churchill Downs late races run after the Derby (long card).');
  console.log(' 3. Click into the program page, then the Win/Place/Show');
  console.log('    or Pools/Probables tabs.');
  console.log(' 4. Stay on the page ~3 minutes letting it auto-refresh.');
  console.log(' 5. Return to THIS terminal and press Enter when done.');
  console.log('------------------------------------------------------------------------');
  console.log(' Capturing JSON responses to:', CAPTURE_PATH);
  console.log('========================================================================\n');

  await new Promise<void>((r) => process.stdin.once('data', () => r()));

  await context.storageState({ path: STATE_PATH });
  stream.end();

  const stat = fs.statSync(CAPTURE_PATH);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const top10 = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  console.log(`\nSession saved   : ${STATE_PATH}`);
  console.log(`Network capture : ${CAPTURE_PATH} (${(stat.size / 1024).toFixed(1)} KB, ${total} JSON responses)`);
  console.log('\nTop 10 URL patterns by frequency:');
  for (const [pattern, count] of top10) {
    console.log(`  ${count.toString().padStart(5)}  ${pattern}`);
  }
  console.log('\nNext step: pnpm run analyze-capture\n');

  await browser.close();
  process.exit(0);
})();
```

### What this gives you

- **Persistent auth.** `storageState.json` is loaded back into the next invocation if present, so re-running `pnpm run login` only requires re-typing credentials when the session has actually expired.
- **No DevTools.** All JSON traffic to FDR/TVG/FanDuel hosts is captured in `auth/network-capture.jsonl`, one record per response. Sanitization redacts cookie values (keeping names) and a short list of auth-bearing header values, so the file is safer to inspect than raw DevTools exports.
- **Bounded file size.** Each response body is truncated at 100 KB; a 3-minute session typically produces a few MB at most.
- **Frequency hint.** The end-of-session summary surfaces the top 10 URL patterns by hit count, which is usually enough to identify the live-odds and pools endpoints by inspection.

`lib/scraper/session.ts` loads `storageState.json` and exposes a `withAuthedFetch` helper that runs requests in a Playwright context. Don't use raw `fetch` — Playwright handles cookie rotation.

Session expiry handling: see §10 (mark unhealthy on 401/403, surface banner).

`auth/.gitignore` contains `*` — never commit `storageState.json` or `network-capture.jsonl`.

---

## 12. Dashboard spec

Single page (`app/page.tsx`). Client component, polls `/api/odds` every 5s.

### Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ derby-edge        [Track: CD ▾]  [Race: 12 (Derby) ▾]  ⏱ 02:43 to post │
│                                                          last update 5s│
├────────────────────────────────────────────────────────────────────────┤
│ Prob source: win_pool                            Probs sum: 1.000      │
│                                                                        │
│ # | Horse        | ML  | Cur | Δ%   | p(W) | Place actual  | Place fair│
│   |              |     |     |      |      | floor mid ceil| heur harv │
│ 1 | Renegade     | 9/2 | 4/1 | -10% | 0.20 | 3.40 3.80 4.20| 5.00 4.85 │ ← lean (yellow)
│ 2 | Wonder Dean  | 30/1| 18/1| -40% | 0.05 | 12.0 14.5 18.2| 20.0 19.5 │ ← slam_dunk (green)
│ 3 | Further Ado  | 12/1| 22/1| +83% | 0.045| ...                       │ ← drift (red border)
│ ...                                                                    │
│                                                                        │
│ Show columns identical structure                                       │
└────────────────────────────────────────────────────────────────────────┘
```

### Highlighting rules

| Condition | Visual |
|---|---|
| Signal = `slam_dunk` | Row background `bg-green-100`, text `text-green-900` |
| Signal = `lean` | Row background `bg-yellow-50` |
| Signal = `drift` | Border `border-l-4 border-red-500` |
| Cell where any edge > 0 | `font-bold text-green-700` |
| Cell where edge < −0.20 | `text-gray-400` |
| Scratched horse | Whole row `opacity-40 line-through` |

### Sound alert

When a horse transitions *into* `slam_dunk` (was not slam_dunk on previous render, is now), play a one-shot chime via `new Audio('/chime.mp3').play()`. Track previously-signaled horse IDs in a ref to avoid replaying.

A small ⓘ button shows a modal with: math model formulas, current takeout settings, Ryan's heuristic thesis, and a "Reset signal history" button.

### Race selector

Top of page: dropdown of all today's races at the configured tracks. Auto-advance to "next race within 10 min of post" on race close.

### Live countdown

Sticky header shows MM:SS to post. Pulls from `race.postTimeUtc`.

---

## 13. Test fixtures

### `fixtures/sample-6-horse.json`

A simple race for manual math validation. Six horses, clean numbers. Hand-verified expected outputs in `tests/math.harville.test.ts`.

```json
{
  "raceId": "TEST-1",
  "trackCode": "TST",
  "raceNumber": 1,
  "postTimeUtc": "2026-05-02T22:00:00Z",
  "status": "open",
  "horses": [
    { "program": "1", "name": "Alpha",   "mlOdds": 3.0, "currentOdds": 3.0, "winPoolDollars": 50000, "placePoolDollars": 20000, "showPoolDollars": 10000, "scratched": false },
    { "program": "2", "name": "Bravo",   "mlOdds": 4.0, "currentOdds": 4.5, "winPoolDollars": 35000, "placePoolDollars": 15000, "showPoolDollars": 8000,  "scratched": false },
    { "program": "3", "name": "Charlie", "mlOdds": 6.0, "currentOdds": 6.0, "winPoolDollars": 25000, "placePoolDollars": 12000, "showPoolDollars": 7000,  "scratched": false },
    { "program": "4", "name": "Delta",   "mlOdds": 8.0, "currentOdds": 12.0,"winPoolDollars": 12000, "placePoolDollars": 8000,  "showPoolDollars": 6000,  "scratched": false },
    { "program": "5", "name": "Echo",    "mlOdds": 11.0,"currentOdds": 14.0,"winPoolDollars": 10000, "placePoolDollars": 7000,  "showPoolDollars": 5500,  "scratched": false },
    { "program": "6", "name": "Foxtrot", "mlOdds": 21.0,"currentOdds": 26.0,"winPoolDollars": 6000,  "placePoolDollars": 4000,  "showPoolDollars": 3500,  "scratched": false }
  ],
  "totalWinPool": 138000,
  "totalPlacePool": 66000,
  "totalShowPool": 40000,
  "lastUpdate": "2026-05-02T21:45:00Z"
}
```

### Math test cases (must pass)

In `tests/math.probability.test.ts`:

- `probsFromWinPool([50000, 35000, 25000, 12000, 10000, 6000])` → sums to 1, first element ≈ 0.3623
- `probsFromDecimalOdds([3.0, 4.0, 6.0, 8.0, 11.0, 21.0])` → sums to 1 after overround removal

In `tests/math.harville.test.ts`:

- 3-horse race with probs [0.5, 0.3, 0.2]: place probs should be [0.5 + 0.3·0.5/0.7 + 0.2·0.5/0.8, ...] hand-compute and assert.
- All Harville place probs sum to 2.0 (because 2 horses place per race).
- All Harville show probs sum to 3.0 (because 3 horses show).

In `tests/math.payouts.test.ts`:

- A horse with very small place pool relative to total has a high projected payout.
- Floor ≤ mid ≤ ceiling for every horse.
- Floor never falls below $2.10.
- All payouts respect 5% breakage (always end in `.00`, `.10`, `.20`, ...).

In `tests/math.ev.test.ts`:

- Manufactured race where Place pool on horse 1 is artificially small (someone "plunged" the pool elsewhere): edge_floor > 0 expected.
- Race with even pool distribution: edge ≈ 0 across all horses (proves no false positives).

---

## 14. Phased build plan

Build in this order. Each phase is independently testable.

### Phase 1 — Math + types (90 min)
Implement `lib/types.ts` and all of `lib/math/*`. Write all tests in `tests/`. Run `pnpm test` and verify everything passes against `fixtures/sample-6-horse.json`. **No scraping at all in this phase.** This is the most important phase — if the math is wrong, the rest is meaningless.

### Phase 2 — Login + network capture + analyze tooling (45 min)
`scripts/login.ts` (Playwright login + JSONL response capture, per §11) and `scripts/analyze-capture.ts` (parses `auth/network-capture.jsonl`, ranks pool-bearing endpoint candidates per §8). No FDR interaction yet — this phase is pure tooling. Verify both run end-to-end with a hand-crafted JSONL fixture.

### Phase 3 — Endpoint discovery (Russell, ~15 min interactive)
Russell runs `pnpm run login`, logs in by hand, navigates to a race within 10 min of post, lets the page auto-refresh ~3 min, presses Enter. Then `pnpm run analyze-capture` to rank endpoints, then Claude Code (in a fresh session) writes `auth/discovered-endpoints.md` from the analyze output and the JSONL capture. Russell reviews the document. **Pause here. Do not proceed to Phase 4 until `auth/discovered-endpoints.md` exists and has been reviewed.**

### Phase 4 — Adapter + scraper (90 min)
Implement `lib/scraper/adapter.ts` against the discovered shapes, with a contract test using a mocked input matching what Russell documented. Implement `lib/scraper/session.ts`, `lib/scraper/fetch.ts`, `lib/scraper/poller.ts`. Verify a single race round-trips: scraper → adapter → math → analysis cached in store.

### Phase 5 — API routes (30 min)
`app/api/odds/route.ts` returns the cached `RaceAnalysis[]` for all tracked races. `app/api/refresh/route.ts` triggers a force-refresh. `app/api/session/route.ts` returns session health.

### Phase 6 — Dashboard (90 min)
`app/page.tsx`. Race selector, live countdown, table with all columns, highlighting rules, sound alert. Use Tailwind classes. No fancy state management — local React state is fine for v1.

### Phase 7 — Polish (as time permits)
Race-status auto-advance, scratched-horse styling, info modal, takeout-config in URL params for tweaking.

**Total estimated time excluding Russell's discovery step: ~6 hours.** Realistic for one focused Claude Code session.

---

## 15. Known risks and mitigations

| Risk | Mitigation |
|---|---|
| FDR rotates session cookies more aggressively than expected | Re-run `pnpm run login`. Add a `/api/session` health check the dashboard polls every 30s; banner the UI when unhealthy. |
| FDR aggressively logs out idle users (~1 minute per user reports) | The Phase 4 poller must keep the session warm with a lightweight page navigation or page interaction every ~30s during active monitoring; a long-tab-open + only-XHR pattern will be killed mid-race. Mitigation lives in `lib/scraper/poller.ts`: alongside the per-race fetch schedule, run a single keepalive that visits a low-cost page (e.g., the track index) every 30s. If `pnpm run login` ever needs to be re-run mid-session, the dashboard banner from row 1 above triggers. |
| FDR JSON shape changes | Adapter is the only file that breaks. Re-discover §8, edit `adapter.ts`, ship. Math and UI untouched. |
| FDR doesn't expose Place/Show pool dollars in any endpoint | Fall back to decimal-odds probability path. ML drift signal still works. Place/Show actual payouts cannot be computed — UI shows "—" in those cells with a tooltip "pool data unavailable from FDR." |
| FDR rate-limits aggressively | Reduce in-flight concurrency to 1, increase cadence to 30s minimum. Acceptable for 1–2 tracks. |
| Race conditions with simultaneous updates | In-memory store uses last-write-wins on `raceId`; acceptable since refreshes are 5–15s apart. |
| Math divide-by-zero with extreme probs | All math fns have `if denom <= 0` guards. Tests cover edge cases. |
| Computer-assisted wagering shifts pools after gates open | Out of scope for v1 — we stop polling at gate open. v2 could continue polling during the race for next-race signal generation. |
| Russell's FDR account gets flagged for unusual API activity | Single-user, low-frequency polling (~1 req/15s per race) is well under any plausible rate limit and matches normal app traffic. Low risk. |

---

## 16. README content (write this)

```markdown
# derby-edge

Live pari-mutuel arbitrage signal tool. Scrapes FanDuel Racing pool data,
flags +EV Place/Show bets where projected payouts exceed Win-pool-implied fair
prices.

## Quick start

    pnpm install
    pnpm exec playwright install chromium
    pnpm run login              # one-time, log in to FDR by hand
    # (do endpoint discovery — see docs/DISCOVERY.md)
    pnpm dev                    # http://localhost:3000

## Math models

- **Heuristic (Ryan's):** p_place ≈ 2·p_win, p_show ≈ 3·p_win.
- **Harville:** standard order-statistics, exact under independence assumption.

Both shown side by side. Harville is the source of truth for signal classification.

## Configuring tracks

Edit `lib/config.ts`:

    export const TRACKED_TRACKS = ['CD', 'BEL', 'GP'];

## Re-authenticating

If the dashboard banner says "session expired", run:

    pnpm run login

## Files of interest

- `lib/math/` — all probability and payout math, fully unit-tested
- `lib/scraper/adapter.ts` — the only file coupled to FDR's JSON shape
- `docs/DISCOVERY.md` — how to refresh discovery if FDR changes
```

---

## 17. Closing notes for Claude Code

- Russell is a TypeScript-strict shop. No `any`. Use `unknown` where shape is uncertain and narrow.
- All times in ISO 8601 UTC. Convert to local only at render time.
- Tailwind only for styles — no CSS modules, no styled-components.
- Use `tsx` to run scripts (`tsx scripts/login.ts`), don't compile to JS.
- If you need to make an architectural decision not specified above, prefer the simpler / smaller-surface option and document the choice in the code with a comment starting `// DECISION:`.
- After Phase 1 completes, run `pnpm test` and confirm 100% pass before proceeding. The math is the foundation.
- After Phase 4 completes, log a sample `RaceAnalysis` to console and eyeball it before building the UI.

Build it.
