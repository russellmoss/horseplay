# /auto-feature — Automated Feature Planning Pipeline (derby-edge)

You are an orchestrator. Your job: take a feature request, run a full exploration and planning pipeline, get adversarial review, and produce a refined implementation guide ready for execution. You do NOT execute the guide — that happens in a fresh context after this command completes.

**Feature request:** $ARGUMENTS

---

## RULES

1. Execute phases in strict order. Do not skip phases.
2. Write all artifacts to disk in the project root. Later phases read them from disk.
3. Print a progress header at the start of each phase.
4. Do not ask the user anything until the Human Input Gate in Phase 4.
5. If a phase fails (MCP timeout, test baseline red, missing file), report clearly and stop.

---

## PHASE 1: EXPLORATION

Spawn an agent team with 3 teammates **in parallel** (single message, multiple Agent tool calls). Each gets a self-contained brief.

### Teammate 1 — code-inspector

Brief: "First, read `derby-edge-IMPLEMENTATION.md` §4 (project structure) and §5 (types), and `CLAUDE.md` for conventions — use these as a starting point. If what you find in the code contradicts these docs, trust the code, proceed with what the code shows, and note the discrepancy.

Investigate the codebase for the following feature: $ARGUMENTS

Find:
- Every TypeScript type in `lib/types.ts` that needs new fields
- Every file that CONSTRUCTS objects of those types (the adapter, fixture loaders, the math facade `analyzeRace()`, test helpers)
- Every math function in `lib/math/` affected
- Whether the scraper adapter (`lib/scraper/adapter.ts`) needs new fields from FDR
- Which API route(s) in `app/api/` change and what their new shape looks like
- Which dashboard columns or highlighting rules in `app/page.tsx` change
- Which `tests/*.test.ts` files need new cases

Save findings to `code-inspector-findings.md` in the project root."

### Teammate 2 — math-verifier

Brief: "First, read `derby-edge-IMPLEMENTATION.md` §6 and `.claude/skills/derby-math/SKILL.md` (eight invariants and every known pitfall). Run `pnpm test` to establish a green baseline; if red, stop and report.

Verify the math layer for the following feature: $ARGUMENTS

For every math change implied by the feature:
- Trace it against ALL EIGHT invariants in `derby-math/SKILL.md`
- For each pitfall in `derby-math/SKILL.md`, check whether the proposal triggers it
- Identify formulas needing new tests, with hand-computed expected values
- Identify fixtures needing to be added or extended
- Decide whether the change warrants council review (always yes if `harville.ts` or `payouts.ts` formulas change)

Save findings to `math-verifier-findings.md` in the project root."

### Teammate 3 — pattern-finder

Brief: "First, read `CLAUDE.md`, `derby-edge-IMPLEMENTATION.md` §3 / §9 / §10 / §12, and `.claude/skills/derby-math/SKILL.md`.

Find patterns for the following feature: $ARGUMENTS

Trace how existing similar features flow end-to-end:
- ISO 8601 UTC time conventions (internal everywhere; convert at render only)
- Null-vs-zero for missing data
- Decimal odds internal; fractional only at IO boundaries (`lib/math/odds.ts`)
- Math facade — callers route through `analyzeRace()`, never directly into `lib/math/*` files
- Adapter as the only FDR-coupled file
- Config-driven cadences and takeouts (no hardcoded magic numbers in scraper or math)
- Polling cadence ladder in `lib/scraper/poller.ts`
- Signal evaluation order: slam_dunk > lean > drift > none
- Dashboard sound-alert ref-tracking pattern

Flag pattern drift between existing files that should match.

Save findings to `pattern-finder-findings.md` in the project root."

### Synthesis

When all three teammates complete, read all three findings files and produce `exploration-results.md` with:

1. **Pre-Flight Summary** — 5–10 line plain-English summary. Print to console so the user sees it scroll by.
2. **Subsystems touched** — math / scraper / store / API / dashboard, one-line scope per subsystem.
3. **Type changes** — exact fields to add to each interface in `lib/types.ts`.
4. **Construction site inventory** — every code location that constructs objects of modified types, with file:line.
5. **Math impact** — which formulas change, which invariants are at risk, new tests required.
6. **Scraper / adapter impact** — new FDR fields needed? Rediscovery via `/discover-fdr` required?
7. **Dashboard impact** — new columns, new signals, new highlighting.
8. **Recommended phase order** — based on dependencies (math → types → scraper → API → dashboard).
9. **Risks and blockers** — math invariant violations, missing fixtures, FDR shape unknowns.

Proceed immediately to Phase 2.

---

## PHASE 2: BUILD GUIDE

Follow the build-guide skill (`.claude/skills/build-guide/SKILL.md`).

Read all four exploration documents and produce `agentic_implementation_guide.md` with:

- Pre-flight checklist (`pnpm test`, `pnpm exec tsc --noEmit`)
- Phase 1: Math (always first if math touched — every invariant explicitly asserted)
- Phase 2: Type definitions (intentionally breaks build — error count becomes the construction-site checklist)
- Phase 3: Scraper adapter (only if FDR shape changes)
- Phase 4: Math facade (`lib/math/index.ts`)
- Phase 5: Store / poller (if cadence or state shape changes)
- Phase 6: API routes
- Phase 7: Dashboard
- Phase 8: UI / UX validation (requires user)

Every phase must have:

- A validation gate with concrete `pnpm test` / `tsc --noEmit` / grep commands
- A STOP AND REPORT checkpoint
- Exact file paths and exact field names

**derby-edge–specific rules**:

- TypeScript strict — no `any`, use `unknown` and narrow.
- Tailwind only.
- All times ISO 8601 UTC internally.
- Pure functions in `lib/math/` — no I/O, no `Date.now()`, no globals.
- Missing data is `null`, never `0` or `undefined`.
- Decimal odds internally; fractional via `lib/math/odds.ts` at IO boundaries.
- Adapter (`lib/scraper/adapter.ts`) is the only file coupled to FDR JSON shape.
- Config-driven cadences / takeouts — no hardcoded numbers in scraper or math.
- All `lib/math/` callers go through `analyzeRace()` — never direct file imports outside the math layer.
- For breakage, `Math.floor(x * 10) / 10`, then `max(2.10, breaked)` — never `Math.round`.
- For Harville show prob, ordered pairs (no `j < k` constraint) with conditional renormalization.
- Floor pairs with largest companion pool; ceiling with smallest.

Write the guide to `agentic_implementation_guide.md`, then proceed immediately to Phase 3.

---

## PHASE 3: ADVERSARIAL COUNCIL REVIEW

Send the implementation guide and exploration results to **Codex** and **Gemini** for adversarial review using council-mcp tools. Send **separate** prompts — do NOT use `ask_all`.

**Note: This project uses `ask_codex` (free, via Codex CLI), not `ask_openai`.**

### Prepare the payload

Read and concatenate:
- `derby-edge-IMPLEMENTATION.md` (the spec — short enough to include verbatim)
- `.claude/skills/derby-math/SKILL.md` (math invariants and pitfalls)
- `exploration-results.md`
- `code-inspector-findings.md`
- `math-verifier-findings.md`
- `pattern-finder-findings.md`
- `agentic_implementation_guide.md`

### Send to Codex

Use `ask_codex`.

**System prompt**: "You are a senior TypeScript engineer reviewing an implementation plan for a Next.js 14 / TypeScript / Vitest live pari-mutuel arbitrage tool. Your job is adversarial — find what will break."

**Prompt focus** (full text in `.claude/commands/council.md` Prompt A):
- Type safety: are ALL construction sites covered for every interface change?
- Math invariant coverage: which of the 8 invariants does the plan assert vs skip?
- Harville third-place sum: ordered pairs with conditional renormalization?
- Floor / ceiling pairing: largest pool for floor, smallest for ceiling?
- NaN / Infinity guards on every new math path?
- Scraper-adapter contract: only `adapter.ts` knows FDR JSON shape?
- Config-driven values: any hardcoded magic numbers outside `lib/config.ts`?
- Phase ordering and validation gates (concrete commands?)

**Required response format**:
```
## CRITICAL (will break the build, silently corrupt data, or produce systematically wrong dashboard numbers)
## SHOULD FIX (won't break the build but will cause problems in practice)
## DESIGN QUESTIONS (number each one — include tradeoffs)
```

### Send to Gemini

Use `ask_gemini` (thinking enabled by default).

**System prompt**: "You are a senior engineer reviewing an implementation plan for derby-edge — a math-heavy live pari-mutuel arbitrage tool. Your job is to find logic errors and edge cases the build plan might miss."

**Prompt focus** (full text in `.claude/commands/council.md` Prompt B):
- Re-derive any modified or new formula from first principles
- Signal classification ordering (slam_dunk > lean > drift > none, evaluated in order)
- Edge cases: n=1, n=2, all-zero pools, p ≥ 0.99, all-scratched, NaN inputs
- Probability source priority (win_pool → decimal_odds → uniform fallback)
- Dashboard UX: signal distinctness, sound-alert ref-tracking, scratched-row greying
- Drift signal handling for null ML or null current

**Same required response format as Codex.**

### Cross-checks (you do these yourself)

1. Every interface change in the guide has all construction sites covered (cross-ref code-inspector findings).
2. Every math invariant in scope is asserted by at least one new or existing test.
3. No hardcoded number exists outside `lib/config.ts`.
4. No `lib/math/*` import outside the math layer except via `analyzeRace()`.
5. The adapter is still the only FDR-coupled file.

### Write council-feedback.md

Write `council-feedback.md` with:

- **Critical Issues** — merged and deduplicated from both reviewers plus your cross-checks
- **Should Fix** — merged
- **Design Questions** — merged, numbered sequentially
- **Suggested Improvements** — merged, ranked by impact vs effort
- **Raw Responses** — full text from each reviewer, labeled

Proceed immediately to Phase 4.

---

## PHASE 4: SELF-TRIAGE AND REFINEMENT

Read `council-feedback.md` and triage EVERY item into one of three buckets.

### Bucket 1 — APPLY AUTONOMOUSLY

- Missing construction sites → add files the code-inspector findings confirm exist
- Wrong type / field names → correct against `lib/types.ts`
- Missing math invariant assertions → add explicit test cases
- Missing NaN / Infinity guards → add `denom <= 0` and `pool === 0` checks
- Inverted floor/ceiling pairing → swap comparator
- `Math.round` for breakage → replace with `Math.floor(x * 10) / 10`
- Hardcoded magic numbers → move to `lib/config.ts`
- Direct `lib/math/*` imports outside math layer → route through `analyzeRace()`
- Naive `new Date()` not ISO'd → fix to `.toISOString()`
- Wrong imports / file paths
- Phase ordering errors
- Missing validation gates → replace with concrete commands

**Apply all Bucket 1 fixes directly to `agentic_implementation_guide.md`.**

### Bucket 2 — NEEDS HUMAN INPUT

- Threshold tuning (`SIGNAL_LEAN_THRESHOLD`, `SIGNAL_DRIFT_THRESHOLD`)
- Display formatting choices (decimals shown, fractional vs decimal odds in UI, color choices outside spec)
- Sort-order preferences
- Scope decisions
- Anything flagged as a "Design Question" by either reviewer

### Bucket 3 — NOTE BUT DON'T APPLY

- Scope expansions (exotics, multi-track parallelization, historical analytics) — out of v1 scope per IMPLEMENTATION.md §2
- Alternative architectures where current is valid (DB-backed store) — v1 is in-memory by spec
- Performance optimizations not needed at current scale

### Apply and Log

1. Apply all Bucket 1 fixes to `agentic_implementation_guide.md`.
2. Update any validation gates affected by the fixes.
3. Append a **Refinement Log** to the bottom of the guide:
   - Every Bucket 1 change (what changed, why, which reviewer flagged it)
   - Every Bucket 3 item (what it was, why deferred)
4. Self-review the updated guide for internal consistency.
5. Write triage details to `triage-results.md`.

### Human Input Gate

**IF Bucket 2 is empty:**

Print:
```
✅ Council review complete. All feedback resolved autonomously.

[N] fixes applied to the implementation guide (see Refinement Log).
[M] items noted but deferred.

The guide is ready for execution. Recommended next steps:
1. Run /compact to clear context
2. Then: "Execute agentic_implementation_guide.md phase by phase. Stop at each validation gate and report results before proceeding. Start with Pre-Flight."
```

**STOP. Do not proceed further.**

**IF Bucket 2 has items:**

Print:
```
🛑 Human Input Required

The council raised [N] questions that need your judgment.
[M] other issues were resolved autonomously (see Refinement Log).
[K] items noted but deferred.

Please answer each question:

Q1: [question]
    Context: [why it matters, what the tradeoffs are]

Q2: [question]
    ...

After you answer, I'll apply your decisions to the guide.
```

**STOP. WAIT FOR THE USER TO RESPOND.**

When the user responds, apply their answers to `agentic_implementation_guide.md`, add each decision to the Refinement Log with rationale, then print:

```
✅ Guide updated with your decisions.

The guide is ready for execution. Recommended next steps:
1. Run /compact to clear context
2. Then: "Execute agentic_implementation_guide.md phase by phase. Stop at each validation gate and report results before proceeding. Start with Pre-Flight."
```

**STOP. Do not proceed further.**

---

## FILES PRODUCED

| File | Phase | Purpose |
|------|-------|---------|
| `code-inspector-findings.md` | 1 | Types, construction sites, file dependencies |
| `math-verifier-findings.md` | 1 | Math baseline, invariants at risk, pitfalls in scope |
| `pattern-finder-findings.md` | 1 | Established patterns (time, null, math facade, adapter, signals) |
| `exploration-results.md` | 1 | Synthesized exploration findings |
| `agentic_implementation_guide.md` | 2 (created), 4 (refined) | Phased execution plan with validation gates |
| `council-feedback.md` | 3 | Codex + Gemini adversarial review |
| `triage-results.md` | 4 | Categorized triage of council feedback |

---

## FAILURE MODES

- **MCP tool timeout (council)**: Retry once. If both retries fail for a provider, proceed with whichever responded. If both fail, STOP and tell the user.
- **Test baseline red (math-verifier)**: STOP. Don't compound math feedback on top of pre-existing failures.
- **Agent teammate failure**: If one of the three exploration agents fails, report which one and what it couldn't do. Do not proceed — the exploration is incomplete.
- **No `lib/` yet (project not built)**: This command is for adding features to an existing build. If `lib/` doesn't exist yet, tell the user to complete Phases 1–7 of `derby-edge-IMPLEMENTATION.md` first.

---

## BEGIN

Start Phase 1 now. The feature to build is: **$ARGUMENTS**
