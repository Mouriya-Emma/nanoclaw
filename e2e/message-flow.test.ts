import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import {
  sendAndExpectReply,
  sendAndExpectNoReply,
  waitForReply,
  interTestDelay,
} from './helpers.js';
import { getClient, disconnectClient } from './setup.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

beforeAll(async () => { await getClient(); });
afterAll(async () => { await disconnectClient(); });

describe('Message flow', () => {
  afterEach(async () => { await interTestDelay(); });

  it('trigger message gets agent reply', async () => {
    const marker = `e2e-ok-${Date.now()}`;
    const reply = await sendAndExpectReply(
      `${TRIGGER} reply with exactly "${marker}" and nothing else`,
      { timeout: 120_000, match: marker },
    );
    expect(reply).toContain(marker);
  });

  it('message without trigger gets no reply', async () => {
    const marker = `e2e-silent-${Date.now()}`;
    await sendAndExpectNoReply(marker, { wait: 15_000 });
  });

  it('/ask executes with specific provider', async () => {
    const marker = `e2e-ask-${Date.now()}`;
    const reply = await sendAndExpectReply(
      `/ask anthropic reply with exactly "${marker}" and nothing else`,
      { timeout: 120_000, match: marker },
    );
    expect(reply).toContain(marker);
  });

  it('/cla switch then trigger message works', async () => {
    // Switch to Claude SDK first
    const switchReply = await sendAndExpectReply('/cla', { timeout: 10_000 });
    expect(switchReply).toContain('Switched to Claude Agent SDK');

    await interTestDelay();

    // Now send a trigger message
    const marker = `e2e-cla-${Date.now()}`;
    const reply = await sendAndExpectReply(
      `${TRIGGER} reply with exactly "${marker}" and nothing else`,
      { timeout: 120_000, match: marker },
    );
    expect(reply).toContain(marker);
  });
});
