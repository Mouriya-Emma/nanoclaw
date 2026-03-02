import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sendAndExpectReply, interTestDelay } from './helpers.js';
import { getClient, disconnectClient } from './setup.js';

beforeAll(async () => { await getClient(); });
afterAll(async () => { await disconnectClient(); });

describe('Telegram commands', () => {
  afterEach(async () => { await interTestDelay(); });

  it('/ping responds with online status', async () => {
    const reply = await sendAndExpectReply('/ping', { timeout: 10_000 });
    expect(reply).toContain('is online');
  });

  it('/chatid returns chat info', async () => {
    const reply = await sendAndExpectReply('/chatid', { timeout: 10_000 });
    expect(reply).toContain('Chat ID:');
    expect(reply).toContain('tg:');
  });

  it('/clear confirms session cleared', async () => {
    const reply = await sendAndExpectReply('/clear', { timeout: 10_000 });
    expect(reply).toContain('Session cleared');
  });

  it('/stop confirms container stopped', async () => {
    const reply = await sendAndExpectReply('/stop', { timeout: 10_000 });
    expect(reply).toContain('Container stopped');
  });

  it('/cla switches to Claude Agent SDK', async () => {
    const reply = await sendAndExpectReply('/cla', { timeout: 10_000 });
    expect(reply).toContain('Switched to Claude Agent SDK');
  });

  it('/pi with invalid provider returns error', async () => {
    const reply = await sendAndExpectReply('/pi invalid_xxx', { timeout: 10_000 });
    expect(reply).toContain('Unknown pi-mono provider');
  });

  it('/pi with valid provider switches runtime', async () => {
    const reply = await sendAndExpectReply('/pi anthropic', { timeout: 10_000 });
    expect(reply).toContain('Switched to pi-mono/anthropic');
  });

  it('/model with no args shows info', async () => {
    const reply = await sendAndExpectReply('/model', { timeout: 10_000 });
    expect(reply.toLowerCase()).toMatch(/select a model|default model|uses the default/);
  });

  it('/ask with no args shows usage', async () => {
    const reply = await sendAndExpectReply('/ask', { timeout: 10_000 });
    expect(reply).toContain('Usage: /ask');
  });

  it('/ask with invalid provider returns error', async () => {
    const reply = await sendAndExpectReply('/ask invalid_xxx hello', { timeout: 10_000 });
    expect(reply).toContain('Unknown provider');
  });

  it('/pi_login with no args shows provider list', async () => {
    const reply = await sendAndExpectReply('/pi_login', { timeout: 10_000 });
    expect(reply.toLowerCase()).toContain('select a provider');
  });

  it('/requirements shows tool requirements', async () => {
    const reply = await sendAndExpectReply('/requirements', { timeout: 10_000 });
    expect(reply).toMatch(/No tool requirements|Tool requirements:/);
  });
});
