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

// Pi-mono cold start is slow: OAuth token refresh + Google Cloud Code Assist inference.
// First container spawn takes ~6 minutes; follow-ups via IPC are much faster.
const PI_COLD_START_TIMEOUT = 420_000; // 7 minutes
const PI_WARM_TIMEOUT = 300_000; // 5 minutes (IPC follow-up or second cold start)

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
    // Send a follow-up to the same container session (IPC piping)
    const reply = await sendAndExpectReply(
      `${TRIGGER} what is 2+2?`,
      { timeout: PI_WARM_TIMEOUT },
    );
    expect(reply.length).toBeGreaterThan(0);
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
