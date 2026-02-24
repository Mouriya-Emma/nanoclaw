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
