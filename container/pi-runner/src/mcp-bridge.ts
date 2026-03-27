import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import http from 'http';
import { Type } from '@sinclair/typebox';
import { log } from './protocol.js';

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

/**
 * Sanitize JSON Schema for Google Cloud Code Assist API compatibility.
 * Removes/transforms unsupported fields recursively:
 * - $schema (not recognized)
 * - exclusiveMinimum/exclusiveMaximum (not supported, converted to minimum/maximum)
 * - type arrays like ["string", "null"] (converted to single type + nullable)
 * - anyOf/oneOf with null (converted to type + nullable)
 */
function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);

  const result: any = {};
  for (const [key, value] of Object.entries(schema)) {
    // Skip unsupported top-level fields
    if (key === '$schema') continue;

    // Convert exclusiveMinimum/exclusiveMaximum to minimum/maximum
    if (key === 'exclusiveMinimum' && typeof value === 'number') {
      if (!('minimum' in schema)) result.minimum = value;
      continue;
    }
    if (key === 'exclusiveMaximum' && typeof value === 'number') {
      if (!('maximum' in schema)) result.maximum = value;
      continue;
    }

    // Convert type arrays: ["string", "null"] → type: "string", nullable: true
    if (key === 'type' && Array.isArray(value)) {
      const nonNull = value.filter((t: string) => t !== 'null');
      result.type = nonNull.length === 1 ? nonNull[0] : nonNull[0] || 'string';
      if (value.includes('null')) result.nullable = true;
      continue;
    }

    // Convert anyOf/oneOf containing {type: "null"} → nullable + remaining type
    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      const nonNull = value.filter((v: any) => !(v?.type === 'null'));
      const hasNull = value.some((v: any) => v?.type === 'null');
      if (hasNull && nonNull.length === 1) {
        Object.assign(result, sanitizeSchema(nonNull[0]));
        result.nullable = true;
        continue;
      }
    }

    // Recurse into nested objects
    result[key] = sanitizeSchema(value);
  }
  return result;
}

/** Minimal MCP-like interface for tool listing and calling. */
interface ToolClient {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: any }> }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  close(): Promise<void>;
}

/**
 * Lightweight JSON-RPC over HTTP POST client for connecting to the NanoClaw MCP proxy.
 * The proxy expects: POST /mcp/:serverName with JSON-RPC body.
 */
class HttpJsonRpcClient implements ToolClient {
  private url: string;
  private nextId = 1;

  constructor(url: string) {
    this.url = url;
  }

  private async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
    });

    const parsed = new URL(this.url);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString());
              if (json.error) {
                reject(new Error(json.error.message || JSON.stringify(json.error)));
              } else {
                resolve(json.result);
              }
            } catch (err) {
              reject(new Error(`Invalid JSON response from ${this.url}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error(`Request to ${this.url} timed out`)); });
      req.write(body);
      req.end();
    });
  }

  async listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: any }> }> {
    return this.request('tools/list');
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{ content: Array<{ type: string; text?: string }> }> {
    return this.request('tools/call', params);
  }

  async close(): Promise<void> {
    // HTTP client is stateless, nothing to close
  }
}

export interface McpBridgeConfig {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  hostMcpServers?: Record<string, { url: string }>;
}

export class McpBridge {
  private clients: Map<string, ToolClient> = new Map();
  private tools: ToolDefinition[] = [];

  async connect(config: McpBridgeConfig): Promise<void> {
    // Connect to NanoClaw MCP server (stdio)
    await this.connectStdioServer('nanoclaw', 'node', [config.mcpServerPath], {
      NANOCLAW_CHAT_JID: config.chatJid,
      NANOCLAW_GROUP_FOLDER: config.groupFolder,
      NANOCLAW_IS_MAIN: config.isMain ? '1' : '0',
    });

    // Connect to host MCP servers via JSON-RPC HTTP POST proxy
    for (const [name, serverConfig] of Object.entries(config.hostMcpServers || {})) {
      try {
        const client = new HttpJsonRpcClient(serverConfig.url);
        // Verify connection by listing tools
        await client.listTools();
        this.clients.set(name, client);
        log(`Connected to host MCP server: ${name}`);
      } catch (err) {
        log(`Failed to connect to host MCP server ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Discover and convert all tools
    await this.discoverTools();
  }

  private async connectStdioServer(
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<void> {
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) mergedEnv[k] = v;
    }
    Object.assign(mergedEnv, env);
    const transport = new StdioClientTransport({ command, args, env: mergedEnv });
    const client = new Client({ name: `nanoclaw-pi-${name}`, version: '1.0.0' });
    await client.connect(transport);
    // Wrap MCP Client as ToolClient (type adapter)
    this.clients.set(name, {
      listTools: () => client.listTools() as any,
      callTool: (p) => client.callTool(p) as any,
      close: () => client.close(),
    });
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
    client: ToolClient,
  ): ToolDefinition {
    return {
      name: fullName,
      label: fullName,
      description: tool.description || fullName,
      parameters: tool.inputSchema
        ? Type.Unsafe(sanitizeSchema(tool.inputSchema))
        : Type.Object({}),
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        try {
          const result = await client.callTool({ name: tool.name, arguments: params as Record<string, unknown> });
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
          };
        }
      },
    };
  }

  getTools(): ToolDefinition[] {
    return this.tools;
  }

  async disconnect(): Promise<void> {
    for (const [_name, client] of this.clients) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
