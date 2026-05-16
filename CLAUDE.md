# derby-edge

Live pari-mutuel arbitrage signal tool for US horse racing. Scrapes FanDuel Racing pool data, flags +EV Place/Show bets where projected payouts exceed Win-pool-implied fair prices.

**The authoritative spec is `derby-edge-IMPLEMENTATION.md`.** Read it before doing any work in this repo. If anything in this CLAUDE.md and the spec disagree, the spec wins.

## Project conventions

- TypeScript strict mode. No `any`. Use `unknown` and narrow.
- Tailwind only for styling. No CSS modules, no styled-components.
- All times in ISO 8601 UTC. Convert to local at render time only.
- pnpm for package management. Use `tsx` to run scripts.
- All math is pure functions in `lib/math/`. No I/O, no side effects.

## Critical files

- `derby-edge-IMPLEMENTATION.md` — single source of truth for the build
- `.claude/skills/derby-math/SKILL.md` — auto-loads when editing `lib/math/*.ts`. Contains every known pitfall and required invariant.
- `.claude/commands/discover-fdr.md` — slash command for FDR endpoint discovery
- `auth/storageState.json` — Playwright session, gitignored, NEVER commit

## After Phase 1 completes

Run `council-of-models` against `lib/math/harville.ts` and `lib/math/payouts.ts` to cross-validate the math against GPT and Gemini before proceeding to Phase 4. Math bugs in this codebase are silent — the dashboard will render plausible-looking numbers that are systematically wrong. Do not skip this step.

## What's NOT in this project

- No database (in-memory state only for v1)
- No auth (single-user, runs locally)
- No deploy target (`pnpm dev` on local machine)
- No agents (overkill for project size)
- No exotics (exacta/trifecta/super) — Win/Place/Show only for v1

## Security

`auth/storageState.json` contains a live FanDuel session cookie. Treat it like a credential. The `auth/.gitignore` excludes it from commits, but verify your commit before pushing if you've touched anything in `auth/`.

Never put FanDuel passwords in `.env` or anywhere on disk. The Playwright login flow (run via `pnpm run login`) handles auth interactively without storing the password.
