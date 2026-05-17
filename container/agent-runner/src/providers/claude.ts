import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'child_process';
import { fileURLToPath } from 'url';

import {
  AGENT_CHANNEL_SERVER_NAME,
  NANOCLAW_INBOUND_BODY_KIND,
  startClaudeChannelExchange,
  type ClaudeChannelExchange,
  type ClaudeChannelExchangeFactory,
} from '../fork-features/claude-channel-exchange.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred Claude Code builtins that either sidestep nanoclaw's own scheduling
// or don't fit the async message-passing model.
const CLAUDE_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;
const AGENT_CHANNEL_MCP_PATH = fileURLToPath(new URL('../fork-features/agent-channel-mcp.ts', import.meta.url));

type SpawnClaude = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  errors?: string[];
  is_error?: boolean;
  message?: {
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  };
  summary?: string;
  compact_metadata?: { pre_tokens?: number };
  tool_name?: string;
  elapsed_time_seconds?: number;
  rate_limit_info?: unknown;
};

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private error: unknown;

  push(value: T): void {
    if (this.closed) return;
    this.values.push(value);
    this.resolveOne();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveAll();
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.error = error;
    this.closed = true;
    this.resolveAll();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.values.length > 0) {
        yield this.values.shift()!;
      }
      if (this.error) throw this.error;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  private resolveOne(): void {
    this.waiters.shift()?.();
  }

  private resolveAll(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

function userMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
  };
}

function writeJsonLine(child: ChildProcessWithoutNullStreams, message: SDKUserMessage): void {
  child.stdin.write(JSON.stringify(message) + '\n');
}

function splitLines(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
    }
  };
}

function parseStreamEvent(line: string): ClaudeStreamEvent | null {
  try {
    return JSON.parse(line) as ClaudeStreamEvent;
  } catch {
    log(`Ignoring non-json Claude stream line: ${line.slice(0, 200)}`);
    return null;
  }
}

function errorMessage(event: ClaudeStreamEvent): string {
  if (event.errors && event.errors.length > 0) return event.errors.join('\n');
  if (event.subtype) return event.subtype;
  return 'Claude Code query failed';
}

function progressMessage(event: ClaudeStreamEvent): string | null {
  if (event.type === 'system' && event.subtype === 'task_notification') {
    return event.summary || 'Task notification';
  }
  if (event.type === 'tool_progress') {
    const tool = event.tool_name ?? 'tool';
    const elapsed = typeof event.elapsed_time_seconds === 'number' ? ` (${event.elapsed_time_seconds}s)` : '';
    return `${tool} running${elapsed}`;
  }
  if (event.type === 'assistant') {
    const toolUse = event.message?.content?.find((block) => block.type === 'tool_use');
    if (toolUse?.name) return `Using ${toolUse.name}`;
  }
  return null;
}

function compactedMessage(event: ClaudeStreamEvent): string | null {
  if (event.type !== 'system' || event.subtype !== 'compact_boundary') return null;
  const preTokens = event.compact_metadata?.pre_tokens;
  const detail = preTokens ? ` (${preTokens.toLocaleString()} tokens compacted)` : '';
  return `Context compacted${detail}.`;
}

function buildMcpConfig(
  mcpServers: Record<string, McpServerConfig>,
  exchange: ClaudeChannelExchange,
): string | undefined {
  const merged: Record<string, McpServerConfig> = {
    ...mcpServers,
    [AGENT_CHANNEL_SERVER_NAME]: {
      command: 'bun',
      args: ['run', AGENT_CHANNEL_MCP_PATH],
      env: {
        AGENT_CHANNEL_EXCHANGE_URL: exchange.url,
        AGENT_CHANNEL_DESIRED_ID: exchange.claudeChannelId,
        AGENT_CHANNEL_INSTANCE_LABEL: 'claude-code',
      },
    },
  };
  if (Object.keys(merged).length === 0) return undefined;
  return JSON.stringify({ mcpServers: merged });
}

function resolveClaudeExecutable(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CODE_EXECUTABLE || process.env.CLAUDE_CODE_EXECUTABLE || '/pnpm/claude';
}

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;
  private spawnClaude: SpawnClaude;
  private createExchange: ClaudeChannelExchangeFactory;

  constructor(
    options: ProviderOptions = {},
    spawnClaude: SpawnClaude = spawn,
    createExchange: ClaudeChannelExchangeFactory = startClaudeChannelExchange,
  ) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.spawnClaude = spawnClaude;
    this.createExchange = createExchange;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const queue = new AsyncEventQueue<ProviderEvent>();

    let aborted = false;
    let sawTerminalProviderEvent = false;
    let stderr = '';
    let child: ChildProcessWithoutNullStreams | undefined;

    const exchange = this.createExchange({
      onRuntimeMessage: ({ text }) => {
        if (aborted || sawTerminalProviderEvent) return;
        sawTerminalProviderEvent = true;
        queue.push({ type: 'activity' });
        queue.push({ type: 'result', text });
        child?.stdin.end();
      },
      onRuntimeError: ({ message, retryable, classification }) => {
        if (aborted || sawTerminalProviderEvent) return;
        sawTerminalProviderEvent = true;
        queue.push({ type: 'activity' });
        queue.push({ type: 'error', message, retryable, classification });
        child?.stdin.end();
      },
    });

    child = this.spawnClaude(resolveClaudeExecutable(this.env), this.buildArgs(input, exchange), {
      cwd: input.cwd,
      env: this.envForSpawn(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on(
      'data',
      splitLines((line) => {
        const event = parseStreamEvent(line);
        if (!event || aborted) return;

        queue.push({ type: 'activity' });

        if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
          queue.push({ type: 'init', continuation: event.session_id });
          return;
        }

        const progress = progressMessage(event);
        if (progress) queue.push({ type: 'progress', message: progress });

        const compacted = compactedMessage(event);
        if (compacted) queue.push({ type: 'compacted', text: compacted });

        if (event.type === 'system' && event.subtype === 'api_retry') {
          queue.push({ type: 'error', message: 'API retry', retryable: true });
          return;
        }
        if (event.type === 'rate_limit_event' || (event.type === 'system' && event.subtype === 'rate_limit_event')) {
          sawTerminalProviderEvent = true;
          queue.push({ type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' });
          return;
        }

        if (event.type === 'result') {
          if (event.is_error || (event.subtype && event.subtype.startsWith('error'))) {
            sawTerminalProviderEvent = true;
            queue.push({ type: 'error', message: errorMessage(event), retryable: false });
            return;
          }
          if (!sawTerminalProviderEvent && typeof event.result === 'string') {
            log('Ignoring direct Claude Code result; waiting for channel.send provider result');
          }
        }
      }),
    );

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('error', (err) => {
      exchange.stop();
      if (aborted) {
        queue.close();
        return;
      }
      queue.fail(err);
    });

    child.on('close', (code, signal) => {
      exchange.stop();
      if (aborted) {
        queue.close();
        return;
      }
      if (sawTerminalProviderEvent) {
        queue.close();
        return;
      }
      if (code === 0) {
        queue.fail(new Error('Claude Code exited without replying through channel.send'));
        return;
      }
      const tail = stderr.trim().split('\n').slice(-10).join('\n');
      const detail = tail || (signal ? `terminated by ${signal}` : `exit ${code ?? 'unknown'}`);
      queue.fail(new Error(detail));
    });

    const sendTurn = (message: string): void => {
      const msgId = exchange.deliverToClaude(message);
      writeJsonLine(child, userMessage(channelTurnInstruction(exchange.runtimeChannelId, msgId)));
    };

    sendTurn(input.prompt);

    return {
      push: (message) => {
        if (aborted) return;
        sendTurn(message);
      },
      end: () => {
        child?.stdin.end();
      },
      events: queue,
      abort: () => {
        aborted = true;
        exchange.stop();
        child?.stdin.destroy();
        child?.kill('SIGTERM');
        queue.close();
      },
    };
  }

  private buildArgs(input: QueryInput, exchange: ClaudeChannelExchange): string[] {
    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
      '--allowedTools',
      [
        ...TOOL_ALLOWLIST,
        ...Object.keys(this.mcpServers).map(mcpAllowPattern),
        mcpAllowPattern(AGENT_CHANNEL_SERVER_NAME),
      ].join(','),
      '--disallowedTools',
      CLAUDE_DISALLOWED_TOOLS.join(','),
      '--setting-sources',
      'project,user',
    ];

    if (input.continuation) args.push('--resume', input.continuation);
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.assistantName) args.push('--name', this.assistantName);
    if (input.systemContext?.instructions) args.push('--append-system-prompt', input.systemContext.instructions);
    if (this.additionalDirectories && this.additionalDirectories.length > 0) {
      args.push('--add-dir', ...this.additionalDirectories);
    }
    const mcpConfig = buildMcpConfig(this.mcpServers, exchange);
    if (mcpConfig) args.push('--mcp-config', mcpConfig);

    return args;
  }

  private envForSpawn(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(this.env)) {
      if (value !== undefined) env[key] = value;
    }
    return env;
  }
}

function channelTurnInstruction(runtimeChannelId: string, msgId: string): string {
  return [
    'NanoClaw delivered a message through the Claude Code channel exchange.',
    `Call the ${AGENT_CHANNEL_SERVER_NAME} MCP tool channel.poll_inbox now and read envelope ${msgId}.`,
    'Do not answer from this prompt text; the actual NanoClaw turn input is only in the channel inbox.',
    `When ready to finish the NanoClaw turn, call channel.send to "${runtimeChannelId}" with body_kind "${NANOCLAW_INBOUND_BODY_KIND}".`,
    'Use payload {"message":{"content":"<complete provider result text>"}}.',
    'The provider result text must include any <message to="..."> blocks exactly as NanoClaw should dispatch them.',
    'After channel.send succeeds, finish with DONE.',
  ].join('\n');
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
