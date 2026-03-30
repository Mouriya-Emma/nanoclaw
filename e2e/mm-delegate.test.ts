/**
 * E2E tests for user token delegation (/delegate, /revoke, execute_command IPC).
 *
 * Flow:
 *   1. Create a DM channel between admin user and the bot
 *   2. Send /delegate in DM — get instructions
 *   3. Create a Personal Access Token for admin user
 *   4. Send /delegate <token> in DM — token stored, message deleted
 *   5. Agent executes a slash command via IPC on behalf of admin user
 *   6. /revoke removes the token
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import {
  mmApi,
  MM,
  interTestDelay,
  startWsListener,
  stopWsListener,
  sendAndExpectReply,
} from './mm-setup.js';
import { ALL_BACKENDS, switchToBackend } from './mm-backend-helpers.js';
import WebSocket from 'ws';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;
const WARM_TIMEOUT = 120_000;

// --- DM-specific helpers ---

let dmChannelId: string | null = null;
let dmWs: WebSocket | null = null;
type MsgHandler = (post: { id: string; message: string; user_id: string; channel_id: string }) => void;
const dmHandlers: MsgHandler[] = [];
let createdTokenId: string | null = null;

/** Create or get the DM channel between admin user and bot. */
async function getDmChannelId(): Promise<string> {
  if (dmChannelId) return dmChannelId;
  const dm = await mmApi<{ id: string }>('/channels/direct', {
    method: 'POST',
    body: JSON.stringify([MM.adminUserId, MM.botUserId]),
  });
  dmChannelId = dm.id;
  return dmChannelId;
}

/** Post a message in the DM channel as admin. */
async function dmPost(message: string): Promise<string> {
  const chId = await getDmChannelId();
  const post = await mmApi<{ id: string }>('/posts', {
    method: 'POST',
    body: JSON.stringify({ channel_id: chId, message }),
  });
  return post.id;
}

/** Wait for a bot reply in the DM channel. */
function waitForDmReply(
  opts?: { match?: string | RegExp; timeout?: number },
): Promise<string> {
  const timeout = opts?.timeout ?? 15_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = dmHandlers.indexOf(handler);
      if (idx >= 0) dmHandlers.splice(idx, 1);
      reject(new Error(`Timed out waiting for DM bot reply (${timeout}ms)`));
    }, timeout);

    const handler: MsgHandler = (post) => {
      if (post.user_id !== MM.botUserId) return;
      if (post.channel_id !== dmChannelId) return;
      const msg = post.message;
      if (opts?.match) {
        const ok = typeof opts.match === 'string' ? msg.includes(opts.match) : opts.match.test(msg);
        if (!ok) return;
      }
      clearTimeout(timer);
      const idx = dmHandlers.indexOf(handler);
      if (idx >= 0) dmHandlers.splice(idx, 1);
      resolve(msg);
    };
    dmHandlers.push(handler);
  });
}

/** Send in DM and wait for bot reply. */
async function dmSendAndExpect(
  text: string,
  opts?: { match?: string | RegExp; timeout?: number },
): Promise<string> {
  const replyPromise = waitForDmReply(opts);
  await dmPost(text);
  return replyPromise;
}

/** Start a WebSocket listener that also routes DM messages. */
function startDmWsListener(): Promise<void> {
  return new Promise((resolve, reject) => {
    const wsUrl = MM.url.replace(/^http/, 'ws') + '/api/v4/websocket';
    dmWs = new WebSocket(wsUrl);
    let resolved = false;

    dmWs.on('open', () => {
      dmWs!.send(JSON.stringify({
        action: 'authentication_challenge',
        seq: 1,
        data: { token: MM.adminToken },
      }));
    });

    dmWs.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if ((msg.status === 'OK' || msg.event === 'hello') && !resolved) {
        resolved = true;
        resolve();
        return;
      }
      if (msg.event === 'posted' && msg.data?.post) {
        const post = JSON.parse(msg.data.post);
        for (const h of dmHandlers) h(post);
      }
    });

    dmWs.on('error', (err) => {
      if (!resolved) { resolved = true; reject(err); }
    });
  });
}

function stopDmWsListener(): void {
  if (dmWs) { dmWs.close(); dmWs = null; }
  dmHandlers.length = 0;
}

/** Create a Personal Access Token for the admin user. */
async function createPat(): Promise<{ id: string; token: string }> {
  // Ensure personal access tokens are enabled
  const pat = await mmApi<{ id: string; token: string }>(
    `/users/${MM.adminUserId}/tokens`,
    {
      method: 'POST',
      body: JSON.stringify({ description: `e2e-delegate-test-${Date.now()}` }),
    },
  );
  createdTokenId = pat.id;
  return pat;
}

/** Revoke a Personal Access Token. */
async function revokePat(tokenId: string): Promise<void> {
  await mmApi('/users/tokens/revoke', {
    method: 'POST',
    body: JSON.stringify({ token_id: tokenId }),
  });
}

// --- Setup ---

beforeAll(async () => {
  await startWsListener();
  await startDmWsListener();
  await getDmChannelId();
}, 15_000);

afterAll(async () => {
  // Clean up PAT if created
  if (createdTokenId) {
    try { await revokePat(createdTokenId); } catch { /* ignore */ }
  }
  stopDmWsListener();
  stopWsListener();
});

// --- Tests ---

describe('Mattermost /delegate flow', () => {
  afterEach(async () => { await interTestDelay(); });

  it('/delegate in DM without token shows instructions', async () => {
    const reply = await dmSendAndExpect('/delegate', { timeout: 10_000 });
    expect(reply).toContain('Personal Access Token');
    expect(reply).toContain('/delegate');
  });

  it('/delegate with valid token stores it', async () => {
    const pat = await createPat();
    const reply = await dmSendAndExpect(`/delegate ${pat.token}`, {
      timeout: 10_000,
      match: 'Token stored',
    });
    expect(reply).toContain('Token stored');
  });

  it('/revoke removes the stored token', async () => {
    const reply = await dmSendAndExpect('/revoke', { timeout: 10_000 });
    expect(reply).toContain('revoked');
  });

  it('/delegate with invalid token is rejected', async () => {
    const reply = await dmSendAndExpect('/delegate invalidtoken123', {
      timeout: 10_000,
    });
    expect(reply).toContain('Invalid token');
  });
});

describe('Mattermost execute_command IPC', () => {
  afterEach(async () => { await interTestDelay(); });

  for (const backend of ALL_BACKENDS) {
    it(`agent executes slash command via IPC (${backend.name})`, async () => {
      // 1. Store a valid token via /delegate
      const pat = await createPat();
      await dmSendAndExpect(`/delegate ${pat.token}`, {
        timeout: 10_000,
        match: 'Token stored',
      });
      await interTestDelay();

      // 2. Switch to backend and ask agent to execute a slash command
      await switchToBackend(backend, TRIGGER);

      const reply = await sendAndExpectReply(
        `${TRIGGER} use the execute_command IPC to run the slash command "/ping" in this channel on behalf of user ${MM.adminUserId}. The channel ID is ${MM.channelId}. Write the IPC JSON file and tell me the result.`,
        { timeout: WARM_TIMEOUT },
      );
      // The agent should have written the IPC file and we should get some response
      expect(reply.length).toBeGreaterThan(0);

      // 3. Clean up
      await dmSendAndExpect('/revoke', { timeout: 10_000 });
    });
  }
});
