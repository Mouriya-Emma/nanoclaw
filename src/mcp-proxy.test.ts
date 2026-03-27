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
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        mcpServers: {
          pencil: {
            command: '/opt/pencil/mcp',
            args: ['--app', 'desktop'],
            env: {},
          },
          chrome_devtools: {
            command: 'npx',
            args: ['chrome-devtools-mcp@latest'],
          },
        },
      }),
    );

    const servers = readHostMcpServers();
    expect(servers).toEqual({
      pencil: {
        command: '/opt/pencil/mcp',
        args: ['--app', 'desktop'],
        env: {},
      },
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
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        mcpServers: {
          local_tool: { command: 'node', args: ['server.js'] },
          remote_api: { type: 'http', url: 'https://example.com/mcp' },
        },
      }),
    );

    const servers = readHostMcpServers();
    expect(servers).toEqual({
      local_tool: { command: 'node', args: ['server.js'] },
    });
  });
});
