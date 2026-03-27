import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import { send, sendAndExpectReply, interTestDelay } from './helpers.js';
import { disconnectClient } from './setup.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

const PI_COLD_START_TIMEOUT = 180_000;
const PI_WARM_TIMEOUT = 120_000;

afterAll(async () => { await disconnectClient(); });

describe('MCP tools', () => {
  beforeAll(async () => {
    // Switch to pi-mono + google-antigravity and cold-start the container
    await send('/stop');
    await interTestDelay();
    await send('/clear');
    await interTestDelay();
    await sendAndExpectReply('/pi google-antigravity', { timeout: 10_000 });
    await interTestDelay();
    // Trigger cold start so MCP bridge connects
    await sendAndExpectReply(`${TRIGGER} say ready`, { timeout: PI_COLD_START_TIMEOUT });
    await interTestDelay();
  });

  afterEach(async () => { await interTestDelay(); });

  it('lists tools from host MCP servers', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} list all your available tool names that contain "mcp__". Just list the tool names, nothing else.`,
      { timeout: PI_WARM_TIMEOUT },
    );
    expect(reply).toContain('mcp__codanna__');
    expect(reply).toContain('mcp__pencil__');
    expect(reply).toContain('mcp__chrome_devtools__');
  });

  it('codanna: get_index_info returns data', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} call the mcp__codanna__get_index_info tool and tell me what it returns`,
      { timeout: PI_WARM_TIMEOUT },
    );
    expect(reply.length).toBeGreaterThan(0);
  });

  it('pencil: get_editor_state returns data', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} call the mcp__pencil__get_editor_state tool with include_schema=false and tell me what it returns`,
      { timeout: PI_WARM_TIMEOUT },
    );
    expect(reply.length).toBeGreaterThan(0);
  });

  it('chrome_devtools: list_pages returns data', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} call the mcp__chrome_devtools__list_pages tool and tell me what it returns`,
      { timeout: PI_WARM_TIMEOUT },
    );
    expect(reply.length).toBeGreaterThan(0);
  });

  it('agent-browser skill works', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} use agent-browser to open https://example.com and take a snapshot, tell me the page title`,
      { timeout: PI_WARM_TIMEOUT },
    );
    expect(reply.toLowerCase()).toContain('example');
  });
});
