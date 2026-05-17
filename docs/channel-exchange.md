# Channel Exchange Boundaries

Channel exchange routing is the Claude Code provider's optional routing core. It is the message envelope path between NanoClaw's agent-runner and the Claude Code process. It is not a second NanoClaw runtime, harness, or persistence layer.

## Enabling The Path

The exchange path is active for sessions that resolve to the built-in `claude` provider. Provider resolution is:

1. `sessions.agent_provider`
2. `container_configs.provider`
3. default `claude`

When the resolved provider is `claude`, `container/agent-runner/src/providers/claude.ts` starts a provider-local channel exchange for each query, injects the fork-owned `agent-channel` MCP server into Claude Code's MCP config, sends NanoClaw turns as `nanoclaw.message_out`, and accepts provider results only through `channel.send` with `nanoclaw.message_in`.

No separate feature flag enables exchange routing. To disable it for a session, use a different provider. To use it, keep the session or group on `claude`, rebuild/restart the normal NanoClaw service or container path, and verify the container has the Claude Code CLI available through `CLAUDE_CODE_EXECUTABLE` or the default `/pnpm/claude`.

## Boundary Map

| Boundary        | Owned by                                                                                                                                                                   | What it owns                                                                                                                                                                                               | What it does not own                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Exchange 抽象   | `container/agent-runner/src/fork-features/claude-channel-exchange.ts` and `agent-channel-mcp.ts`                                                                           | Provider-local mailboxes, envelope validation, `channel.poll_inbox`, `channel.send`, registration, discovery, and delivery acks during one Claude provider query.                                          | NanoClaw startup, container lifecycle, scheduling, credential injection, channel adapter auth, central DB rows, or per-session SQLite files. |
| Runtime bridge  | `src/fork-features/exchange-runtime-bridge.ts`                                                                                                                             | Translation between NanoClaw session messages and provider envelopes, including `nanoclaw.message_out`, `nanoclaw.message_in`, target validation, wake decisions, and typed delivery failures.             | Running Claude Code, starting containers, selecting models, or deciding channel adapter delivery behavior.                                   |
| Provider driver | `container/agent-runner/src/providers/claude.ts`                                                                                                                           | Claude Code CLI process lifecycle for a query, MCP config assembly, tool allow/deny flags, resume IDs, progress events, direct-result rejection, live follow-ups, abort, and stale-session classification. | NanoClaw persistence semantics, host delivery polling, central scheduler decisions, or OneCLI credential proxy ownership.                    |
| Persistence     | NanoClaw host and agent-runner DB modules, especially `src/session-manager.ts`, `src/db/sessions.ts`, `src/delivery.ts`, and `container/agent-runner/src/db/connection.ts` | Central DB state, per-session `inbound.db` and `outbound.db`, session routing, destination rows, message status, delivery acknowledgements, and stored provider continuation IDs.                          | Ephemeral exchange mailbox contents or Claude Code's in-process MCP channel state.                                                           |

## Explicit Non-goals

The exchange does not spawn containers, act as a container manager, run the scheduler, own the session DB, or act as a credential proxy. Those remain NanoClaw runtime responsibilities:

- container startup, restart, mount shape, and OneCLI credential injection remain in `src/container-runner.ts`;
- due-message sweep and recurrence remain in `src/host-sweep.ts` and related scheduler paths;
- session data stays in the central DB plus per-session SQLite files;
- channel delivery stays in `src/delivery.ts` and the installed channel adapters;
- provider secrets continue through the existing OneCLI and container environment path.

## Debugging Failures

Use the true-path regression first:

```bash
pnpm run test:e2e:channel-exchange
```

The e2e slice writes a real inbound session DB row, runs the real Bun agent-runner with the Claude provider, sends the turn through the provider-local exchange/MCP server, and drains NanoClaw host delivery through a target-equivalent channel adapter. See [channel-exchange-e2e.md](channel-exchange-e2e.md) for environment knobs and artifact paths.

Interpret `CHANNEL_EXCHANGE_E2E_BLOCKED phase=...` by boundary:

| Phase          | Likely boundary                                | First checks                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment`  | Runtime setup before exchange starts           | `bun --version`, `pnpm --version`, `CLAUDE_CODE_EXECUTABLE`, repo-local `NANOCLAW_E2E_WORK_DIR` and `NANOCLAW_E2E_EVIDENCE_DIR`.                                                                                  |
| `provider`     | Provider driver or Claude Code account/runtime | Claude Code auth/quota, provider stderr, `Claude Code exited without replying through channel.send`, model flags, and direct-result logs.                                                                         |
| `exchange_mcp` | Exchange 抽象 or MCP child                     | Agent-runner stderr lines from `[claude-provider] Started channel exchange ...` and `[agent-channel-mcp]`, `AGENT_CHANNEL_EXCHANGE_URL`, mailbox registration, and `channel.poll_inbox` or `channel.send` errors. |
| `delivery`     | Persistence or host delivery                   | `outbound.db` rows, destination rows, `src/delivery.ts`, and the target channel adapter's `deliver` result.                                                                                                       |

For manual inspection, the provider logs the provider-local exchange URL plus runtime and Claude channel IDs when a query starts. Treat that URL as process-local diagnostic state, not an operator API.

## Upstream Maintenance Checks

When accepting upstream changes, review these boundaries before merging:

- `src/fork-features/trunk-patches.md` must still describe every direct upstream-file patch required for the exchange/provider path.
- If upstream adds a provider replacement hook, migrate the built-in `claude` override out of the direct provider patch.
- If upstream changes `container/agent-runner/src/providers/*`, confirm the provider still injects `agent-channel` MCP, preserves existing MCP servers, and rejects direct Claude Code results that bypass `channel.send`.
- If upstream changes session DB schema, `src/session-manager.ts`, `src/delivery.ts`, or container DB paths, rerun the runtime bridge tests and the e2e slice because Persistence still belongs to NanoClaw.
- If upstream changes container mounts, Claude state paths, or global CLI installation, confirm `CLAUDE_CODE_EXECUTABLE` and the `agent-channel` MCP child are still reachable inside the container.
- If upstream reintroduces `@anthropic-ai/claude-agent-sdk` into the Claude provider path, verify it is deliberate and does not bypass the exchange boundary.

The safe rule is simple: provider-local mailbox routing may pass envelopes to NanoClaw bridge code, but NanoClaw continues to own runtime process management, session state, scheduled work, credentials, and final channel delivery.
