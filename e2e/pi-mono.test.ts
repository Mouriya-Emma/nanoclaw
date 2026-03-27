import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import {
  send,
  sendAndExpectReply,
  interTestDelay,
} from './helpers.js';
import { disconnectClient } from './setup.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

// Pi-mono provider with valid OAuth credentials (see data/pi-auth.json)
const PI_PROVIDER = 'google-antigravity';

// Pi-mono cold start: container compile + OAuth refresh + model inference.
// With host MCP connected (~59 tools), first call takes ~16s; follow-ups via IPC ~5s.
const PI_COLD_START_TIMEOUT = 120_000;
const PI_WARM_TIMEOUT = 60_000;

afterAll(async () => { await disconnectClient(); });

describe('Pi-mono provider', () => {
  beforeAll(async () => {
    // Clean slate: stop container, clear session, switch to pi provider
    await send('/stop');
    await interTestDelay();
    await send('/clear');
    await interTestDelay();
    const reply = await sendAndExpectReply(`/pi ${PI_PROVIDER}`, { timeout: 10_000 });
    expect(reply).toContain(`Switched to pi-mono/${PI_PROVIDER}`);
    await interTestDelay();
  }, 30_000);

  afterEach(async () => { await interTestDelay(); });

  it('trigger message gets pi-mono agent reply', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} say hello`,
      { timeout: PI_COLD_START_TIMEOUT },
    );
    expect(reply.length).toBeGreaterThan(0);
  }, PI_COLD_START_TIMEOUT + 10_000);

  it('follow-up message reuses pi-mono session', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} what is 2+2?`,
      { timeout: PI_WARM_TIMEOUT },
    );
    expect(reply.length).toBeGreaterThan(0);
  }, PI_WARM_TIMEOUT + 10_000);

  it('agent can use bash tool', async () => {
    // Ask agent to run a command — verifies codingTools.bash works
    const reply = await sendAndExpectReply(
      `${TRIGGER} run the command "echo NANOCLAW_TOOL_TEST" and tell me the output`,
      { timeout: PI_WARM_TIMEOUT },
    );
    expect(reply).toContain('NANOCLAW_TOOL_TEST');
  }, PI_WARM_TIMEOUT + 10_000);

  it('agent can use file read/write tools', async () => {
    // Ask agent to write and read a file — verifies codingTools.write + read
    const marker = `test-${Date.now()}`;
    const reply = await sendAndExpectReply(
      `${TRIGGER} write the text "${marker}" to /workspace/group/e2e-tool-test.txt, then read it back and tell me the content`,
      { timeout: PI_WARM_TIMEOUT },
    );
    expect(reply).toContain(marker);
  }, PI_WARM_TIMEOUT + 10_000);

  it('/ask google-antigravity executes one-shot pi-mono', async () => {
    await send('/stop');
    await interTestDelay();

    const reply = await sendAndExpectReply(
      `/ask ${PI_PROVIDER} what is 3+3?`,
      { timeout: PI_COLD_START_TIMEOUT },
    );
    expect(reply.length).toBeGreaterThan(0);
  }, PI_COLD_START_TIMEOUT + 10_000);

  it('switch back to claude after pi-mono tests', async () => {
    const reply = await sendAndExpectReply('/cla', { timeout: 10_000 });
    expect(reply).toContain('Switched to Claude Agent SDK');
  });
});
