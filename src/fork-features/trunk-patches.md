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

### `container/agent-runner/src/providers/claude.ts` — Claude Code channel provider driver

- Patch:
  - Replace the `@anthropic-ai/claude-agent-sdk` wrapper with a Claude Code channel provider driver.
  - Start a provider-local agent-channel exchange and inject the fork-owned `agent-channel` MCP child into Claude Code's MCP config.
  - Deliver NanoClaw turn input and live follow-ups as `nanoclaw.message_out` exchange envelopes; treat `channel.send` with `nanoclaw.message_in` as the only successful provider result path.
  - Keep the existing `AgentProvider` surface (`query`, `push`, `end`, `events`, `abort`, `isSessionInvalid`) so `container/agent-runner/src/poll-loop.ts` stays provider-agnostic.
  - Pass existing MCP server config, tool allow/deny lists, resume IDs, model/effort, additional directories, and system prompt append through Claude Code CLI flags.
- Why a patch and not pure fork-features: the upstream `claude` provider is the registered implementation for provider name `claude`. The provider registry has an extension point for adding providers, but not for replacing the built-in `claude` provider while preserving existing container configs and stored `sessions.agent_provider='claude'` values.

### `container/agent-runner/src/fork-features/claude-channel-exchange.ts` / `agent-channel-mcp.ts` — provider-local channel adapter

- Patch:
  - Add fork-owned container-side channel/exchange adapter code used by the patched built-in `claude` provider.
  - Mirror the #92/#94 bridge body kinds at the provider boundary (`nanoclaw.message_out` → Claude Code, `nanoclaw.message_in` → NanoClaw provider result) and normalize stringified JSON payloads from `channel.send`.
- Why a patch and not pure upstream code: this is fork-owned implementation code, but it lives under `container/agent-runner/src/` because that is the only source tree mounted into the agent container as `/app/src`. The host-side `src/fork-features/` tree is not mounted into the container runtime.

### `container/agent-runner/package.json` / `container/agent-runner/bun.lock` — remove SDK runtime dependency

- Patch:
  - Drop `@anthropic-ai/claude-agent-sdk` from the agent-runner dependency graph.
- Why a patch and not pure fork-features: dependencies for the built-in agent-runner image are owned by the agent-runner package, and the SDK must be absent from the runtime provider dependency path.

### `container/agent-runner/src/providers/claude.test.ts` — lifecycle coverage

- Patch:
  - Add provider-level tests for channel MCP config construction, exchange-envelope delivery, init/progress/activity mapping, `channel.send` result mapping, live follow-up delivery, abort, and stale-session classification.
- Why a patch and not pure fork-features: these tests cover the replacement behavior of the built-in `claude` provider and need to live beside the provider test suite.

## Channel exchange e2e harness (issue Mouriya-Emma/nanoclaw#96)

### `container/agent-runner/src/db/connection.ts` — file-backed runner DB override

- Patch:
  - Let `NANOCLAW_RUNNER_INBOUND_DB`, `NANOCLAW_RUNNER_OUTBOUND_DB`, and `NANOCLAW_RUNNER_HEARTBEAT` override the container defaults `/workspace/inbound.db`, `/workspace/outbound.db`, and `/workspace/.heartbeat`.
- Why a patch and not pure fork-features: the agent-runner DB paths are module-level constants inside the container-owned DB connection layer. The e2e harness needs to run the real poll-loop and Claude provider against real file-backed session DBs from a repo-local target-equivalent environment, but upstream has no constructor/config hook for runner DB paths outside the `/workspace` container mount.

### `container/agent-runner/src/providers/claude.ts` — exchange endpoint diagnostic

- Patch:
  - Log the provider-local channel exchange URL plus runtime and Claude channel ids when a query starts.
- Why a patch and not pure fork-features: the provider creates the exchange internally and currently exposes no observable endpoint metadata. The #96 true-path regression must preserve evidence that distinguishes exchange/MCP/provider/delivery breakpoints, so the diagnostic needs to live at the provider-owned creation point.

## vctcn self-hosted CI runner routing (issue mouriya-s-lab/nanoclaw#103)

### `.github/workflows/ci.yml` — CI job runner stanza

- Patch:
  - Change the PR CI job from `runs-on: ubuntu-latest` to `[self-hosted, linux, vctcn]`.
  - Run the job inside `catthehacker/ubuntu:full-24.04` so Node, pnpm, Bun, TypeScript, Vitest, and Bun tests execute in an ubuntu-latest-compatible userspace.
  - Guard the job to same-repository pull requests, because this public fork must not execute untrusted fork PR code on the vctcn self-hosted runner.
- Why a patch and not pure fork-features: GitHub Actions runner routing is defined only in the upstream-owned workflow file. There is no project extension point that can override a job's runner labels or container image from `src/fork-features/`.
