import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';

import {
  AGENT_CHANNEL_SCHEMA_VERSION,
  AGENT_CHANNEL_SERVER_NAME,
  NANOCLAW_INBOUND_BODY_KIND,
  NANOCLAW_OUTBOUND_BODY_KIND,
  startClaudeChannelExchange,
  type ClaudeChannelExchange,
  type ClaudeChannelExchangeCallbacks,
  type ExchangeEnvelope,
} from '../fork-features/claude-channel-exchange.js';
import { ClaudeProvider } from './claude.js';
import type { ProviderEvent } from './types.js';

class FakeClaudeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  stdinText = '';
  killedWith: NodeJS.Signals | number | undefined;

  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      this.stdinText += chunk.toString();
    });
  }

  send(event: unknown): void {
    this.stdout.write(JSON.stringify(event) + '\n');
  }

  sendStderr(text: string): void {
    this.stderr.write(text);
  }

  close(code = 0): void {
    this.emit('close', code, null);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = signal;
    this.emit('close', null, signal ?? 'SIGTERM');
    return true;
  }
}

class FakeChannelExchange implements ClaudeChannelExchange {
  readonly url = 'http://127.0.0.1:19999';
  readonly runtimeChannelId = 'nanoclaw/agent-runner/fake-session';
  readonly claudeChannelId = 'claude-code/fake-session';
  readonly delivered: string[] = [];
  stopped = false;

  constructor(private callbacks: ClaudeChannelExchangeCallbacks) {}

  deliverToClaude(text: string): string {
    this.delivered.push(text);
    return `fake-msg-${this.delivered.length}`;
  }

  emitRuntimeMessage(text: string): void {
    this.callbacks.onRuntimeMessage({
      text,
      envelope: fakeEnvelope(this.claudeChannelId, this.runtimeChannelId, text),
    });
  }

  stop(): void {
    this.stopped = true;
  }
}

function makeProvider(opts: ConstructorParameters<typeof ClaudeProvider>[0] = {}) {
  const children: FakeClaudeProcess[] = [];
  const calls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];
  const exchanges: FakeChannelExchange[] = [];
  const provider = new ClaudeProvider(
    opts,
    (command, args, options) => {
      const child = new FakeClaudeProcess();
      children.push(child);
      calls.push({ command, args, options });
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    (callbacks) => {
      const exchange = new FakeChannelExchange(callbacks);
      exchanges.push(exchange);
      return exchange;
    },
  );
  return { provider, children, calls, exchanges };
}

async function nextEvent(iter: AsyncIterator<ProviderEvent>): Promise<ProviderEvent> {
  const item = await iter.next();
  expect(item.done).toBe(false);
  return item.value;
}

function stdinMessages(child: FakeClaudeProcess): string[] {
  return child.stdinText
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).message.content as string);
}

describe('ClaudeProvider', () => {
  it('spawns Claude Code with channel MCP config and delivers prompt through exchange', () => {
    const { provider, children, calls, exchanges } = makeProvider({
      assistantName: 'Ada',
      env: { CLAUDE_CODE_EXECUTABLE: 'claude-test', FOO: 'bar' },
      additionalDirectories: ['/workspace/extra/repo'],
      model: 'sonnet',
      effort: 'high',
      mcpServers: {
        nanoclaw: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'], env: {} },
      },
    });

    const query = provider.query({
      prompt: 'hello from NanoClaw',
      continuation: '11111111-1111-4111-8111-111111111111',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'extra system context' },
    });

    const call = calls[0];
    expect(call.command).toBe('claude-test');
    expect(call.options.cwd).toBe('/workspace/agent');
    expect(call.options.env?.FOO).toBe('bar');
    expect(call.args).toContain('--print');
    expect(call.args).toContain('--input-format');
    expect(call.args).toContain('stream-json');
    expect(call.args).toContain('--output-format');
    expect(call.args).toContain('--resume');
    expect(call.args).toContain('11111111-1111-4111-8111-111111111111');
    expect(call.args).toContain('--model');
    expect(call.args).toContain('sonnet');
    expect(call.args).toContain('--effort');
    expect(call.args).toContain('high');
    expect(call.args).toContain('--name');
    expect(call.args).toContain('Ada');
    expect(call.args).toContain('--append-system-prompt');
    expect(call.args).toContain('extra system context');
    expect(call.args).toContain('--add-dir');
    expect(call.args).toContain('/workspace/extra/repo');

    const mcpConfigArg = call.args[call.args.indexOf('--mcp-config') + 1];
    const mcpServers = JSON.parse(mcpConfigArg).mcpServers;
    expect(mcpServers.nanoclaw.command).toBe('bun');
    expect(mcpServers[AGENT_CHANNEL_SERVER_NAME].command).toBe('bun');
    expect(mcpServers[AGENT_CHANNEL_SERVER_NAME].env.AGENT_CHANNEL_EXCHANGE_URL).toBe(exchanges[0].url);
    expect(mcpServers[AGENT_CHANNEL_SERVER_NAME].env.AGENT_CHANNEL_DESIRED_ID).toBe(exchanges[0].claudeChannelId);

    expect(exchanges[0].delivered).toEqual(['hello from NanoClaw']);
    expect(stdinMessages(children[0])[0]).toContain('channel.poll_inbox');
    expect(stdinMessages(children[0])[0]).not.toContain('hello from NanoClaw');

    query.abort();
    expect(children[0].killedWith).toBe('SIGTERM');
    expect(exchanges[0].stopped).toBe(true);
  });

  it('maps Claude Code stream activity and channel.send replies into AgentProvider events', async () => {
    const { provider, children, exchanges } = makeProvider({ env: { CLAUDE_CODE_EXECUTABLE: 'claude-test' } });
    const query = provider.query({ prompt: 'hello', cwd: '/workspace/agent' });
    const iter = query.events[Symbol.asyncIterator]();
    const child = children[0];

    child.send({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    expect(await nextEvent(iter)).toEqual({ type: 'activity' });
    expect(await nextEvent(iter)).toEqual({ type: 'init', continuation: 'sess-1' });

    child.send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'channel.poll_inbox' }] } });
    expect(await nextEvent(iter)).toEqual({ type: 'activity' });
    expect(await nextEvent(iter)).toEqual({ type: 'progress', message: 'Using channel.poll_inbox' });

    exchanges[0].emitRuntimeMessage('<message to="main">done</message>');
    expect(await nextEvent(iter)).toEqual({ type: 'activity' });
    expect(await nextEvent(iter)).toEqual({ type: 'result', text: '<message to="main">done</message>' });

    child.close();
    expect(await iter.next()).toEqual({ done: true, value: undefined });
  });

  it('pushes live follow-ups through exchange and only nudges Claude to poll', () => {
    const { provider, children, exchanges } = makeProvider({ env: { CLAUDE_CODE_EXECUTABLE: 'claude-test' } });
    const query = provider.query({ prompt: 'initial', cwd: '/workspace/agent' });
    query.push('follow-up');

    expect(exchanges[0].delivered).toEqual(['initial', 'follow-up']);
    const prompts = stdinMessages(children[0]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('channel.poll_inbox');
    expect(prompts[1]).not.toContain('follow-up');
    query.end();
  });

  it('fails the provider stream when Claude exits without channel.send', async () => {
    const { provider, children } = makeProvider({ env: { CLAUDE_CODE_EXECUTABLE: 'claude-test' } });
    const query = provider.query({ prompt: 'initial', cwd: '/workspace/agent' });
    const iter = query.events[Symbol.asyncIterator]();

    children[0].send({ type: 'result', subtype: 'success', result: 'DONE' });
    expect(await nextEvent(iter)).toEqual({ type: 'activity' });
    children[0].close(0);

    await expect(iter.next()).rejects.toThrow('Claude Code exited without replying through channel.send');
  });

  it('aborts the active Claude Code process and closes the event stream', async () => {
    const { provider, children, exchanges } = makeProvider({ env: { CLAUDE_CODE_EXECUTABLE: 'claude-test' } });
    const query = provider.query({ prompt: 'initial', cwd: '/workspace/agent' });
    const iter = query.events[Symbol.asyncIterator]();

    query.abort();

    expect(children[0].killedWith).toBe('SIGTERM');
    expect(exchanges[0].stopped).toBe(true);
    expect(await iter.next()).toEqual({ done: true, value: undefined });
  });

  it('classifies missing Claude Code sessions as invalid continuations', () => {
    const { provider } = makeProvider();

    expect(provider.isSessionInvalid(new Error('No conversation found with session ID: sess-1'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('ENOENT: no such file or directory, open abc.jsonl'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('quota exhausted'))).toBe(false);
  });
});

describe('startClaudeChannelExchange', () => {
  it('drains NanoClaw outbound envelopes and normalizes stringified channel.send payloads', async () => {
    const messages: string[] = [];
    const errors: string[] = [];
    const exchange = startClaudeChannelExchange({
      onRuntimeMessage: (message) => messages.push(message.text),
      onRuntimeError: (error) => errors.push(error.message),
    });

    try {
      const msgId = exchange.deliverToClaude('hello through exchange');
      const heartbeat = await postEnvelope(exchange.url, exchange.claudeChannelId, {
        msg_id: 'heartbeat-1',
        from: exchange.claudeChannelId,
        to: 'exchange/system',
        ts: '2026-05-17T18:00:00.000Z',
        schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
        body: {
          kind: 'heartbeat.ping',
          payload: { channel_id: exchange.claudeChannelId, sequence: 1 },
        },
      });

      expect(heartbeat.inbox).toHaveLength(1);
      expect(heartbeat.inbox[0].msg_id).toBe(msgId);
      expect(heartbeat.inbox[0].body.payload.body_kind).toBe(NANOCLAW_OUTBOUND_BODY_KIND);

      const response = await postEnvelope(exchange.url, exchange.claudeChannelId, {
        msg_id: 'claude-reply-1',
        from: exchange.claudeChannelId,
        to: exchange.runtimeChannelId,
        ts: '2026-05-17T18:00:01.000Z',
        schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
        body: {
          kind: 'deliver.message',
          payload: {
            body_kind: NANOCLAW_INBOUND_BODY_KIND,
            payload: JSON.stringify({
              message: {
                content: JSON.stringify({ text: '<message to="main">from channel</message>' }),
              },
            }),
          },
        },
      });

      expect(response.response.body.payload.body_kind).toBe('exchange.delivery_ack');
      expect(messages).toEqual(['<message to="main">from channel</message>']);
      expect(errors).toEqual([]);
    } finally {
      exchange.stop();
    }
  });
});

function fakeEnvelope(from: string, to: string, text: string): ExchangeEnvelope {
  return {
    msg_id: 'fake-envelope',
    from,
    to,
    ts: '2026-05-17T18:00:00.000Z',
    schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
    body: {
      kind: 'deliver.message',
      payload: {
        body_kind: NANOCLAW_INBOUND_BODY_KIND,
        payload: { message: { content: text } },
      },
    },
  };
}

async function postEnvelope(
  url: string,
  sender: string,
  envelope: ExchangeEnvelope,
): Promise<{ response: ExchangeEnvelope; inbox: ExchangeEnvelope[] }> {
  const response = await fetch(`${url}/v1/envelope`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-channel-sender': sender,
    },
    body: JSON.stringify(envelope),
  });
  return (await response.json()) as { response: ExchangeEnvelope; inbox: ExchangeEnvelope[] };
}
