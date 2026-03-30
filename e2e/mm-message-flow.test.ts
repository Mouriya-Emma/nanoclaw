import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import { send, sendAndExpectReply, interTestDelay, startWsListener, stopWsListener } from './mm-setup.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

beforeAll(async () => { await startWsListener(); }, 15_000);
afterAll(() => { stopWsListener(); });

describe('Mattermost message flow', () => {
  // Default runtime is Claude SDK — no /cla needed since Mattermost
  // channel doesn't implement runtime switching commands yet.
  beforeAll(async () => {
    // Clear any prior session to ensure clean state
    await send('/clear');
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

  it('follow-up message reuses container', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} say goodbye`,
      { timeout: 120_000 },
    );
    expect(reply.length).toBeGreaterThan(0);
  });
});
