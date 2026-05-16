---
name: build-guide
description: "Build an agentic implementation guide from exploration results for derby-edge. Use after /new-feature exploration completes. Creates a phased, validation-gated guide that another agent can execute step-by-step."
---

# Build derby-edge Implementation Guide

You are building an implementation guide from completed exploration results. The guide must be executable by a single Claude Code agent working phase-by-phase with concrete validation gates.

## Prerequisites

Before starting, verify these exploration files exist:

- `exploration-results.md`
- `code-inspector-findings.md`
- `math-verifier-findings.md`
- `pattern-finder-findings.md`

Read ALL of them. The exploration results synthesize, but the raw findings have file paths, line numbers, and exact field names you'll need.

## Guide Structure

Create `agentic_implementation_guide.md` in the project root with this structure.

### Header

# Agentic Implementation Guide: [Feature Name]

## Reference Documents
- `derby-edge-IMPLEMENTATION.md` (authoritative spec)
- `.claude/skills/derby-math/SKILL.md` (math invariants)
- `exploration-results.md` (this feature's findings synthesis)

The completed exploration files are the single source of truth for what this guide changes.

## Feature Summary
[Table: subsystem affected → what changes → why]

## Architecture Rules (carried from CLAUDE.md and IMPLEMENTATION.md)

- TypeScript strict — no `any`, use `unknown` and narrow.
- Tailwind only for styles.
- All times ISO 8601 UTC internally; convert at render time.
- Pure functions in `lib/math/` — no I/O, no `Date.now()`, no globals.
- Missing data is `null`, never `0` or `undefined`.
- Decimal odds internally; fractional only at IO boundaries.
- Adapter (`lib/scraper/adapter.ts`) is the only file coupled to FDR JSON shape.
- Config-driven cadences / takeouts — no hardcoded `15`s or `0.17`s.
- Math callers route through `analyzeRace()`; never import individual `lib/math/*` files outside the math layer.

## Pre-Flight Checklist

```bash
pnpm test
pnpm exec tsc --noEmit
```

If pre-existing failures, stop and report. Do not proceed with a broken baseline.

### Phase Pattern

Every phase follows this template:

# PHASE N: [Title]

## Context
[Why this phase exists, which subsystem(s) it touches]

## Step N.1: [Specific action]
**File**: [exact path]
[Exact code to add/change, with before/after when helpful]

## PHASE N — VALIDATION GATE
```bash
pnpm test -- <relevant pattern>
pnpm exec tsc --noEmit
# plus any specific grep that confirms the change landed
```

**Expected**: [What the output should look like]

**STOP AND REPORT**: Tell the user:
- "[Summary of what was done]"
- "[Test count delta, error count delta]"
- "[What's next]"
- "Ready to proceed to Phase [N+1]?"

### Standard Phase Order for derby-edge

Pick only the phases relevant to the feature.

**Phase 1 — Math (highest risk, always first if math touched)**
- Implement or modify pure functions in `lib/math/`.
- Add fixture entries in `fixtures/` for any new code path.
- Add or update tests in `tests/math.*.test.ts` — every invariant in `.claude/skills/derby-math/SKILL.md` must be verified.
- Validation gate: `pnpm test -- math` green, all eight invariants asserted.
- **For any change to `harville.ts` or `payouts.ts` formulas**: include a checkpoint reminder to run /council on those files before declaring the phase done.

**Phase 2 — Type definitions (intentionally breaks build)**
- Update interfaces in `lib/types.ts` with new REQUIRED fields.
- TypeScript errors after this phase become the construction-site checklist for Phase 3+.
- Validation gate: count the errors and list which files have them. The list MUST match the construction site inventory from `code-inspector-findings.md`.

**Phase 3 — Scraper adapter (if FDR shape changes)**
- Update `lib/scraper/adapter.ts` to expose new fields from FDR.
- If new fields require rediscovery, halt and direct the user to run `/discover-fdr`.
- Add a contract test in `tests/adapter.test.ts` against a documented FDR response shape.
- Validation gate: contract test passes; no other file in the repo references FDR JSON keys.

**Phase 4 — Math facade (`lib/math/index.ts`)**
- Wire new math into `analyzeRace()`.
- Validation gate: every field in `HorseAnalysis` is populated by the facade for every horse in the sample fixture.

**Phase 5 — Store / poller (if cadence or state shape changes)**
- Update `lib/store.ts` and/or `lib/scraper/poller.ts`.
- Validation gate: a single race round-trips: scraper → adapter → math → store, and the cached `RaceAnalysis` matches the expected shape.

**Phase 6 — API routes (`app/api/odds/`, `app/api/refresh/`, `app/api/session/`)**
- Update route handlers for new payload shape.
- Validation gate: hit the route locally; response matches `RaceAnalysis[]` (or whatever new shape is documented).

**Phase 7 — Dashboard (`app/page.tsx`)**
- New columns, signals, highlighting rules, sound-alert hooks.
- Validation gate: `pnpm dev`; user verifies in browser. (UI verification requires human — see Phase 8.)

**Phase 8 — UI / UX validation (requires human)**
- List concrete test groups for the user. Each group: steps to perform, what to verify, what to compare against.
- Cover: green slam_dunk highlight, yellow lean, red drift border, sound alert on transition, scratched-row greying, scrolling between races.

### Critical Rules for Guide Quality

1. **Math invariants are non-negotiable.** Every phase that touches `lib/math/` must list which of the eight invariants it verifies. If even one isn't asserted, the gate isn't strong enough.
2. **Construction sites must be complete.** Cross-reference `code-inspector-findings.md`. If 4 sites construct `Race`, all 4 must be updated.
3. **Validation gates have concrete commands.** `pnpm test`, `pnpm exec tsc --noEmit`, `grep` for specific identifiers — not "verify the change".
4. **Type-error counts decrease.** Phase 2 deliberately breaks; subsequent phases drive the count to zero.
5. **No hardcoded magic numbers.** Anything tunable goes in `lib/config.ts` and is sourced from `.env`.
6. **Imports merge, never duplicate.** "Add X to the existing import from Y" — not a second import line.
7. **Council review for risky math.** If Phase 1 touches `harville.ts` or `payouts.ts`, the guide must include "run /council on these files before Phase 4" as an explicit step.

### Troubleshooting Appendix (always include)

- **Probabilities don't sum to 1**: overround stripping missing in `probsFromDecimalOdds`, or scratched horses not filtered.
- **Payouts ending in odd cents**: `Math.round` instead of `Math.floor(x*10)/10` for breakage.
- **Floor > ceiling**: floor/ceiling pairing inverted (floor pairs with **largest** companion pool).
- **NaN in output**: missing `denom <= 0` guard or `pool === 0` guard. Return `null`, not `0`.
- **Session 401 / 403**: storage state expired; tell the user to re-run `pnpm run login`.
- **FDR endpoint 404**: schema may have changed; tell the user to re-run `/discover-fdr`.

## Output

Save the guide as `agentic_implementation_guide.md` in the project root.

**STOP AND REPORT**: Tell the user:

- "Implementation guide complete: `agentic_implementation_guide.md`"
- "[N] phases, [M] files to modify, [K] math invariants to verify"
- "**Recommended next step**: run `/council` for Codex + Gemini cross-validation before execution. Look for: missing construction sites, math invariant gaps, scraper-adapter assumptions."
- "When validated, run: `Read agentic_implementation_guide.md top to bottom. Execute each phase sequentially. Stop and report at every gate. Start with Pre-Flight.`"
