import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  sendAndExpectReply,
  sendAndExpectNoReply,
  interTestDelay,
  startWsListener,
  stopWsListener,
} from './mm-setup.js';

beforeAll(async () => { await startWsListener(); }, 15_000);
afterAll(() => { stopWsListener(); });

describe('Mattermost commands', () => {
  afterEach(async () => { await interTestDelay(); });

  // --- Platform-specific commands ---

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

  // --- Shared commands (from commands.ts) ---

  it('/cla switches to Claude Agent SDK', async () => {
    const reply = await sendAndExpectReply('/cla', { timeout: 10_000 });
    expect(reply).toContain('Switched to Claude Agent SDK');
    expect(reply).toContain('Session cleared');
  });

  it('/requirements lists tool requirements or shows empty', async () => {
    const reply = await sendAndExpectReply('/requirements', { timeout: 10_000 });
    expect(reply).toMatch(/tool requirements|No tool requirements/i);
  });

  it('/ask without args shows usage', async () => {
    const reply = await sendAndExpectReply('/ask', { timeout: 10_000 });
    expect(reply).toContain('Usage');
  });

  it('/ask with invalid provider shows error', async () => {
    const reply = await sendAndExpectReply('/ask badprovider hello', { timeout: 10_000 });
    expect(reply).toContain('Unknown provider');
  });

  it('/pi with invalid provider shows error', async () => {
    const reply = await sendAndExpectReply('/pi badprovider', { timeout: 10_000 });
    expect(reply).toContain('Unknown pi-mono provider');
  });

  it('/model shows claude default message after /cla', async () => {
    await sendAndExpectReply('/cla', { timeout: 10_000 });
    await interTestDelay();
    const reply = await sendAndExpectReply('/model', { timeout: 10_000 });
    expect(reply).toContain('Claude Agent SDK uses the default model');
  });

  // --- /delegate refuses outside DM ---

  it('/delegate in channel tells user to use DM', async () => {
    const reply = await sendAndExpectReply('/delegate', { timeout: 10_000 });
    expect(reply).toContain('direct message');
  });

  // --- Unknown commands are silently ignored ---

  it('unknown /command gets no bot reply', async () => {
    await sendAndExpectNoReply('/unknowncmd12345', { wait: 5_000 });
  });
});
