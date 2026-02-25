import { spawn as spawnChild } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

interface StdioClientEntry {
  client: Client;
  transport: StdioClientTransport;
}

export const MCP_PROXY_PORT = parseInt(process.env.MCP_PROXY_PORT || '18321', 10);

/**
 * Read the host command execution allowlist.
 * Accepts an explicit value (from config/env reader) or falls back to
 * process.env.HOST_EXEC_ALLOWLIST.
 */
export function readHostExecAllowlist(raw?: string): string[] {
  const value = raw ?? process.env.HOST_EXEC_ALLOWLIST ?? '';
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const EXEC_TIMEOUT = 120_000;
const EXEC_MAX_OUTPUT = 1024 * 1024; // 1MB per stream

export class McpProxyServer {
  private configs: Record<string, StdioMcpServerConfig>;
  private clients: Map<string, StdioClientEntry> = new Map();
  private httpServer: http.Server | null = null;
  private execAllowlist: Set<string>;

  constructor(
    configs: Record<string, StdioMcpServerConfig>,
    execAllowlist: string[] = [],
  ) {
    this.configs = configs;
    this.execAllowlist = new Set(execAllowlist);
  }

  /** Execute a whitelisted command on the host */
  private execHostCommand(body: {
    command: string;
    args?: string[];
    stdin?: string;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { command, args = [], stdin } = body;

    if (!this.execAllowlist.has(command)) {
      return Promise.resolve({
        stdout: '',
        stderr: `host-exec: command not allowed: ${command}`,
        exitCode: 126,
      });
    }

    // Security: resolve the command to an absolute path, refuse relative/path traversal
    const basename = path.basename(command);
    if (basename !== command) {
      return Promise.resolve({
        stdout: '',
        stderr: `host-exec: invalid command name: ${command}`,
        exitCode: 126,
      });
    }

    return new Promise((resolve) => {
      logger.info({ command, args }, 'host-exec: executing');

      const proc = spawnChild(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: EXEC_TIMEOUT,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let stdoutTrunc = false;
      let stderrTrunc = false;

      proc.stdout.on('data', (chunk: Buffer) => {
        if (stdoutTrunc) return;
        const s = chunk.toString();
        if (stdout.length + s.length > EXEC_MAX_OUTPUT) {
          stdout += s.slice(0, EXEC_MAX_OUTPUT - stdout.length);
          stdoutTrunc = true;
        } else {
          stdout += s;
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        if (stderrTrunc) return;
        const s = chunk.toString();
        if (stderr.length + s.length > EXEC_MAX_OUTPUT) {
          stderr += s.slice(0, EXEC_MAX_OUTPUT - stderr.length);
          stderrTrunc = true;
        } else {
          stderr += s;
        }
      });

      if (stdin) {
        proc.stdin.write(stdin);
      }
      proc.stdin.end();

      proc.on('close', (code) => {
        logger.info({ command, exitCode: code }, 'host-exec: completed');
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', (err) => {
        logger.error({ command, err }, 'host-exec: spawn error');
        resolve({
          stdout: '',
          stderr: `host-exec: ${err.message}`,
          exitCode: 127,
        });
      });
    });
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
      env: { ...process.env, ...config.env } as Record<string, string>,
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
    const hasMcp = Object.keys(this.configs).length > 0;
    const hasExec = this.execAllowlist.size > 0;
    if (!hasMcp && !hasExec) {
      logger.info('No MCP servers or exec commands to proxy, skipping HTTP server');
      return;
    }

    this.httpServer = http.createServer(async (req, res) => {
      // Read request body helper
      const readBody = async (): Promise<string> => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks).toString();
      };

      // Route: POST /exec — host command execution
      if (req.url === '/exec' && req.method === 'POST') {
        try {
          const body = JSON.parse(await readBody());
          const result = await this.execHostCommand(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ stdout: '', stderr: 'Bad request', exitCode: 1 }));
        }
        return;
      }

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

      try {
        const body = JSON.parse(await readBody());
        const response = await this.handleMcpRequest(serverName, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(MCP_PROXY_PORT, '0.0.0.0', () => {
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
