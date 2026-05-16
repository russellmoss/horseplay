---
name: new-feature
description: "Kick off a new derby-edge feature with parallel exploration. Use when adding signals, models, scraper adapters for new tracks, dashboard columns, or polling/cadence changes. Spawns an agent team for code inspection, math verification, and pattern analysis."
---

# New derby-edge Feature — Parallel Exploration

You are starting the exploration phase for a new derby-edge feature. The user describes what they want to add. Your job is to run a parallel investigation and produce a comprehensive exploration report.

## Step 1: Understand the Feature

If not already clear from the user's request, ask:

- What's being added — a new signal, a new math model, a new scraper source (track), a new dashboard column, or something else?
- Which subsystems are affected — math, scraper adapter, polling cadence, store, API, dashboard?
- Are there specific FDR endpoints or fixture races they already know about?

Do NOT ask more than necessary. Infer what you can from the request.

## Step 2: Spawn the Agent Team (in parallel)

Spawn three agents in a single message, each with a self-contained brief:

### Teammate 1 — code-inspector

Brief: "First read `derby-edge-IMPLEMENTATION.md` §4–§5 and `CLAUDE.md` for conventions. Then investigate the codebase for the following feature: $ARGUMENTS

Find:
- Every TypeScript type in `lib/types.ts` that needs new fields
- Every file that CONSTRUCTS objects of those types (the adapter, fixture loaders, the math facade `analyzeRace()`, test helpers)
- Every math function in `lib/math/` that's affected
- Whether the scraper adapter (`lib/scraper/adapter.ts`) needs to expose new fields from FDR
- Which API route(s) in `app/api/` change and what their new shape looks like
- Which dashboard columns or highlighting rules in `app/page.tsx` change
- Which `tests/*.test.ts` files need new cases

Save findings to `code-inspector-findings.md` in the project root."

### Teammate 2 — math-verifier

Brief: "First read `derby-edge-IMPLEMENTATION.md` §6 and `.claude/skills/derby-math/SKILL.md`. Then verify the math layer for the following feature: $ARGUMENTS

Run `pnpm test` to establish a green baseline. If the baseline is red, stop and report.

For every math change implied by the feature:
- Trace it against ALL EIGHT invariants in `derby-math/SKILL.md`
- For each pitfall in `derby-math/SKILL.md`, check whether the proposal triggers it
- Identify which formulas need new tests, with hand-computed expected values
- Identify which fixtures need to be added or extended
- Decide whether the change warrants council review (always yes if `harville.ts` or `payouts.ts` formulas themselves change)

Save findings to `math-verifier-findings.md` in the project root."

### Teammate 3 — pattern-finder

Brief: "First read `CLAUDE.md`, `derby-edge-IMPLEMENTATION.md` §3 / §9 / §10 / §12, and `.claude/skills/derby-math/SKILL.md`. Then find patterns for the following feature: $ARGUMENTS

Trace how existing similar features flow end-to-end:
- Time / date conventions (ISO 8601 UTC internally)
- Null-vs-zero for missing data
- Decimal odds internally; fractional only at IO boundaries
- Math facade — do callers go through `analyzeRace()` or import math files directly?
- Adapter as the only FDR-coupled file
- Config-driven cadences and takeouts (no hardcoded numbers)
- Polling cadence ladder in `poller.ts`
- Signal ordering: slam_dunk > lean > drift > none
- Dashboard sound-alert ref-tracking pattern

Flag any pattern drift between existing files that should match.

Save findings to `pattern-finder-findings.md` in the project root."

## Step 3: Synthesize

When all three agents complete, read all three findings files and produce `exploration-results.md`:

1. **Pre-Flight Summary** — 5-10 line plain-English summary. Print to console so the user sees it scroll by.
2. **Subsystems touched** — math / scraper / store / API / dashboard, with one-line scope per subsystem.
3. **Type changes** — exact fields to add to each interface in `lib/types.ts`.
4. **Construction site inventory** — every code location that constructs objects of modified types.
5. **Math impact** — which formulas change; which invariants are at risk; new tests required.
6. **Scraper / adapter impact** — does FDR need a new field? Is rediscovery (`/discover-fdr`) required?
7. **Dashboard impact** — new columns, new signals, new highlighting rules.
8. **Recommended phase order** — based on dependencies. (Math always first; types next; scraper before API; API before dashboard.)
9. **Risks and blockers** — math invariant violations, missing fixtures, FDR shape unknowns.

## Step 4: Present

Tell the user:

- "Exploration complete. [N] files to modify. [Blockers, if any.]"
- "Run `/auto-feature` to continue with build-guide + council + refine, or investigate further first."

**Stop here. Don't begin building.**
