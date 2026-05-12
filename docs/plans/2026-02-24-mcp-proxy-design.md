# MCP Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Share host MCP servers (pencil, chrome_devtools, codanna) with container agents via an HTTP proxy built into NanoClaw.

**Architecture:** Host process reads `~/.claude.json` mcpServers, spawns stdio MCP servers on-demand, exposes them as Streamable HTTP endpoints on localhost. Container agents connect via `host.docker.internal`. Uses `@modelcontextprotocol/sdk` for protocol handling.

**Tech Stack:** `@modelcontextprotocol/sdk` (Client, StdioClientTransport, Server, StreamableHTTPServerTransport), Node.js `http` module.

---

### Task 1: Add MCP SDK Dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the SDK**

Run: `cd /home/anc/work/NanoClaw && npm install @modelcontextprotocol/sdk`

**Step 2: Verify installation**

Run: `node -e "import('@modelcontextprotocol/sdk/client/index.js').then(m => console.log('OK', Object.keys(m)))"`
Expected: OK followed by exported names including `Client`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk for MCP proxy"
```

---

### Task 2: Create MCP Proxy Module — Config Reader

**Files:**
- Create: `src/mcp-proxy.ts`
- Test: `src/mcp-proxy.test.ts`

**Step 1: Write the failing test for config reading**

```typescript
// src/mcp-proxy.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readHostMcpServers } from './mcp-proxy.js';
import fs from 'fs';

vi.mock('fs');

describe('readHostMcpServers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads stdio mcpServers from ~/.claude.json', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      mcpServers: {
        pencil: { command: '/opt/pencil/mcp', args: ['--app', 'desktop'], env: {} },
        chrome_devtools: { command: 'npx', args: ['chrome-devtools-mcp@latest'] },
      },
    }));

    const servers = readHostMcpServers();
    expect(servers).toEqual({
      pencil: { command: '/opt/pencil/mcp', args: ['--app', 'desktop'], env: {} },
      chrome_devtools: { command: 'npx', args: ['chrome-devtools-mcp@latest'] },
    });
  });

  it('returns empty object when file missing', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const servers = readHostMcpServers();
    expect(servers).toEqual({});
  });

  it('skips non-stdio servers (type: http/sse)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      mcpServers: {
        local_tool: { command: 'node', args: ['server.js'] },
        remote_api: { type: 'http', url: 'https://example.com/mcp' },
      },
    }));

    const servers = readHostMcpServers();
    expect(servers).toEqual({
      local_tool: { command: 'node', args: ['server.js'] },
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /home/anc/work/NanoClaw && npx vitest run src/mcp-proxy.test.ts`
Expected: FAIL — module `./mcp-proxy.js` has no export `readHostMcpServers`

**Step 3: Write minimal implementation**

```typescript
// src/mcp-proxy.ts
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface StdioMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const CLAUDE_JSON_PATH = path.join(
  process.env.HOME || '/home/user',
  '.claude.json',
);

/**
 * Read stdio-type MCP server configs from ~/.claude.json.
 * Skips servers with explicit type (http, sse) — only stdio (default) servers are proxied.
 */
export function readHostMcpServers(): Record<string, StdioMcpServerConfig> {
  if (!fs.existsSync(CLAUDE_JSON_PATH)) {
    logger.info('No ~/.claude.json found, MCP proxy will have no servers');
    return {};
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, 'utf-8'));
    const mcpServers = raw?.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object') return {};

    const result: Record<string, StdioMcpServerConfig> = {};
    for (const [name, config] of Object.entries(mcpServers)) {
      const c = config as Record<string, unknown>;
      // Skip non-stdio servers (http, sse have explicit type field)
      if (c.type && c.type !== 'stdio') continue;
      if (!c.command) continue;
      result[name] = {
        command: c.command as string,
        args: (c.args as string[]) || [],
        env: (c.env as Record<string, string>) || undefined,
      };
    }

    logger.info({ servers: Object.keys(result) }, 'Read host MCP server configs');
    return result;
  } catch (err) {
    logger.warn({ err }, 'Failed to read ~/.claude.json MCP config');
    return {};
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/anc/work/NanoClaw && npx vitest run src/mcp-proxy.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/mcp-proxy.ts src/mcp-proxy.test.ts
git commit -m "feat(mcp-proxy): add config reader for host MCP servers"
```

---

### Task 3: Create MCP Proxy Module — HTTP Proxy Server

**Files:**
- Modify: `src/mcp-proxy.ts`

This is the core: an HTTP server that creates per-server proxy routes, spawning stdio MCP clients lazily and forwarding requests.

**Step 1: Add the proxy server class to `src/mcp-proxy.ts`**

Append to the existing file:

```typescript
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

interface StdioClientEntry {
  client: Client;
  transport: StdioClientTransport;
}

export const MCP_PROXY_PORT = parseInt(process.env.MCP_PROXY_PORT || '18321', 10);

export class McpProxyServer {
  private configs: Record<string, StdioMcpServerConfig>;
  private clients: Map<string, StdioClientEntry> = new Map();
  private httpServer: http.Server | null = null;

  constructor(configs: Record<string, StdioMcpServerConfig>) {
    this.configs = configs;
  }

  /** Connect to (or reconnect) a stdio MCP server */
  private async getClient(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing.client;

    const config = this.configs[name];
    if (!config) throw new Error(`Unknown MCP server: ${name}`);

    logger.info({ name, command: config.command }, 'Spawning MCP stdio server');
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
    });

    const client = new Client({ name: `proxy-${name}`, version: '1.0.0' });
    await client.connect(transport);

    // Auto-cleanup on close so next request respawns
    transport.onclose = () => {
      logger.warn({ name }, 'MCP stdio server disconnected, will respawn on next request');
      this.clients.delete(name);
    };

    this.clients.set(name, { client, transport });
    return client;
  }

  /** Handle a JSON-RPC MCP request for a specific server */
  private async handleMcpRequest(
    serverName: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const client = await this.getClient(serverName);
    const method = body.method as string;
    const params = (body.params || {}) as Record<string, unknown>;
    const id = body.id;

    try {
      let result: unknown;
      switch (method) {
        case 'initialize':
          // Return proxy capabilities — the client is already initialized
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: `proxy-${serverName}`, version: '1.0.0' },
            },
          };
        case 'notifications/initialized':
          // Client notification, acknowledge silently
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          result = await client.listTools(params as { cursor?: string });
          break;
        case 'tools/call':
          result = await client.callTool(params as { name: string; arguments?: Record<string, unknown> });
          break;
        case 'resources/list':
          result = await client.listResources(params as { cursor?: string });
          break;
        case 'resources/read':
          result = await client.readResource(params as { uri: string });
          break;
        case 'resources/templates/list':
          result = await client.listResourceTemplates(params as { cursor?: string });
          break;
        case 'prompts/list':
          result = await client.listPrompts(params as { cursor?: string });
          break;
        case 'prompts/get':
          result = await client.getPrompt(params as { name: string; arguments?: Record<string, string> });
          break;
        case 'ping':
          result = {};
          break;
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      logger.error({ serverName, method, err }, 'MCP proxy request failed');
      // Disconnect broken client so it respawns
      this.clients.delete(serverName);
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  async start(): Promise<void> {
    if (Object.keys(this.configs).length === 0) {
      logger.info('No MCP servers to proxy, skipping HTTP server');
      return;
    }

    this.httpServer = http.createServer(async (req, res) => {
      // Route: POST /mcp/:serverName
      const match = req.url?.match(/^\/mcp\/([^/]+)$/);
      if (!match || req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const serverName = match[1];
      if (!this.configs[serverName]) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown MCP server: ${serverName}` }));
        return;
      }

      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const bodyStr = Buffer.concat(chunks).toString();

      try {
        const body = JSON.parse(bodyStr);
        const response = await this.handleMcpRequest(serverName, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(MCP_PROXY_PORT, '127.0.0.1', () => {
        logger.info(
          { port: MCP_PROXY_PORT, servers: Object.keys(this.configs) },
          'MCP proxy server started',
        );
        resolve();
      });
      this.httpServer!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    // Close all stdio clients
    for (const [name, entry] of this.clients) {
      logger.info({ name }, 'Closing MCP stdio client');
      await entry.client.close().catch(() => {});
    }
    this.clients.clear();

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  /** Get the list of proxied server names */
  getServerNames(): string[] {
    return Object.keys(this.configs);
  }
}
```

**Step 2: Verify it compiles**

Run: `cd /home/anc/work/NanoClaw && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/mcp-proxy.ts
git commit -m "feat(mcp-proxy): add HTTP proxy server for stdio MCP servers"
```

---

### Task 4: Wire MCP Proxy into NanoClaw Lifecycle

**Files:**
- Modify: `src/index.ts`
- Modify: `src/config.ts`

**Step 1: Add config export to `src/config.ts`**

Add after the existing TIMEZONE export:

```typescript
// MCP Proxy port for exposing host MCP servers to container agents
export const MCP_PROXY_PORT = parseInt(process.env.MCP_PROXY_PORT || '18321', 10);
```

**Step 2: Import and start MCP proxy in `src/index.ts`**

Add import at the top of `src/index.ts`:

```typescript
import { McpProxyServer, readHostMcpServers } from './mcp-proxy.js';
```

Add at the module level (near other `let` declarations):

```typescript
let mcpProxy: McpProxyServer | null = null;
```

Add at the beginning of `main()`, after `initDatabase()`:

```typescript
  // Start MCP proxy to share host MCP servers with container agents
  const hostMcpConfigs = readHostMcpServers();
  mcpProxy = new McpProxyServer(hostMcpConfigs);
  await mcpProxy.start();
```

Add to the `shutdown` function, before `process.exit(0)`:

```typescript
    if (mcpProxy) await mcpProxy.stop();
```

**Step 3: Verify it compiles**

Run: `cd /home/anc/work/NanoClaw && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/index.ts src/config.ts
git commit -m "feat: wire MCP proxy into NanoClaw startup/shutdown lifecycle"
```

---

### Task 5: Pass Host MCP Servers to Container

**Files:**
- Modify: `src/container-runner.ts`

**Step 1: Add `hostMcpServers` to `ContainerInput` interface**

In `src/container-runner.ts`, add to the `ContainerInput` interface:

```typescript
  hostMcpServers?: Record<string, { url: string }>;
```

**Step 2: Add `--add-host` flag to container args**

In `buildContainerArgs()`, after the `--user` block (around line 204), add:

```typescript
  // Allow container to reach host MCP proxy via host.docker.internal
  args.push('--add-host=host.docker.internal:host-gateway');
```

**Step 3: Pass `hostMcpServers` when building `ContainerInput`**

This is done in `src/index.ts` where `runContainerAgent` is called. We need to find where `ContainerInput` is constructed and add the `hostMcpServers` field. Look at `processGroupMessages()` in `src/index.ts`.

In `src/index.ts`, where `ContainerInput` is built (in `processGroupMessages`), add:

```typescript
    // Build host MCP server URLs for the container
    const hostMcpServers: Record<string, { url: string }> = {};
    if (mcpProxy) {
      for (const name of mcpProxy.getServerNames()) {
        hostMcpServers[name] = {
          url: `http://host.docker.internal:${MCP_PROXY_PORT}/mcp/${name}`,
        };
      }
    }
```

And include it in the input object:

```typescript
    hostMcpServers: Object.keys(hostMcpServers).length > 0 ? hostMcpServers : undefined,
```

**Step 4: Verify it compiles**

Run: `cd /home/anc/work/NanoClaw && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/container-runner.ts src/index.ts
git commit -m "feat: pass host MCP server URLs to container agents"
```

---

### Task 6: Container Agent-Runner Consumes Host MCP Servers

**Files:**
- Modify: `container/agent-runner/src/index.ts`

**Step 1: Add `hostMcpServers` to agent-runner's `ContainerInput`**

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
}
```

**Step 2: Merge host MCP servers into SDK `mcpServers` config**

In the `query()` call (around line 441), change `mcpServers` from:

```typescript
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
```

to:

```typescript
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        // Proxy host MCP servers via HTTP
        ...Object.fromEntries(
          Object.entries(containerInput.hostMcpServers || {}).map(
            ([name, config]) => [name, { type: 'http' as const, url: config.url }],
          ),
        ),
      },
```

**Step 3: Add host MCP server tools to `allowedTools`**

Change `allowedTools` to dynamically include host MCP wildcards:

```typescript
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        // Allow all tools from host MCP servers
        ...Object.keys(containerInput.hostMcpServers || {}).map(
          (name) => `mcp__${name}__*`,
        ),
      ],
```

**Step 4: Verify agent-runner compiles**

Run: `cd /home/anc/work/NanoClaw/container/agent-runner && npx tsc --noEmit`
Expected: No errors (or compile inside container)

**Step 5: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): consume host MCP servers via HTTP proxy"
```

---

### Task 7: Integration Test

**Files:**
- None (manual testing)

**Step 1: Build the container image**

Run: `cd /home/anc/work/NanoClaw && ./container/build.sh`

**Step 2: Start NanoClaw in dev mode and verify proxy starts**

Run: `cd /home/anc/work/NanoClaw && npm run dev`

Look for log output:
```
MCP proxy server started {"port":18321,"servers":["pencil","chrome_devtools","codanna"]}
```

**Step 3: Test the proxy endpoint directly**

Run from another terminal:

```bash
curl -s -X POST http://127.0.0.1:18321/mcp/chrome_devtools \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

Expected: JSON response with `result.serverInfo`

```bash
curl -s -X POST http://127.0.0.1:18321/mcp/chrome_devtools \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Expected: JSON response with `result.tools` array listing Chrome DevTools tools

**Step 4: Test from a container agent**

Send a message to the bot that uses a host MCP tool (e.g., Chrome DevTools). Verify the tool call succeeds and the agent can control the host browser.

**Step 5: Commit all final adjustments**

```bash
git add -A
git commit -m "feat: MCP proxy — share host MCP servers with container agents"
```
