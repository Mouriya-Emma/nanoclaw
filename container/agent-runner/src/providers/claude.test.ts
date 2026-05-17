import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';

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

function makeProvider(opts: ConstructorParameters<typeof ClaudeProvider>[0] = {}) {
  const children: FakeClaudeProcess[] = [];
  const calls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];
  const provider = new ClaudeProvider(opts, (command, args, options) => {
    const child = new FakeClaudeProcess();
    children.push(child);
    calls.push({ command, args, options });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  return { provider, children, calls };
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
  it('spawns Claude Code in streaming JSON mode with provider config', () => {
    const { provider, children, calls } = makeProvider({
      assistantName: 'Ada',
      env: { CLAUDE_CODE_EXECUTABLE: 'claude-test', FOO: 'bar' },
      additionalDirectories: ['/workspace/extra/repo'],
      model: 'sonnet',
      effort: 'high',
      mcpServers: {
        'agent-channel': { command: 'bun', args: ['run', '/app/channel.ts'], env: { X: '1' } },
      },
    });

    const query = provider.query({
      prompt: 'hello',
      continuation: '11111111-1111-4111-8111-111111111111',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'extra system context' },
    });

    const call = calls[0];
    expect(call.command).toBe('claude-test');
    expect(call.options.cwd).toBe('/workspace/agent');
    expect(call.options.env?.FOO).toBe('bar');
    expect(call.args).toContain('--print');
    expect(call.args).not.toContain('-p');
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
    expect(JSON.parse(mcpConfigArg).mcpServers['agent-channel'].command).toBe('bun');

    query.abort();
    expect(children[0].killedWith).toBe('SIGTERM');
  });

  it('maps Claude Code stream events into AgentProvider events', async () => {
    const { provider, children } = makeProvider({ env: { CLAUDE_CODE_EXECUTABLE: 'claude-test' } });
    const query = provider.query({ prompt: 'hello', cwd: '/workspace/agent' });
    const iter = query.events[Symbol.asyncIterator]();
    const child = children[0];

    child.send({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    expect(await nextEvent(iter)).toEqual({ type: 'activity' });
    expect(await nextEvent(iter)).toEqual({ type: 'init', continuation: 'sess-1' });

    child.send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } });
    expect(await nextEvent(iter)).toEqual({ type: 'activity' });
    expect(await nextEvent(iter)).toEqual({ type: 'progress', message: 'Using Bash' });

    child.send({ type: 'result', subtype: 'success', result: '<message to="main">done</message>' });
    expect(await nextEvent(iter)).toEqual({ type: 'activity' });
    expect(await nextEvent(iter)).toEqual({ type: 'result', text: '<message to="main">done</message>' });

    child.close();
    expect(await iter.next()).toEqual({ done: true, value: undefined });
  });

  it('pushes live follow-ups over the active stream', () => {
    const { provider, children } = makeProvider({ env: { CLAUDE_CODE_EXECUTABLE: 'claude-test' } });
    const query = provider.query({ prompt: 'initial', cwd: '/workspace/agent' });
    query.push('follow-up');

    expect(stdinMessages(children[0])).toEqual(['initial', 'follow-up']);
    query.end();
  });

  it('aborts the active Claude Code process and closes the event stream', async () => {
    const { provider, children } = makeProvider({ env: { CLAUDE_CODE_EXECUTABLE: 'claude-test' } });
    const query = provider.query({ prompt: 'initial', cwd: '/workspace/agent' });
    const iter = query.events[Symbol.asyncIterator]();

    query.abort();

    expect(children[0].killedWith).toBe('SIGTERM');
    expect(await iter.next()).toEqual({ done: true, value: undefined });
  });

  it('classifies missing Claude Code sessions as invalid continuations', () => {
    const { provider } = makeProvider();

    expect(provider.isSessionInvalid(new Error('No conversation found with session ID: sess-1'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('ENOENT: no such file or directory, open abc.jsonl'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('quota exhausted'))).toBe(false);
  });
});
