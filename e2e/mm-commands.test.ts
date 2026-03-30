import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sendAndExpectReply, interTestDelay, startWsListener, stopWsListener } from './mm-setup.js';

beforeAll(async () => { await startWsListener(); }, 15_000);
afterAll(() => { stopWsListener(); });

describe('Mattermost commands', () => {
  afterEach(async () => { await interTestDelay(); });

  it('/ping responds with online status', async () => {
    const reply = await sendAndExpectReply('/ping', { timeout: 10_000 });
    expect(reply).toContain('is online');
  });

  it('/chatid returns chat info', async () => {
    const reply = await sendAndExpectReply('/chatid', { timeout: 10_000 });
    expect(reply).toContain('Chat ID');
    expect(reply).toContain('mm:');
  });

  it('/clear confirms session cleared', async () => {
    const reply = await sendAndExpectReply('/clear', { timeout: 10_000 });
    expect(reply).toContain('Session cleared');
  });

  it('/stop confirms container stopped', async () => {
    const reply = await sendAndExpectReply('/stop', { timeout: 10_000 });
    expect(reply).toContain('Container stopped');
  });
});
