import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Type } from '@sinclair/typebox';
import { log } from './protocol.js';

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

export interface McpBridgeConfig {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  hostMcpServers?: Record<string, { url: string }>;
}

export class McpBridge {
  private clients: Map<string, Client> = new Map();
  private tools: ToolDefinition[] = [];

  async connect(config: McpBridgeConfig): Promise<void> {
    // Connect to NanoClaw MCP server
    await this.connectServer('nanoclaw', 'node', [config.mcpServerPath], {
      NANOCLAW_CHAT_JID: config.chatJid,
      NANOCLAW_GROUP_FOLDER: config.groupFolder,
      NANOCLAW_IS_MAIN: config.isMain ? '1' : '0',
    });

    // Connect to host MCP servers via SSE
    for (const [name, serverConfig] of Object.entries(config.hostMcpServers || {})) {
      try {
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
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) mergedEnv[k] = v;
    }
    Object.assign(mergedEnv, env);
    const transport = new StdioClientTransport({ command, args, env: mergedEnv });
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
  ): ToolDefinition {
    return {
      name: fullName,
      label: fullName,
      description: tool.description || fullName,
      parameters: tool.inputSchema
        ? Type.Unsafe(tool.inputSchema)
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
