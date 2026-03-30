import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import { send, sendAndExpectReply, interTestDelay, startWsListener, stopWsListener } from './mm-setup.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

beforeAll(async () => { await startWsListener(); }, 15_000);
afterAll(() => { stopWsListener(); });

describe('Mattermost message flow', () => {
  // Ensure Claude provider
  beforeAll(async () => {
    const reply = await sendAndExpectReply('/cla', { timeout: 10_000 });
    expect(reply).toContain('Switched to Claude Agent SDK');
    await interTestDelay();
  });

  afterEach(async () => { await interTestDelay(); });

  it('trigger message gets agent reply', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} say hello`,
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
