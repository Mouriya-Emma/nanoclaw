/**
 * E2E tests for shared commands on Mattermost.
 * Tests commands that were extracted into the shared command handler:
 * /ping, /chatid, /clear, /stop (existing), /cla, /requirements
 *
 * Also tests the /delegate flow (token storage for slash command delegation).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  sendAndExpectReply,
  sendAndExpectNoReply,
  interTestDelay,
  startWsListener,
  stopWsListener,
  mmApi,
  MM,
} from './mm-setup.js';

beforeAll(async () => { await startWsListener(); }, 15_000);
afterAll(() => { stopWsListener(); });

describe('Mattermost shared commands', () => {
  afterEach(async () => { await interTestDelay(); });

  // --- Commands from shared handler ---

  it('/cla switches to Claude Agent SDK', async () => {
    const reply = await sendAndExpectReply('/cla', { timeout: 10_000 });
    expect(reply).toContain('Switched to Claude Agent SDK');
    expect(reply).toContain('Session cleared');
  });

  it('/requirements responds (even if empty)', async () => {
    const reply = await sendAndExpectReply('/requirements', { timeout: 10_000 });
    // Either "No tool requirements" or a list of requirements
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toMatch(/tool requirements|No tool requirements/i);
  });

  it('/ask without args shows usage', async () => {
    const reply = await sendAndExpectReply('/ask', { timeout: 10_000 });
    expect(reply).toContain('Usage');
    expect(reply).toContain('/ask');
  });

  it('/ask with invalid provider shows error', async () => {
    const reply = await sendAndExpectReply('/ask invalidprovider hello', { timeout: 10_000 });
    expect(reply).toContain('Unknown provider');
  });

  it('/pi without args lists providers or shows no-auth message', async () => {
    const reply = await sendAndExpectReply('/pi', { timeout: 10_000 });
    // Either lists authenticated providers or says none authenticated
    expect(reply.length).toBeGreaterThan(0);
  });

  it('/pi with invalid provider shows error', async () => {
    const reply = await sendAndExpectReply('/pi invalidprovider', { timeout: 10_000 });
    expect(reply).toContain('Unknown pi-mono provider');
  });

  it('/model without pi provider shows claude message', async () => {
    // After /cla, current provider is claude
    await sendAndExpectReply('/cla', { timeout: 10_000 });
    await interTestDelay();
    const reply = await sendAndExpectReply('/model', { timeout: 10_000 });
    expect(reply).toContain('Claude Agent SDK uses the default model');
  });

  // --- /delegate command (Mattermost-specific) ---

  it('/delegate in channel tells user to use DM', async () => {
    // The test channel is not a DM (type O or P), so /delegate should refuse
    const reply = await sendAndExpectReply('/delegate', { timeout: 10_000 });
    expect(reply).toContain('direct message');
  });

  it('/revoke confirms even without stored token', async () => {
    const reply = await sendAndExpectReply('/revoke', { timeout: 10_000 });
    expect(reply).toContain('revoked');
  });

  // --- Unknown commands should not crash ---

  it('unknown /command gets no reply from shared handler', async () => {
    // Unknown slash commands should be silently ignored (not registered)
    await sendAndExpectNoReply('/unknowncmd12345', { wait: 5_000 });
  });
});
