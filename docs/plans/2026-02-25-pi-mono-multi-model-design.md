# Pi-mono Multi-Model Agent Support

**Date:** 2026-02-25
**Status:** Approved

## Goal

Add Pi-mono as a second agent runtime alongside the existing Claude Agent SDK, enabling users to switch between Claude, Gemini, Codex, and other models via bot commands. Both runtimes share the same IPC protocol, MCP tools, and session abstraction.

## User-Facing Behavior

### Model Switching Commands

**Persistent switch** — changes the group's default model:
```
/model gemini         → all future messages use Gemini
/model claude         → switch back to Claude
/model codex          → switch to Codex (OpenAI)
/model                → show current model
```

**Single-use query** — one message with a specific model, then revert:
```
/ask gemini 帮我分析这段代码
/ask codex Write a Python script that...
```

### OAuth Setup

Pi-mono requires its own OAuth tokens. Users configure via bot:
```
/auth google          → triggers Google OAuth flow, stores token
/auth openai          → triggers OpenAI auth flow
```

Tokens stored securely, passed to containers via stdin (same pattern as `ANTHROPIC_API_KEY`).

## Architecture

### Container Strategy: Separate Images

```
container/
  agent-runner/           ← existing Claude Agent SDK runner (unchanged)
  pi-runner/              ← new Pi-mono runner
    src/
      index.ts            ← main entry, same stdin/stdout/IPC protocol
      session.ts          ← Context serialization/restore
      mcp-bridge.ts       ← MCP tools → Pi-mono AgentTool bridge
    package.json          ← @mariozechner/pi-agent-core, pi-coding-agent, pi-ai
  Dockerfile              ← existing Claude image (unchanged)
  Dockerfile.pi           ← new Pi-mono image
```

Two Docker images:
- `nanoclaw-agent:latest` — Claude Agent SDK (existing, unchanged)
- `nanoclaw-pi:latest` — Pi-mono runtime

### Host-Side Changes

| File | Change |
|------|--------|
| `src/types.ts` | `RegisteredGroup.defaultProvider?: string` |
| `src/db.ts` | `group_model_preference` table for per-group model state |
| `src/config.ts` | `PI_CONTAINER_IMAGE`, provider→key mappings |
| `src/container-runner.ts` | `ContainerInput` adds `provider`/`modelId`; `readSecrets()` selects keys by provider; selects image by provider |
| `src/channels/telegram.ts` | `/model` and `/ask` command handlers |
| `src/channels/whatsapp.ts` | `/model` and `/ask` command parsing |

### ContainerInput Extension

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  hostMcpServers?: Record<string, { url: string }>;
  // New fields
  provider?: string;    // 'claude' | 'google' | 'openai' | ...
  modelId?: string;     // 'gemini-2.5-flash' | 'gpt-4o' | ...
}
```

### Pi-mono Runner (container/pi-runner/)

Follows the exact same protocol as the Claude agent-runner:
- **Input:** stdin JSON (ContainerInput)
- **Output:** stdout with `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER`
- **IPC:** same file-based IPC at `/workspace/ipc/`
- **MCP:** same NanoClaw MCP server (ipc-mcp-stdio.ts, copied verbatim)

#### Core: Agent Loop

```typescript
// Replaces Claude SDK's query() with Pi-mono's complete()/stream()
async function runQuery(prompt, sessionId, mcpClient, containerInput) {
  const model = getModel(containerInput.provider, containerInput.modelId);
  const context = sessionId ? loadSession(sessionId) : { messages: [] };

  context.systemPrompt = buildSystemPrompt(containerInput);
  context.messages.push({ role: 'user', content: prompt });

  const tools = await mcpToolsToPiTools(mcpClient);

  while (true) {
    const response = await complete(model, { ...context, tools }, {
      apiKey: secrets[providerKeyName(containerInput.provider)]
    });
    context.messages.push(response);

    const toolCalls = extractToolCalls(response);
    if (toolCalls.length === 0) {
      // Final text response
      const text = extractText(response);
      const newSessionId = saveSession(context);
      writeOutput({ status: 'success', result: text, newSessionId });
      break;
    }

    // Execute tool calls via MCP client
    for (const tc of toolCalls) {
      const result = await mcpClient.callTool(tc.name, tc.arguments);
      context.messages.push({ role: 'toolResult', toolCallId: tc.id, content: result });
    }

    // Check IPC during loop
    if (shouldClose()) return { closedDuringQuery: true };
    for (const msg of drainIpcInput()) {
      context.messages.push({ role: 'user', content: msg });
    }
  }
}
```

#### Tools

Pi-mono built-in tools (`codingTools`): bash, read, edit, write — handled by Pi-mono natively.

NanoClaw-extended tools (MCP): send_message, schedule_task, list_tasks, etc. — bridged via `mcp-bridge.ts` which converts MCP tool schemas to Pi-mono `AgentTool` format.

Host MCP servers: same HTTP proxy pattern, bridged identically.

### Session Abstraction

Both runners produce/consume a `sessionId: string`. The host doesn't care about internals.

| | Claude | Pi-mono |
|---|---|---|
| Session state | SDK-managed `.claude/` directory | `Context` JSON file |
| Session ID | SDK opaque ID | File path hash or UUID |
| Resume | `query({ resume: sessionId })` | `loadSession(id)` → deserialize Context |
| Persistence | SDK handles | `saveSession(context)` → serialize to `data/sessions/{group}/pi-context.json` |
| Compaction | SDK PreCompactHook | Manual: truncate old messages when context exceeds threshold |
| Archive | PreCompactHook → `conversations/` | Same pattern: archive before truncation |

SQLite `sessions` table stores session IDs for both — no schema change needed.

### Secrets Management

```env
# .env
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AIza...
OPENAI_API_KEY=sk-...
```

`readSecrets()` updated to load all provider keys. `container-runner.ts` passes only the relevant key(s) based on `provider` field.

Pi-mono OAuth tokens obtained via bot commands (`/auth google`) and stored in `.env` or encrypted storage.

### Code Reuse Analysis

| Component | Reuse | Notes |
|-----------|-------|-------|
| `ipc-mcp-stdio.ts` | 100% copy | MCP server, model-agnostic |
| IPC functions (shouldClose, drainIpcInput, waitForIpcMessage) | 100% copy | ~60 lines, file-based IPC |
| Output protocol (writeOutput, markers) | 100% copy | ~15 lines |
| stdin reading (readStdin) | 100% copy | ~10 lines |
| ContainerInput/ContainerOutput interfaces | 100% copy | Extended with provider/modelId |
| Transcript archival | Adapt | Similar logic, different trigger (manual vs PreCompactHook) |
| Session management | New | Pi-mono Context serialization |
| Agent loop (runQuery) | New | Pi-mono complete() + tool execution loop |
| MCP bridge | New | MCP schema → AgentTool conversion |
| main() outer loop | 90% copy | Same structure: read stdin → query loop → IPC wait |

## What's NOT Changing

- Existing Claude agent-runner: untouched
- IPC protocol: same file format, same directories
- NanoClaw MCP server: identical copy used by both runners
- Host-side IPC watcher, task scheduler, group queue: unchanged
- Container mount strategy: same volume mounts
- Security model: same per-group isolation
