# /refine — Apply Council Feedback to Implementation Plan (derby-edge)

You are applying cross-LLM review feedback to a derby-edge implementation plan. Read the feedback, triage it, apply what's clear, and ask about what isn't.

## Prerequisites

These files must exist:

1. An implementation plan (`agentic_implementation_guide.md` or similar)
2. `council-feedback.md` (created by `/council`)

Also read if they exist (they inform triage decisions):

- `code-inspector-findings.md` — verify construction-site fixes against the real file list
- `math-verifier-findings.md` — verify math fixes against the invariant checklist
- `pattern-finder-findings.md` — verify pattern fixes against established conventions
- `derby-edge-IMPLEMENTATION.md` — the authoritative spec (always wins on conflict)
- `.claude/skills/derby-math/SKILL.md` — math pitfalls and invariants

If the implementation plan or `council-feedback.md` is missing, tell the user and stop.

## Step 1: Read everything

- The implementation plan
- `council-feedback.md`
- All supporting exploration docs above
- The conversation history (the user's answers to design questions are in the conversation above)

## Step 2: Triage

Sort every piece of feedback into one of three buckets.

### Bucket 1 — Apply immediately (no human input needed)

- Missing construction sites → add the files the code-inspector findings confirm exist
- Wrong type names or interface fields → correct against `lib/types.ts`
- Missing math invariant assertions → add explicit test cases
- Missing NaN / Infinity guards → add `denom <= 0` and `pool === 0` checks
- Inverted floor/ceiling pairing → swap the comparator
- `Math.round` for breakage → replace with `Math.floor(x * 10) / 10`
- Hardcoded magic numbers → move to `lib/config.ts` and read from `.env`
- Direct `lib/math/*` imports outside the math layer → route through `analyzeRace()`
- Naive `new Date()` not converted to ISO → fix to `.toISOString()`
- Missing or wrong file paths and import paths
- Phase ordering errors
- Missing or weak validation gates → replace with concrete commands

### Bucket 2 — Apply based on user's answers

- Threshold tuning (`SIGNAL_LEAN_THRESHOLD`, `SIGNAL_DRIFT_THRESHOLD`, etc.) — defaults in spec but user may have a preference
- Display formatting choices (decimals shown, fractional vs decimal odds in UI, color choices outside the spec'd green/yellow/red)
- Sort-order preferences (program # vs current odds vs edge)
- Scope decisions (should this also surface in another race view?)
- Anything flagged as a "Design Question" in `council-feedback.md`

### Bucket 3 — Note but don't apply

- Scope expansions (exotics, multi-track parallelization, historical analytics) — out of v1 scope per IMPLEMENTATION.md §2
- Alternative architectures where the current is valid (e.g., DB-backed store) — v1 is in-memory by spec
- Performance optimizations not needed at current scale (n ≤ 20 horses, 1–2 tracks)
- Items the user explicitly declined when answering design questions

## Step 3: Apply changes

Edit the implementation plan directly:

- Find the exact location of each issue (phase number, step number)
- Make the change in place — don't just add a note, fix the actual instruction
- If the change affects a validation gate, update the gate too
- If the change affects phase ordering, reorder
- If a construction site was missing, add it to the correct phase with exact file path from `code-inspector-findings.md`
- If a math invariant was missing, add the explicit test assertion

**derby-edge-specific rules:**

- For math invariants, always reference `.claude/skills/derby-math/SKILL.md` by invariant number (1–8) so the executing agent can verify against a checklist.
- For breakage, use `Math.floor(x * 10) / 10` — never `Math.round`. Floor BEFORE applying the $2.10 minimum.
- For floor/ceiling pairing, floor pairs with the **largest** companion pool, ceiling with the **smallest**. Counterintuitive — keep one hand-computed example in the test plan.
- For Harville show probability, the loop must iterate **ordered** pairs (no `j < k` constraint) with conditional renormalization.
- The scraper adapter (`lib/scraper/adapter.ts`) is the ONLY file allowed to reference FDR JSON keys. Pull anything else into a typed boundary.
- Cadences and takeouts come from `lib/config.ts` reading `.env` — no inline numbers.
- The math facade (`analyzeRace()`) is the ONLY entry point to `lib/math/` from outside the math layer.

## Step 4: Append a Refinement Log

At the bottom of the implementation plan, append:

```
---

## Refinement Log

**Date**: [today's date]
**Source**: council-feedback.md (Codex + Gemini cross-validation)

### Changes Applied
- [Each change: what was wrong, what was fixed, which reviewer caught it, which phase/step]

### Design Decisions
- [Each design question and the user's answer with rationale]

### Noted but Not Applied
- [Items that were acknowledged but deferred, with reason — typically out-of-scope for v1]
```

## Step 5: Self-review

Read the entire updated plan top to bottom. Verify:

- Phase ordering is still consistent (no step references something from a later phase)
- No step references a file or function renamed/moved by an earlier fix
- Validation gates still match what the steps produce
- Every TypeScript interface change still lists ALL construction sites
- Every math invariant in scope is asserted by at least one test
- All file paths exist or are scheduled to be created in an earlier phase
- The Refinement Log accurately reflects all changes

## Step 6: Report

Tell the user:

- **Changes applied** (bullet list with phase/step references)
- **Design decisions made** (based on the user's answers)
- **Noted but not applied** (with reasons)
- "The plan is updated. You can run `/council` again for another review round, or proceed to execution."

**Stop here. Do not begin executing the plan. Wait for the user.**
