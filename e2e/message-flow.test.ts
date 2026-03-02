import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import {
  sendAndExpectReply,
  sendAndExpectNoReply,
  interTestDelay,
} from './helpers.js';
import { disconnectClient } from './setup.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

afterAll(async () => { await disconnectClient(); });

describe('Message flow', () => {
  afterEach(async () => { await interTestDelay(); });

  it('trigger message gets agent reply', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} say hello`,
      { timeout: 180_000 },
    );
    expect(reply.length).toBeGreaterThan(0);
  });

  it('message without trigger gets no reply', async () => {
    const marker = `e2e-silent-${Date.now()}`;
    await sendAndExpectNoReply(marker, { wait: 15_000 });
  });

  it('/ask executes with specific provider', async () => {
    const reply = await sendAndExpectReply(
      `/ask anthropic say hello`,
      { timeout: 180_000 },
    );
    expect(reply.length).toBeGreaterThan(0);
  });

  it('/cla switch then trigger message works', async () => {
    const switchReply = await sendAndExpectReply('/cla', { timeout: 10_000 });
    expect(switchReply).toContain('Switched to Claude Agent SDK');

    await interTestDelay();

    const reply = await sendAndExpectReply(
      `${TRIGGER} say hello`,
      { timeout: 180_000 },
    );
    expect(reply.length).toBeGreaterThan(0);
  });
});
