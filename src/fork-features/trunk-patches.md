# Tracked trunk patches

Each entry below is a small edit to an upstream file that fork-features cannot fully encapsulate, because upstream lacks a register-style extension point at the call site. At every rebase, walk this list — if upstream has since added a register API or made the concern obsolete, migrate the patch into `fork-features/` or drop it.

Format per entry: file/line, what the patch does, why extraction isn't possible today.

## OneCLI identifier transform (issue Mouriya-Emma/nanoclaw#90)

### `src/container-runner.ts` — call to `toOneCLIIdentifier`

- Patch:
  - Add `import { toOneCLIIdentifier } from './fork-features/onecli-identifier.js';`
  - Change `const agentIdentifier = agentGroup.id;` to `const agentIdentifier = toOneCLIIdentifier(agentGroup.id);`
- Why a patch and not pure fork-features: `agentIdentifier` is a local in `spawnContainer` consumed by `buildContainerArgs(... agentIdentifier)`. Upstream has no hook for "compute the OneCLI identifier from an agent group" — the only call site is this one literal assignment. Extracting would require adding a `getOneCLIIdentifier(group)` extension point upstream.

### `src/modules/approvals/onecli-approvals.ts` — call to `fromOneCLIIdentifier`

- Patch:
  - Add `import { fromOneCLIIdentifier } from '../../fork-features/onecli-identifier.js';`
  - Change `const originGroup = request.agent.externalId ? getAgentGroup(request.agent.externalId) : undefined;` to use `fromOneCLIIdentifier` then `getAgentGroup`.
- Why a patch and not pure fork-features: the reverse-lookup happens inside the manual-approval handler upstream owns. Upstream takes `request.agent.externalId` straight to `getAgentGroup`. Symmetry with the forward-transform patch above; same missing extension point.

## Rebase checklist for these two

When rebasing onto a new upstream version:
1. Has upstream added a `registerOneCLIIdentifierTransform` (or equivalent) extension point? Migrate both patches into a single `fork-features/onecli-identifier.ts` self-registration call and drop these entries.
2. Has upstream changed how `agentGroup.id` is consumed by `ensureAgent` (e.g. moved the transform server-side, switched away from `@onecli-sh/sdk`)? The patches may be obsolete — verify with a smoke test against a self-hosted OneCLI before keeping them.

## Claude Code provider driver (issue Mouriya-Emma/nanoclaw#95)

### `container/agent-runner/src/providers/claude.ts` — Claude Code CLI stream driver

- Patch:
  - Replace the `@anthropic-ai/claude-agent-sdk` wrapper with a direct `claude --print --input-format stream-json --output-format stream-json` driver.
  - Keep the existing `AgentProvider` surface (`query`, `push`, `end`, `events`, `abort`, `isSessionInvalid`) so `container/agent-runner/src/poll-loop.ts` stays provider-agnostic.
  - Pass MCP server config, tool allow/deny lists, resume IDs, model/effort, additional directories, and system prompt append through Claude Code CLI flags.
- Why a patch and not pure fork-features: the upstream `claude` provider is the registered implementation for provider name `claude`. The provider registry has an extension point for adding providers, but not for replacing the built-in `claude` provider while preserving existing container configs and stored `sessions.agent_provider='claude'` values.

### `container/agent-runner/package.json` / `container/agent-runner/bun.lock` — remove SDK runtime dependency

- Patch:
  - Drop `@anthropic-ai/claude-agent-sdk` from the agent-runner dependency graph.
- Why a patch and not pure fork-features: dependencies for the built-in agent-runner image are owned by the agent-runner package, and the SDK must be absent from the runtime provider dependency path.

### `container/agent-runner/src/providers/claude.test.ts` — lifecycle coverage

- Patch:
  - Add provider-level tests for CLI flag construction, init/result/progress/activity mapping, live follow-up streaming, abort, and stale-session classification.
- Why a patch and not pure fork-features: these tests cover the replacement behavior of the built-in `claude` provider and need to live beside the provider test suite.
