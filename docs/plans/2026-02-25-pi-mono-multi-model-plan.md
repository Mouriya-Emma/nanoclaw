# Pi-mono Multi-Model Agent Support — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Pi-mono as a second agent runtime alongside Claude Agent SDK, enabling users to switch between Claude/Gemini/Codex via bot commands.

**Architecture:** Separate Docker image (`nanoclaw-pi:latest`) with a new `container/pi-runner/` that speaks the same stdin/stdout/IPC protocol. Host-side adds `/model` and `/ask` commands plus provider-aware container selection. Session abstraction unified via `SessionManager` from Pi-mono.

**Tech Stack:** `@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@modelcontextprotocol/sdk`

**Design doc:** `docs/plans/2026-02-25-pi-mono-multi-model-design.md`

---

## Task 1: Host-side — Add model preference to DB and types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/db.ts`
- Modify: `src/db.test.ts`

**Step 1: Add model preference fields to types**

In `src/types.ts`, add to `RegisteredGroup`:

```typescript
// After requiresTrigger field in RegisteredGroup
export interface ModelPreference {
  provider: string;   // 'claude' | 'google' | 'openai'
  modelId?: string;   // 'gemini-2.5-flash' | 'gpt-4o' | etc.
}
```

**Step 2: Add model_preferences table to DB**

In `src/db.ts`, add to `createSchema()`:

```sql
CREATE TABLE IF NOT EXISTS model_preferences (
  group_folder TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'claude',
  model_id TEXT
);
```

Add accessors:

```typescript
export function getModelPreference(groupFolder: string): ModelPreference {
  const row = db
    .prepare('SELECT provider, model_id FROM model_preferences WHERE group_folder = ?')
    .get(groupFolder) as { provider: string; model_id: string | null } | undefined;
  return row
    ? { provider: row.provider, modelId: row.model_id || undefined }
    : { provider: 'claude' };
}

export function setModelPreference(groupFolder: string, pref: ModelPreference): void {
  db.prepare(
    'INSERT OR REPLACE INTO model_preferences (group_folder, provider, model_id) VALUES (?, ?, ?)',
  ).run(groupFolder, pref.provider, pref.modelId || null);
}

export function deleteModelPreference(groupFolder: string): void {
  db.prepare('DELETE FROM model_preferences WHERE group_folder = ?').run(groupFolder);
}
```

**Step 3: Write tests**

In `src/db.test.ts`, add:

```typescript
describe('model preferences', () => {
  it('returns claude as default when no preference set', () => {
    const pref = getModelPreference('test-group');
    expect(pref).toEqual({ provider: 'claude' });
  });

  it('stores and retrieves model preference', () => {
    setModelPreference('test-group', { provider: 'google', modelId: 'gemini-2.5-flash' });
    const pref = getModelPreference('test-group');
    expect(pref).toEqual({ provider: 'google', modelId: 'gemini-2.5-flash' });
  });

  it('deletes model preference', () => {
    setModelPreference('test-group', { provider: 'openai' });
    deleteModelPreference('test-group');
    expect(getModelPreference('test-group')).toEqual({ provider: 'claude' });
  });
});
```

**Step 4: Run tests**

Run: `npm test -- src/db.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/types.ts src/db.ts src/db.test.ts
git commit -m "feat: add model preference storage for multi-model support"
```

---

## Task 2: Host-side — Extend config and container-runner for provider selection

**Files:**
- Modify: `src/config.ts`
- Modify: `src/container-runner.ts`

**Step 1: Add Pi-mono config**

In `src/config.ts`, add after existing config reads:

```typescript
// Add to readEnvFile keys list:
// 'PI_CONTAINER_IMAGE', 'GOOGLE_API_KEY', 'OPENAI_API_KEY'

export const PI_CONTAINER_IMAGE =
  process.env.PI_CONTAINER_IMAGE || envConfig.PI_CONTAINER_IMAGE || 'nanoclaw-pi:latest';

// Provider → env key mapping for secrets
export const PROVIDER_SECRET_KEYS: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  google: ['GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
};
```

Update the `readEnvFile` call at the top of `config.ts` to include `'PI_CONTAINER_IMAGE'`.

**Step 2: Extend ContainerInput**

In `src/container-runner.ts`, add to `ContainerInput`:

```typescript
export interface ContainerInput {
  // ... existing fields ...
  provider?: string;    // 'claude' | 'google' | 'openai'
  modelId?: string;     // 'gemini-2.5-flash' | 'gpt-4o'
}
```

**Step 3: Update readSecrets() for multi-provider**

In `src/container-runner.ts`, change `readSecrets()`:

```typescript
function readSecrets(provider?: string): Record<string, string> {
  const keys = PROVIDER_SECRET_KEYS[provider || 'claude'] || PROVIDER_SECRET_KEYS.claude;
  return readEnvFile(keys);
}
```

Update the call site in `runContainerAgent()` (line ~364):

```typescript
input.secrets = readSecrets(input.provider);
```

**Step 4: Select container image by provider**

In `src/container-runner.ts`, update `buildContainerArgs()` — extract the image from args and modify `runContainerAgent()`:

```typescript
function getContainerImage(provider?: string): string {
  if (provider && provider !== 'claude') {
    return PI_CONTAINER_IMAGE;
  }
  return CONTAINER_IMAGE;
}
```

In `runContainerAgent()`, change the line that builds container args:

```typescript
const image = getContainerImage(input.provider);
const containerArgs = buildContainerArgs(mounts, containerName, image);
```

Update `buildContainerArgs()` signature to accept `image` param instead of using `CONTAINER_IMAGE` constant.

**Step 5: Commit**

```bash
git add src/config.ts src/container-runner.ts
git commit -m "feat: provider-aware config and container image selection"
```

---

## Task 3: Host-side — Add /model and /ask commands to Telegram

**Files:**
- Modify: `src/channels/telegram.ts`
- Modify: `src/index.ts`

**Step 1: Add /model command to Telegram**

In `src/channels/telegram.ts`, add to `TelegramChannelOpts`:

```typescript
export interface TelegramChannelOpts {
  // ... existing fields ...
  onSetModel?: (jid: string, provider: string, modelId?: string) => void;
  onGetModel?: (jid: string) => { provider: string; modelId?: string };
}
```

Add `/model` command handler after the `/stop` command handler:

```typescript
this.bot.command('model', (ctx) => {
  const jid = buildJid({ chat: ctx.chat, message: ctx.message as any });
  const group = this.opts.registeredGroups()[jid];
  if (!group) {
    ctx.reply('This chat is not registered.');
    return;
  }

  const args = ctx.match?.trim();
  if (!args) {
    const current = this.opts.onGetModel?.(jid) || { provider: 'claude' };
    ctx.reply(`Current model: ${current.provider}${current.modelId ? ` (${current.modelId})` : ''}\n\nUsage: /model <provider> [model_id]\nProviders: claude, google, openai`);
    return;
  }

  const parts = args.split(/\s+/);
  const provider = parts[0].toLowerCase();
  const modelId = parts[1] || undefined;

  const validProviders = ['claude', 'google', 'openai'];
  if (!validProviders.includes(provider)) {
    ctx.reply(`Unknown provider: ${provider}\nValid: ${validProviders.join(', ')}`);
    return;
  }

  this.opts.onSetModel?.(jid, provider, modelId);
  this.opts.onClearSession?.(jid);
  ctx.reply(`Model switched to ${provider}${modelId ? ` (${modelId})` : ''}. Session cleared.`);
});
```

**Step 2: Add /ask command for single-use model query**

Add after `/model` handler:

```typescript
this.bot.command('ask', (ctx) => {
  const jid = buildJid({ chat: ctx.chat, message: ctx.message as any });
  const group = this.opts.registeredGroups()[jid];
  if (!group) {
    ctx.reply('This chat is not registered.');
    return;
  }

  const args = ctx.match?.trim();
  if (!args) {
    ctx.reply('Usage: /ask <provider> <message>\nExample: /ask gemini What is the weather?');
    return;
  }

  const spaceIdx = args.indexOf(' ');
  if (spaceIdx === -1) {
    ctx.reply('Usage: /ask <provider> <message>');
    return;
  }

  const provider = args.slice(0, spaceIdx).toLowerCase();
  const message = args.slice(spaceIdx + 1);

  // Aliases
  const providerMap: Record<string, string> = {
    gemini: 'google',
    gpt: 'openai',
    codex: 'openai',
    claude: 'claude',
    google: 'google',
    openai: 'openai',
  };

  const resolvedProvider = providerMap[provider];
  if (!resolvedProvider) {
    ctx.reply(`Unknown provider: ${provider}\nValid: claude, gemini, codex, google, openai`);
    return;
  }

  const timestamp = new Date(ctx.message!.date * 1000).toISOString();
  const senderName = ctx.from?.first_name || ctx.from?.username || 'Unknown';
  const sender = ctx.from?.id.toString() || '';

  // Store as message with special prefix that index.ts will parse
  this.opts.onChatMetadata(jid, timestamp);
  this.opts.onMessage(jid, {
    id: ctx.message!.message_id.toString(),
    chat_jid: jid,
    sender,
    sender_name: senderName,
    content: `__ASK_${resolvedProvider.toUpperCase()}__ ${message}`,
    timestamp,
    is_from_me: false,
  });

  this.reactSeen(ctx.chat.id, ctx.message!.message_id);
});
```

**Step 3: Wire model callbacks in index.ts**

In `src/index.ts`, update the Telegram channel creation to include the new callbacks:

```typescript
const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
  ...channelOpts,
  onRegisterGroup: registerGroup,
  onClearSession: (jid: string) => { /* existing */ },
  onStopContainer: (jid: string) => { /* existing */ },
  onSetModel: (jid: string, provider: string, modelId?: string) => {
    const group = registeredGroups[jid];
    if (!group) return;
    setModelPreference(group.folder, { provider, modelId });
    logger.info({ jid, provider, modelId }, 'Model preference updated');
  },
  onGetModel: (jid: string) => {
    const group = registeredGroups[jid];
    if (!group) return { provider: 'claude' };
    return getModelPreference(group.folder);
  },
});
```

Import `getModelPreference` and `setModelPreference` from `./db.js`.

**Step 4: Pass provider to container in runAgent()**

In `src/index.ts`, update `runAgent()` to check for `/ask` prefix and model preference:

```typescript
async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  overrideProvider?: string,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Determine provider: override > group preference > claude
  const modelPref = overrideProvider
    ? { provider: overrideProvider }
    : getModelPreference(group.folder);

  // ... existing tasks/groups snapshot code ...

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: overrideProvider ? undefined : sessionId, // fresh session for /ask
        groupFolder: group.folder,
        chatJid,
        isMain,
        hostMcpServers: /* existing */,
        provider: modelPref.provider,
        modelId: modelPref.modelId,
      },
      // ... rest unchanged
    );
```

In `processGroupMessages()`, detect the `__ASK_` prefix:

```typescript
// Before calling runAgent, check for /ask prefix
let overrideProvider: string | undefined;
const askMatch = prompt.match(/^__ASK_(\w+)__ /);
if (askMatch) {
  overrideProvider = askMatch[1].toLowerCase();
  prompt = prompt.replace(/^__ASK_\w+__ /, '');
}

const output = await runAgent(group, prompt, chatJid, async (result) => {
  // ... existing callback ...
}, overrideProvider);
```

**Step 5: Commit**

```bash
git add src/channels/telegram.ts src/index.ts
git commit -m "feat: add /model and /ask commands for multi-model switching"
```

---

## Task 4: Pi-runner — Initialize project and IPC/protocol layer

**Files:**
- Create: `container/pi-runner/package.json`
- Create: `container/pi-runner/tsconfig.json`
- Create: `container/pi-runner/src/ipc.ts`
- Create: `container/pi-runner/src/protocol.ts`
- Copy: `container/agent-runner/src/ipc-mcp-stdio.ts` → `container/pi-runner/src/ipc-mcp-stdio.ts`

**Step 1: Create package.json**

```json
{
  "name": "nanoclaw-pi-runner",
  "version": "1.0.0",
  "type": "module",
  "description": "Pi-mono agent runner for NanoClaw",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@mariozechner/pi-agent-core": "latest",
    "@mariozechner/pi-coding-agent": "latest",
    "@mariozechner/pi-ai": "latest",
    "@modelcontextprotocol/sdk": "^1.12.1",
    "cron-parser": "^5.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.7",
    "typescript": "^5.7.3"
  }
}
```

**Step 2: Create tsconfig.json**

Copy from `container/agent-runner/tsconfig.json` verbatim.

**Step 3: Create src/protocol.ts — shared interfaces and output helpers**

```typescript
import fs from 'fs';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  hostMcpServers?: Record<string, { url: string }>;
  provider?: string;
  modelId?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

export function log(message: string): void {
  console.error(`[pi-runner] ${message}`);
}

export async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
```

**Step 4: Create src/ipc.ts — file-based IPC (copied from agent-runner)**

```typescript
import fs from 'fs';
import path from 'path';
import { log } from './protocol.js';

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

export { IPC_INPUT_DIR, IPC_POLL_MS };

export function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

export function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}
```

**Step 5: Copy ipc-mcp-stdio.ts verbatim**

```bash
cp container/agent-runner/src/ipc-mcp-stdio.ts container/pi-runner/src/ipc-mcp-stdio.ts
```

**Step 6: Install dependencies**

Run: `cd container/pi-runner && npm install`

**Step 7: Commit**

```bash
git add container/pi-runner/
git commit -m "feat: initialize pi-runner with IPC and protocol layer"
```

---

## Task 5: Pi-runner — MCP bridge (NanoClaw tools → Pi-mono AgentTool)

**Files:**
- Create: `container/pi-runner/src/mcp-bridge.ts`

**Step 1: Create MCP bridge**

The bridge starts the NanoClaw MCP server as a child process, discovers its tools, and converts them to Pi-mono `AgentTool` format using the `invoke_tool` pattern.

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Type } from '@sinclair/typebox';
import { log } from './protocol.js';

import type { AgentTool } from '@mariozechner/pi-agent-core';

export interface McpBridgeConfig {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  hostMcpServers?: Record<string, { url: string }>;
}

export class McpBridge {
  private clients: Map<string, Client> = new Map();
  private tools: AgentTool[] = [];

  async connect(config: McpBridgeConfig): Promise<void> {
    // Connect to NanoClaw MCP server
    await this.connectServer('nanoclaw', 'node', [config.mcpServerPath], {
      NANOCLAW_CHAT_JID: config.chatJid,
      NANOCLAW_GROUP_FOLDER: config.groupFolder,
      NANOCLAW_IS_MAIN: config.isMain ? '1' : '0',
    });

    // Connect to host MCP servers via HTTP
    for (const [name, serverConfig] of Object.entries(config.hostMcpServers || {})) {
      try {
        // For HTTP MCP servers, use SSE transport
        const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
        const transport = new SSEClientTransport(new URL(serverConfig.url));
        const client = new Client({ name: `nanoclaw-pi-${name}`, version: '1.0.0' });
        await client.connect(transport);
        this.clients.set(name, client);
        log(`Connected to host MCP server: ${name}`);
      } catch (err) {
        log(`Failed to connect to host MCP server ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Discover and convert all tools
    await this.discoverTools();
  }

  private async connectServer(
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<void> {
    const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env } });
    const client = new Client({ name: `nanoclaw-pi-${name}`, version: '1.0.0' });
    await client.connect(transport);
    this.clients.set(name, client);
    log(`Connected to MCP server: ${name}`);
  }

  private async discoverTools(): Promise<void> {
    this.tools = [];

    for (const [serverName, client] of this.clients) {
      try {
        const { tools } = await client.listTools();
        for (const tool of tools) {
          const fullName = `mcp__${serverName}__${tool.name}`;
          this.tools.push(this.convertTool(fullName, tool, client));
        }
        log(`Discovered ${tools.length} tools from ${serverName}`);
      } catch (err) {
        log(`Failed to discover tools from ${serverName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private convertTool(
    fullName: string,
    tool: { name: string; description?: string; inputSchema?: any },
    client: Client,
  ): AgentTool {
    return {
      name: fullName,
      label: fullName,
      description: tool.description || fullName,
      parameters: tool.inputSchema
        ? Type.Unsafe(tool.inputSchema)
        : Type.Object({}),
      execute: async (_toolCallId, params, _signal) => {
        try {
          const result = await client.callTool({ name: tool.name, arguments: params });
          const text = (result.content as Array<{ type: string; text?: string }>)
            .filter(c => c.type === 'text')
            .map(c => c.text || '')
            .join('\n');
          return {
            content: [{ type: 'text' as const, text }],
            details: {},
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            details: {},
            isError: true,
          };
        }
      },
    };
  }

  getTools(): AgentTool[] {
    return this.tools;
  }

  async disconnect(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
```

**Step 2: Verify it compiles**

Run: `cd container/pi-runner && npx tsc --noEmit`

**Step 3: Commit**

```bash
git add container/pi-runner/src/mcp-bridge.ts
git commit -m "feat: MCP bridge converting NanoClaw tools to Pi-mono AgentTool format"
```

---

## Task 6: Pi-runner — Session management

**Files:**
- Create: `container/pi-runner/src/session.ts`

**Step 1: Create session manager**

Uses Pi-mono's `SessionManager` for persistence. Sessions stored in `/workspace/group/.pi-sessions/`.

```typescript
import { SessionManager, createAgentSession } from '@mariozechner/pi-coding-agent';
import { log } from './protocol.js';
import fs from 'fs';
import path from 'path';

const SESSIONS_DIR = '/workspace/group/.pi-sessions';

export function getSessionDir(): string {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  return SESSIONS_DIR;
}

/**
 * Create a SessionManager that either continues an existing session
 * or starts a new one.
 */
export function createSessionManager(sessionId?: string): ReturnType<typeof SessionManager.create> | ReturnType<typeof SessionManager.open> {
  const sessDir = getSessionDir();

  if (sessionId) {
    // Try to open existing session file
    const sessionFile = path.join(sessDir, `${sessionId}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      log(`Resuming session: ${sessionId}`);
      return SessionManager.open(sessionFile);
    }
    log(`Session file not found: ${sessionFile}, creating new`);
  }

  log('Creating new session');
  return SessionManager.create('/workspace/group', sessDir);
}

/**
 * Extract session ID from a SessionManager's file path.
 */
export function extractSessionId(sessionManager: any): string | undefined {
  // SessionManager stores the session file path internally
  // The ID is the filename without extension
  try {
    const filePath = sessionManager.sessionPath || sessionManager.path;
    if (filePath) {
      return path.basename(filePath, '.jsonl');
    }
  } catch {
    /* ignore */
  }
  return undefined;
}
```

**Step 2: Commit**

```bash
git add container/pi-runner/src/session.ts
git commit -m "feat: Pi-mono session management with file persistence"
```

---

## Task 7: Pi-runner — Main agent loop (index.ts)

**Files:**
- Create: `container/pi-runner/src/index.ts`

**Step 1: Create main entry point**

This is the core — replaces Claude SDK's `query()` with Pi-mono's `createAgentSession` + `session.prompt()`.

```typescript
/**
 * NanoClaw Pi-mono Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Same protocol as the Claude agent-runner (stdin JSON, stdout markers, file IPC).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createAgentSession,
  SessionManager,
  codingTools,
  type AuthStorage,
  type ModelRegistry,
} from '@mariozechner/pi-coding-agent';

import { ContainerInput, ContainerOutput, writeOutput, readStdin, log } from './protocol.js';
import { shouldClose, drainIpcInput, waitForIpcMessage, IPC_INPUT_DIR, IPC_POLL_MS } from './ipc.js';
import { McpBridge } from './mcp-bridge.js';
import { createSessionManager, extractSessionId } from './session.js';

const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');

function buildSystemPrompt(input: ContainerInput): string {
  const parts: string[] = [];

  // Load group CLAUDE.md
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  // Load global CLAUDE.md for non-main groups
  const globalClaudeMd = '/workspace/global/CLAUDE.md';
  if (!input.isMain && fs.existsSync(globalClaudeMd)) {
    parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
  }

  // Load extra directories CLAUDE.md
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const mdPath = path.join(extraBase, entry, 'CLAUDE.md');
      if (fs.existsSync(mdPath)) {
        parts.push(fs.readFileSync(mdPath, 'utf-8'));
      }
    }
  }

  return parts.join('\n\n---\n\n');
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}, provider: ${containerInput.provider}, model: ${containerInput.modelId}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Set up API keys in environment for Pi-mono
  const secrets = containerInput.secrets || {};
  for (const [key, value] of Object.entries(secrets)) {
    process.env[key] = value;
  }
  delete containerInput.secrets;

  // Connect MCP bridge
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const mcpBridge = new McpBridge();

  try {
    await mcpBridge.connect({
      mcpServerPath,
      chatJid: containerInput.chatJid,
      groupFolder: containerInput.groupFolder,
      isMain: containerInput.isMain,
      hostMcpServers: containerInput.hostMcpServers,
    });
  } catch (err) {
    log(`MCP bridge connect failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Determine model string: "provider/modelId"
  const provider = containerInput.provider || 'google';
  const modelId = containerInput.modelId || 'gemini-2.5-flash';
  const modelString = `${provider}/${modelId}`;
  log(`Using model: ${modelString}`);

  // Build system prompt from CLAUDE.md files
  const systemPrompt = buildSystemPrompt(containerInput);

  // Create session
  const sessionManager = createSessionManager(containerInput.sessionId);

  // Create agent session with Pi-mono
  const { session } = await createAgentSession({
    sessionManager,
    model: modelString,
    tools: codingTools,
    customTools: mcpBridge.getTools(),
    systemPrompt: systemPrompt || undefined,
  });

  // Subscribe to events for logging
  session.on('message', (msg: any) => {
    if (msg.role === 'assistant') {
      const textParts = (msg.content || [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text);
      const text = textParts.join('');
      if (text) {
        log(`Assistant: ${text.slice(0, 200)}`);
        writeOutput({
          status: 'success',
          result: text,
          newSessionId: extractSessionId(sessionManager),
        });
      }
    }
  });

  // Query loop
  try {
    // Send initial prompt
    log(`Sending initial prompt (${prompt.length} chars)...`);
    await session.prompt(prompt);

    // After initial prompt completes, enter IPC wait loop
    while (true) {
      // Check for close sentinel
      if (shouldClose()) {
        log('Close sentinel received, exiting');
        break;
      }

      // Emit session update
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: extractSessionId(sessionManager),
      });

      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), sending to session`);
      await session.prompt(nextMessage);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: extractSessionId(sessionManager),
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    await mcpBridge.disconnect();
  }
}

main();
```

**Step 2: Verify it compiles**

Run: `cd container/pi-runner && npx tsc --noEmit`

Note: This may require adjustments depending on exact Pi-mono API types. Resolve import issues as needed.

**Step 3: Commit**

```bash
git add container/pi-runner/src/index.ts
git commit -m "feat: Pi-mono agent runner with full IPC integration"
```

---

## Task 8: Pi-runner — Dockerfile and build script

**Files:**
- Create: `container/Dockerfile.pi`
- Modify: `container/build.sh`

**Step 1: Create Dockerfile.pi**

```dockerfile
# NanoClaw Pi-mono Agent Container
# Runs Pi-mono agent framework in isolated Linux VM

FROM node:22-slim

# Install system dependencies (browser, git, python — same as Claude image)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3 \
    python3-venv \
    unzip \
    && rm -rf /var/lib/apt/lists/*

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install uv, bun, pnpm (same as Claude image)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install agent-browser globally
RUN npm install -g agent-browser

WORKDIR /app

# Copy package files first for caching
COPY pi-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY pi-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Entrypoint: recompile source (agent may customize), then run
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

RUN chown -R node:node /workspace && chmod 777 /home/node
USER node
WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
```

**Step 2: Update build.sh to support Pi image**

Add Pi-mono build support to `container/build.sh`:

```bash
# After existing build, add:

# Build Pi-mono image if pi-runner/ exists
if [ -d "$SCRIPT_DIR/pi-runner" ]; then
  PI_IMAGE_NAME="nanoclaw-pi"
  echo ""
  echo "Building Pi-mono agent container image..."
  echo "Image: ${PI_IMAGE_NAME}:${TAG}"

  ${CONTAINER_RUNTIME} build -t "${PI_IMAGE_NAME}:${TAG}" -f Dockerfile.pi .

  echo ""
  echo "Pi-mono build complete!"
  echo "Image: ${PI_IMAGE_NAME}:${TAG}"
fi
```

**Step 3: Build and verify**

Run: `cd container && ./build.sh`

Expected: Both images build successfully.

**Step 4: Commit**

```bash
git add container/Dockerfile.pi container/build.sh
git commit -m "feat: Dockerfile and build script for Pi-mono agent container"
```

---

## Task 9: Host-side — Pi-runner mount handling in container-runner

**Files:**
- Modify: `src/container-runner.ts`

**Step 1: Adjust volume mounts for Pi-runner**

The Pi-runner doesn't need `.claude/` directory (settings, skills, plugins). Instead it needs the pi-runner source.

In `src/container-runner.ts`, update `buildVolumeMounts()` to be provider-aware:

```typescript
function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  provider?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  // ... existing group/global mounts (same for all providers) ...

  if (!provider || provider === 'claude') {
    // Claude-specific: .claude/ sessions directory, skills, plugins
    // ... existing code unchanged ...
  }

  // Per-group IPC namespace (same for all providers)
  // ... existing IPC mount code ...

  // Agent runner source: select based on provider
  const runnerDir = (!provider || provider === 'claude') ? 'agent-runner' : 'pi-runner';
  const agentRunnerSrc = path.join(projectRoot, 'container', runnerDir, 'src');
  const groupAgentRunnerDir = path.join(DATA_DIR, 'sessions', group.folder, `${runnerDir}-src`);
  if (fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Host exec stubs (same for all providers)
  // ... existing host-exec code ...

  // Additional mounts (same for all providers)
  // ... existing additional mounts code ...

  return mounts;
}
```

Update the call to `buildVolumeMounts()` in `runContainerAgent()`:

```typescript
const mounts = buildVolumeMounts(group, input.isMain, input.provider);
```

**Step 2: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: provider-aware volume mounts for Pi-mono containers"
```

---

## Task 10: Integration test — End-to-end model switching

**Step 1: Manual smoke test**

1. Build both images: `cd container && ./build.sh`
2. Start NanoClaw: `npm run dev`
3. In Telegram, send `/model` — should show "Current model: claude"
4. Send `/model google` — should respond "Model switched to google. Session cleared."
5. Send a message — should spawn `nanoclaw-pi` container and get a Gemini response
6. Send `/model claude` — switch back
7. Send `/ask gemini What is 2+2?` — should use Gemini for one message
8. Next message should go back to Claude

**Step 2: Verify container logs**

Check `groups/{folder}/logs/` for container logs showing correct provider.

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration fixes for multi-model agent support"
```

---

## Task 11: OAuth stub — /auth command placeholder

**Files:**
- Modify: `src/channels/telegram.ts`

**Step 1: Add /auth command placeholder**

Pi-mono's OAuth flow requires further investigation into the specific API. Add a stub that stores keys directly for now:

```typescript
this.bot.command('auth', (ctx) => {
  const args = ctx.match?.trim();
  if (!args) {
    ctx.reply('Usage: /auth <provider> <api_key>\nProviders: google, openai\n\nNote: Full OAuth flow coming soon. For now, set keys in .env file.');
    return;
  }

  // For now, direct user to .env
  ctx.reply(`To set up ${args} authentication, add the API key to your .env file:\n\nFor Google: GOOGLE_API_KEY=...\nFor OpenAI: OPENAI_API_KEY=...\n\nThen restart NanoClaw.`);
});
```

**Step 2: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat: add /auth command stub for provider authentication"
```

---

## Summary

| Task | Description | Estimated Effort |
|------|-------------|-----------------|
| 1 | DB + types for model preference | Small |
| 2 | Config + container-runner provider selection | Small |
| 3 | Telegram /model and /ask commands | Medium |
| 4 | Pi-runner project init + IPC layer | Small (copy) |
| 5 | MCP bridge (NanoClaw tools → AgentTool) | Medium |
| 6 | Session management | Small |
| 7 | Main agent loop (index.ts) | Large (core) |
| 8 | Dockerfile + build script | Small |
| 9 | Provider-aware volume mounts | Small |
| 10 | Integration test | Medium |
| 11 | OAuth stub | Small |

**Critical path:** Tasks 1-3 (host-side) can proceed in parallel with Tasks 4-8 (pi-runner). Task 9 bridges them. Task 10 validates everything.
