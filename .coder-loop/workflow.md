# coder-loop workflow for NanoClaw fork

> **Note on what coder-loop is.** `coder-loop` itself is just a stateless loop: it
> alternates iteration/review agent spawns, captures their output, and writes
> trace/log/status files. It does **not** judge issue completion, evidence
> sufficiency, PR correctness, or parent closure. All of those judgments come
> from this `workflow.md` (project policy) plus live GitHub state. If you delete
> a rule from this file, the loop stops enforcing it. Keep this file project-
> owned and committed; the agents read it every spawn.

## Goal

Drive NanoClaw fork (`Mouriya-Emma/nanoclaw`) along its v2 baseline migration and the 9 RFC inventory tasks (#68–#76). The fork tracks `qwibitai/nanoclaw` upstream and is currently on v1 (`1.2.52`). The validated migration target is upstream `v2.0.54` (commit `a33b1ae`) with fork-only code concentrated in `src/fork-features/` plus a small tracked set of trunk patches (see issues #77 baseline pin, #78 code placement).

Priority order:
1. Spike-classed issues (e.g. unblocking design questions) before implementation issues.
2. Issues that close other RFCs' implementation blockers before isolated features.
3. Otherwise follow `.coder-loop/runtime/state.json` queue order.

The first practical task is the actual v2 baseline jump (move `main` from v1 to v2.0.54 + drop in `src/fork-features/` from the validated `/tmp/nanoclaw-v2-spike` worktree). This step is *not* a normal incremental PR — it follows the `/migrate-nanoclaw` Tier 3 replay flow recorded in `project_v2_baseline_decision` memory. Treat any related GitHub issue as a coordination/closure issue, not as a diff-style PR target.

## Source of truth

- Queue/order/state: `.coder-loop/runtime/state.json`
- Current issue handoff: `.coder-loop/runtime/issues/<issue>.md`
- Shared durable facts: `.coder-loop/runtime/shared.md`
- Runtime evidence/logs: `.coder-loop/runtime/evidence/` and `.coder-loop/runtime/logs/`
- Validated v2 worktree: `/tmp/nanoclaw-v2-spike` (do not delete — referenced by issues #77, #78)
- Live GitHub issue/PR state verifies reality.
- `CLAUDE.md`, `docs/DEPLOYMENT.md` are project reference. They are not the loop workflow.

If this workflow conflicts with target `CLAUDE.md` about loop process, queue state, or PR evidence, follow this workflow. If it conflicts about project commands, tests, or codebase conventions, follow `CLAUDE.md`.

## Non-negotiable PR rules

- One PR closes exactly one issue.
- PR body first line must be `Closes #N.` (with the period — fork's existing convention).
- PR title and body are English. Conventional Commits prefix on title (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`).
- PR body must include all required evidence layers (see skeleton below) plus an `Analysis` section.
- PR body is the immutable opening cover letter and initial evidence packet; do not rewrite it as a per-iteration test log. After an implementation PR exists, every iteration/retry must post a new PR-thread comment with addressed review feedback, what changed, and the full current evidence packet.
- Do not mark an issue done without credible evidence.
- Review agent is the final gate. Iteration agent must never merge PRs or close issues.
- Do not stage `.coder-loop/runtime/`, `.dev-loop`, `.dev-trace.txt`, `groups/*/` runtime contents, `store/`, `data/`, `logs/`, or `.env` into feature PRs.
- New fork code goes to `src/fork-features/`, NOT into upstream files. See `~/.claude/rules/fork-customization-placement.rule.md`. Direct edits to upstream files (those tracked from `upstream/main`) require justification in the PR body's Analysis section and addition to `src/fork-features/trunk-patches.md`.

## Required PR body skeleton

```markdown
Closes #N.

## Summary

<1-3 sentences.>

## Layer 1 — Change preview

<dry-run / diff / migration preview / not applicable reason + analysis.>

## Layer 2 — Landing checks

<files, code paths, tests, config, migration checks + analysis.>

## Layer 3 — Startup / runtime ordering

<dev server / service / startup / CI / deploy ordering evidence or not applicable reason + analysis. NanoClaw is a long-running Node service — restart behavior, container lifecycle, OneCLI/credential-proxy startup ordering all belong here when touched.>

## Layer 4 — End-to-end behavior

<E2E evidence. NanoClaw has `e2e/` suites covering Telegram (gramjs), Mattermost (WebSocket+REST), pi-mono OAuth, host-exec. If the change touches channels / runtime / scheduler, run the relevant `pnpm run test:e2e:*` slice and quote the result. E2E is NOT in CI — operator runs it manually with a live `192.168.1.41` Mattermost + valid `data/pi-auth.json` + `E2E_TELEGRAM_SESSION`. If the env is unavailable, document the gap explicitly rather than waiving.>

## Analysis

<2-4 sentences on whether evidence is sufficient and what risk remains.>
```

Drop layers your specific issue genuinely doesn't need (e.g. Layer 4 for a pure docs PR). State the reason explicitly.

## Verification commands

Per `package.json` and `.github/workflows/ci.yml`:

- Format check: `pnpm run format:check` (CI gate)
- Typecheck: `pnpm exec tsc --noEmit` (CI gate)
- Unit tests: `pnpm exec vitest run` (CI gate)
- Build: `pnpm run build`
- E2E (manual only, not in CI): `pnpm run test:e2e:*` slices

The v2.0.54 baseline pins `pnpm@10.33.0` (`package.json` `packageManager`). Local dev install: `pnpm install --frozen-lockfile`.

## CI-parity evidence

Every PR must state:

- whether `.github/workflows/ci.yml` ran on the PR (visible via `gh pr checks <pr>`);
- the local CI-parity command actually run (the four-step sequence: `pnpm install --frozen-lockfile && pnpm run format:check && pnpm exec tsc --noEmit && pnpm exec vitest run`);
- runner architecture (note: CI is `ubuntu-latest` x86_64; local dev is likely macOS arm64 — `better-sqlite3` rebuild can diverge);
- exit status of each step;
- concise log excerpt or log path under `.coder-loop/runtime/evidence/`.

Remote GitHub `ci.yml` checks are mergeability signals. They do not replace iteration-stage local CI-parity evidence.

## End-to-end / integration evidence

NanoClaw is a backend / CLI service, not a UI project. Layer 4 evidence is integration testing, not browser screenshots.

For changes touching channels (mattermost/telegram), runtime (claude/pi-mono), scheduler, IPC, or session lifecycle:
- Run the relevant `pnpm run test:e2e:*` slice against the operator's live env.
- Quote the test output (pass/fail counts) in Layer 4.
- If the live env is unavailable (no `192.168.1.41` reachable, no valid `E2E_TELEGRAM_SESSION`, no `data/pi-auth.json`), document the gap in Layer 4 and block for operator review rather than waiving silently.

For changes that don't touch those subsystems (docs, refactors confined to fork-features/, build config), state "Layer 4 not applicable because <reason>" and explain why.

## Issue queue policy

Preserve the concrete recommendation order from `.coder-loop/runtime/state.json`.

Skip parent/umbrella/moot issues as implementation targets unless their children are complete and the action is only documentation/comment/closure. For ambiguous external/upstream conflicts (e.g. upstream API changed between baseline pin and now), prefer no-code spike issues to classify before implementation.

The 9 RFC issues (#68–#76) are inventory documents, NOT implementation tasks. Implementation tasks should be filed as separate issues that reference the RFC they implement. The RFC issue itself is closed only when all its child implementation tasks have closed.

## Implementation behavior

- Work only on the selected issue for the current invocation.
- On retry, continue the existing branch/PR from runtime state unless that PR is explicitly invalid or unusable.
- Prefer small, direct changes over abstractions. The fork's CLAUDE.md ("Don't add features, refactor, or introduce abstractions beyond what the task requires") applies inside the loop too.
- Follow existing project patterns: TypeScript strict, ESM, conventional commits, no defensive validation for trusted internal state, no unnecessary comments.
- Validate only at system boundaries.
- If a task is too large, implement the smallest complete slice that closes the selected issue or mark blocked with a concrete reason.
- If external services are unavailable (Mattermost, Telegram, pi-auth), record the blocker and continue to other actionable issues when possible.
- Trunk patches: every direct edit to a file that came from `upstream/main` must be recorded in `src/fork-features/trunk-patches.md` (create on first use). Each entry: file path, hunk summary, why extraction to `fork-features/` is not possible, what upstream API surface would be needed to extract.

## Review behavior

Review rejects PRs that lack:

- `Closes #N.` as first line
- English PR body
- all required evidence layers (or explicit "not applicable" reasons)
- CI-parity evidence
- typecheck evidence
- test evidence
- credible positive and negative-path evidence where applicable
- trunk-patches.md update when a PR adds a direct upstream-file edit

Review may merge accepted PR-backed work per the bundled preset's review prompts. Review must not bypass evidence gates, must not accept stale local evidence from the wrong branch, and must not set local `done` until GitHub merge/issue closure actions succeed.
