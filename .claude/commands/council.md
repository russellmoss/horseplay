# /council — Cross-LLM Review of Implementation Plan (derby-edge)

<!-- Tailored for: derby-edge — live pari-mutuel arbitrage signal tool -->
<!-- Reviewers: Codex (free, via Codex CLI) + Gemini -->
<!-- OpenAI API is intentionally NOT used — Codex CLI uses your existing ChatGPT subscription -->

You are running a cross-validation workflow for derby-edge. Your job is to send the implementation plan and supporting exploration documents to **Codex** and **Gemini** for adversarial review, then synthesize their feedback.

## Step 1: Verify MCP Server

Confirm you can see the `ask_codex`, `ask_gemini`, and `ask_all` tools from `council-mcp`. If not, tell the user:

"The council-mcp MCP server isn't available. To set it up:

1. **Verify the project's `.mcp.json` is valid** and points at `C:/Users/russe/Documents/Council_of_models_mcp/dist/index.js`. (Already configured for this project.)

2. **Verify Gemini API key is in `.env`**:
   ```
   GEMINI_API_KEY=AI...
   ```
   council-mcp reads `.env` from the project root via `dotenv/config`.

3. **Codex CLI auth**: Codex CLI uses its own auth (`codex login`) — no API key needed for `ask_codex`. If `codex --version` fails, install via `npm i -g @openai/codex` and run `codex login`.

4. **Start a new Claude Code session** and run `/council` again."

Stop here if the server isn't available.

## Step 2: Find and read all documents

Read these files in priority order. The implementation guide is required; the others provide essential context for the reviewers.

**Required:**
- `agentic_implementation_guide.md` (or any file matching `*implementation*guide*.md` or `*build*guide*.md`)

**Supporting exploration docs (read all that exist):**
- `code-inspector-findings.md` — TypeScript construction sites and interface dependencies
- `math-verifier-findings.md` — math baseline, invariants at risk, pitfalls in scope
- `pattern-finder-findings.md` — established codebase conventions
- `exploration-results.md` — synthesized exploration findings

**Project context (always read):**
- `derby-edge-IMPLEMENTATION.md` — the authoritative spec
- `CLAUDE.md` — project conventions
- `.claude/skills/derby-math/SKILL.md` — math invariants and pitfalls

**If any related files exist also read:**
- `package.json`
- Any existing `council-feedback.md` (to see what was already reviewed)

If no implementation guide is found, ask the user: "Which file should I send for cross-LLM review?"

**Important**: Do NOT read `.env`, `auth/storageState.json`, `node_modules/`, `.next/`, `dist/`, `.git/`, or any file likely to contain secrets.

## Step 3: Investigate the project (silent)

Before constructing prompts, silently investigate:

- Top-level directory listing and `lib/` directory listing
- The current shape of `lib/types.ts` (the wide types — `Race`, `Horse`, `HorseAnalysis`, `RaceAnalysis`)
- The current shape of `lib/math/index.ts` (the facade)
- The current shape of `lib/scraper/adapter.ts` (the only FDR-coupled file)

Keep investigation bounded — read these files for context, not entire source trees.

## Step 4: Send review prompts

Tell the user: "Sending to Codex and Gemini for cross-validation..."

Send these two prompts **in parallel** using `ask_codex` and `ask_gemini` separately (NOT `ask_all` — each prompt is tailored to the provider's strengths).

### Prompt A — `ask_codex`

Focus: **Type safety, construction sites, math correctness, scraper-adapter contract**

```
You are a senior TypeScript engineer reviewing an implementation plan for derby-edge — a live pari-mutuel arbitrage signal tool. Your job is adversarial: find what will break.

Stack: Next.js 14 App Router, TypeScript strict, Tailwind, Vitest, Playwright (for FanDuel Racing scraping). Single-user, runs locally on the developer's machine. No DB, in-memory state. The math layer (lib/math/*) is the foundation — bugs there are silent: the dashboard renders plausible-looking but systematically wrong numbers.

You have been given:
- **derby-edge-IMPLEMENTATION.md**: the authoritative spec (especially §6 math, §9 adapter, §12 dashboard)
- **CLAUDE.md**: project conventions
- **.claude/skills/derby-math/SKILL.md**: 8 required math invariants and every known pitfall
- **Implementation Guide**: the step-by-step plan an agent will execute phase-by-phase
- **Code Inspector Findings**: every TypeScript interface, every construction site, all import dependencies
- **Math Verifier Findings**: math baseline, which invariants are at risk, pitfalls in scope, required new tests
- **Pattern Finder Findings**: established conventions and any pattern drift detected

Review for:

1. **Missing construction sites**: For every TypeScript interface change, cross-reference against the code-inspector findings. Does the plan update EVERY file that constructs an object of that type? Missing one breaks the build.

2. **Math invariant coverage**: For every change in `lib/math/`, list which of the 8 invariants the plan asserts and which it skips. Skipped invariants are bugs waiting to happen.

3. **Harville third-place sum convention**: If the plan touches `harville.ts`, verify the show-prob loop iterates **ordered** pairs (no `j < k` constraint) with conditional renormalization. The unordered convention is a known wrong-answer pitfall.

4. **Floor / ceiling pairing**: For projected payouts, floor pairs with the **largest** companion pool, ceiling with the **smallest**. The plan must not invert this.

5. **No NaN / no Infinity**: Every new math path needs explicit guards for `denom <= 0` and `pool === 0`. Returns `null` for unknowable, never `0`.

6. **Scraper-adapter contract**: If the plan changes what fields are read from FDR, does it update `lib/scraper/adapter.ts` AND nothing else outside it? The adapter is the only file allowed to know FDR JSON shape.

7. **Config-driven values**: Any hardcoded number (cadence, takeout, threshold) outside `lib/config.ts` is a smell.

8. **Phase ordering and validation gates**: Are gates concrete (commands that produce checkable output)? Can each phase execute given what prior phases produce?

MANDATORY CHECKS:
- All math callers go through `lib/math/index.ts`'s `analyzeRace()` facade — never direct imports of `harville` / `payouts` from outside `lib/math/`.
- Times stay ISO 8601 UTC internally — `new Date()` not immediately `.toISOString()`'d is a smell.
- Missing fields are `null`, never `0` or `undefined`.
- Decimal odds internally; fractional/string only at IO boundaries via `lib/math/odds.ts`.
- All payouts pass through breakage (`Math.floor(x * 10) / 10`) and the `max(2.10, breaked)` floor.

Structure your response as:
- **CRITICAL** (will break the build, silently corrupt data, or cause systematically wrong dashboard numbers — must fix before execution)
- **SHOULD FIX** (won't break the build but will cause problems in practice)
- **DESIGN QUESTIONS** (need the builder's input — include tradeoffs for each option)

For each issue: state what's wrong, which phase/step it's in, and what the fix should be.

[FULL DOCUMENT TEXT BELOW]
```

Append the FULL text of all documents after the prompt. Do not summarize or truncate.

Tell the user: "Codex review sent. Waiting for response..."

### Prompt B — `ask_gemini`

Focus: **Math correctness from first principles, edge cases, signal classification, dashboard UX**

```
You are a senior engineer reviewing an implementation plan for derby-edge — a live pari-mutuel arbitrage signal tool. Your job is to find logic errors and edge cases the build plan might miss.

Stack: Next.js 14 / TypeScript / Tailwind / Vitest. Math-heavy: probability extraction, Harville order-statistics, projected pari-mutuel payouts, edge calculation, signal classification (slam_dunk / lean / drift / none).

You have been given:
- **derby-edge-IMPLEMENTATION.md**: spec, especially §6 (math: probability, heuristic, Harville, payouts, edge, signals) and §12 (dashboard)
- **CLAUDE.md**: conventions
- **.claude/skills/derby-math/SKILL.md**: known pitfalls and 8 required invariants
- **Implementation Guide**: the step-by-step plan
- **Code Inspector Findings**, **Math Verifier Findings**, **Pattern Finder Findings**

Review for:

1. **Math from first principles**: Re-derive any modified or new formula yourself. Does the plan implement it correctly? Pay special attention to:
   - Harville place / show — sums must be 2 and 3 across all horses
   - Heuristic cap at 0.999 — a horse with p_win = 0.6 cannot have p_place = 1.2
   - Takeout direction: net = total × (1 − takeout), NEVER × takeout, NEVER ÷ (1 + takeout)
   - Breakage: round DOWN to $0.10, then enforce $2.10 floor (not before)
   - Edge: (actual / fair) − 1, not (fair / actual) − 1

2. **Signal classification logic**: Plan should evaluate `slam_dunk` > `lean` > `drift` > `none` IN ORDER. A horse meeting both `slam_dunk` and `drift` should be classified as `slam_dunk`.

3. **Edge cases**: What happens with — n=1 horse, n=2 horses (Harville degenerates), all-zero pools, one horse with `p ≥ 0.99`, all horses scratched, NaN in win pool, negative pool (shouldn't happen but guard anyway)?

4. **Probability source priority**: win_pool → decimal_odds → uniform fallback. Does the plan track `RaceAnalysis.probSource` correctly? Does it silently fall through anywhere?

5. **Dashboard UX**: Will signals be visually distinct? Sound alert on transition (not on every render — needs ref-tracking)? Scratched horses greyed but still visible? Countdown to post obviously alive?

6. **Drift signal sanity**: ML drift = (current − ml) / ml. Does the plan handle null ML or null current? Does it correctly distinguish "drifting out" (positive, more $$ on others) from "shortening" (negative)?

MANDATORY CHECKS:
- 8 invariants from `.claude/skills/derby-math/SKILL.md` — every one explicitly asserted somewhere in the new tests.
- Fixture coverage — every new code path has at least one fixture-driven test.
- Hand-computed expected values for at least one new formula.

Structure your response as:
- **CRITICAL** (will produce wrong numbers — must fix before execution)
- **SHOULD FIX** (won't produce wrong numbers but degrades UX or maintainability)
- **DESIGN QUESTIONS** (need the builder's input — include tradeoffs for each option)

For each issue: state what's wrong, where it is, and what the fix should be.

[FULL DOCUMENT TEXT BELOW]
```

Append the FULL text of all documents after the prompt. Do not summarize or truncate.

Tell the user: "Gemini review sent. Waiting for response..."

## Step 5: Synthesize feedback

After receiving both responses, tell the user: "Both reviews received. Synthesizing..."

Create `council-feedback.md` in the project root with:

```markdown
# Council Feedback — [Feature/Plan Name]

**Date**: [today's date]
**Plan reviewed**: [filename]
**Reviewers**: Codex (type safety + scraper contract + invariant coverage), Gemini (math from first principles + edge cases + UX)

## Critical Issues
[Things that are wrong or will break the build / produce wrong numbers — from any reviewer. Deduplicate if both caught the same issue.]

## Design Questions
[Open questions the user should answer before proceeding. Number them sequentially.]

## Suggested Improvements
[Good ideas ranked by impact vs effort.]

## Things to Consider
[Points raised that aren't urgent but worth thinking about.]

---

## Raw Response — Codex
[Full text from Codex]

## Raw Response — Gemini
[Full text from Gemini]
```

## Step 6: Present to the user

Show the user:

- A short summary of what the reviewers found (3–5 bullet points)
- The critical issues, if any
- The design questions that need answers (numbered)
- "Review the full feedback in `council-feedback.md`. Answer the design questions above, then run `/refine` to apply the feedback to the plan."

**Stop here. Do not modify any files other than `council-feedback.md`. Wait for the user.**
