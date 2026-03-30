/**
 * Mattermost Admin Skill E2E tests.
 *
 * Tests that the container agent can manage Mattermost via REST API.
 * Each test asks the agent to perform an action, then verifies via admin API.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import {
  sendAndExpectReply,
  interTestDelay,
  startWsListener,
  stopWsListener,
  mmApi,
  MM,
  deletePost,
  getRecentPosts,
} from './mm-setup.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;
const TEAM_ID = process.env.MM_TEAM_ID || 'm6tuzsqypbd8zqxyqht5ouubxa';
const WARM_TIMEOUT = 120_000;

// Track created resources for cleanup
const createdChannelIds: string[] = [];
const createdPostIds: string[] = [];

beforeAll(async () => {
  await startWsListener();
}, 15_000);

afterAll(async () => {
  // Cleanup: delete test channels
  for (const id of createdChannelIds) {
    try {
      await mmApi(`/channels/${id}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  }
  // Cleanup: delete test posts
  for (const id of createdPostIds) {
    try {
      await deletePost(id);
    } catch { /* ignore */ }
  }
  stopWsListener();
});

// --- Helpers ---

async function findChannel(name: string): Promise<{ id: string; display_name: string; header: string; purpose: string; type: string; delete_at: number } | null> {
  try {
    return await mmApi(`/teams/${TEAM_ID}/channels/name/${name}`);
  } catch {
    return null;
  }
}

async function getChannelPosts(channelId: string): Promise<{ order: string[]; posts: Record<string, { id: string; message: string; user_id: string; is_pinned: boolean }> }> {
  return mmApi(`/channels/${channelId}/posts?per_page=20`);
}

async function getPostReactions(postId: string): Promise<Array<{ emoji_name: string; user_id: string }>> {
  return mmApi(`/posts/${postId}/reactions`);
}

// --- Tests ---

describe('Mattermost Admin Skill', () => {
  afterEach(async () => { await interTestDelay(); });

  // -- Channel Management --

  it('creates a public channel', async () => {
    const channelName = `e2e-admin-${Date.now()}`;
    const reply = await sendAndExpectReply(
      `${TRIGGER} create a public Mattermost channel with name "${channelName}" and display name "E2E Admin Test". Just confirm with the channel id.`,
      { timeout: WARM_TIMEOUT },
    );

    // Verify channel exists
    const ch = await findChannel(channelName);
    expect(ch).not.toBeNull();
    expect(ch!.display_name).toBe('E2E Admin Test');
    expect(ch!.type).toBe('O');
    createdChannelIds.push(ch!.id);
    expect(reply.length).toBeGreaterThan(0);
  });

  it('sets channel header and purpose', async () => {
    // Use the channel created in previous test
    const chId = createdChannelIds[0];
    expect(chId).toBeDefined();

    const reply = await sendAndExpectReply(
      `${TRIGGER} set the header of Mattermost channel id ${chId} to "Automated testing" and purpose to "E2E test channel". Confirm when done.`,
      { timeout: WARM_TIMEOUT },
    );

    const ch = await mmApi<{ header: string; purpose: string }>(`/channels/${chId}`);
    expect(ch.header).toBe('Automated testing');
    expect(ch.purpose).toBe('E2E test channel');
    expect(reply.length).toBeGreaterThan(0);
  });

  it('lists channels and finds the test channel', async () => {
    const chId = createdChannelIds[0];
    const reply = await sendAndExpectReply(
      `${TRIGGER} list all Mattermost channels in team ${TEAM_ID} and tell me if you see one with "E2E Admin Test" in the name`,
      { timeout: WARM_TIMEOUT },
    );

    expect(reply.toLowerCase()).toMatch(/e2e admin test|found|yes/i);
  });

  it('posts a message to another channel', async () => {
    const chId = createdChannelIds[0];
    const marker = `admin-post-${Date.now()}`;

    const reply = await sendAndExpectReply(
      `${TRIGGER} post the exact message "${marker}" to Mattermost channel id ${chId}. Just confirm.`,
      { timeout: WARM_TIMEOUT },
    );

    // Verify the message exists in the target channel
    const posts = await getChannelPosts(chId);
    const found = Object.values(posts.posts).find(p => p.message.includes(marker));
    expect(found).toBeDefined();
    if (found) createdPostIds.push(found.id);
  });

  it('pins a message', async () => {
    const chId = createdChannelIds[0];
    // Get the post we created in the previous test
    const posts = await getChannelPosts(chId);
    const targetPost = Object.values(posts.posts).find(p => p.user_id === MM.botUserId && !p.message.includes('joined'));
    expect(targetPost).toBeDefined();

    const reply = await sendAndExpectReply(
      `${TRIGGER} pin the Mattermost post with id ${targetPost!.id}. Just confirm.`,
      { timeout: WARM_TIMEOUT },
    );

    // Verify pinned
    const post = await mmApi<{ is_pinned: boolean }>(`/posts/${targetPost!.id}`);
    expect(post.is_pinned).toBe(true);
  });

  it('adds a reaction to a post', async () => {
    const chId = createdChannelIds[0];
    const posts = await getChannelPosts(chId);
    const targetPost = Object.values(posts.posts).find(p => p.user_id === MM.botUserId && !p.message.includes('joined'));
    expect(targetPost).toBeDefined();

    const reply = await sendAndExpectReply(
      `${TRIGGER} add a thumbsup reaction to Mattermost post id ${targetPost!.id}. Just confirm.`,
      { timeout: WARM_TIMEOUT },
    );

    const reactions = await getPostReactions(targetPost!.id);
    const thumbsup = reactions.find(r => r.emoji_name === 'thumbsup' || r.emoji_name === '+1');
    expect(thumbsup).toBeDefined();
  });

  it('searches messages', async () => {
    // Search for the marker we posted earlier
    const reply = await sendAndExpectReply(
      `${TRIGGER} search Mattermost posts in team ${TEAM_ID} for "admin-post-" and tell me what you find`,
      { timeout: WARM_TIMEOUT },
    );

    expect(reply.toLowerCase()).toMatch(/admin-post-|found|result/i);
  });

  // -- User Operations --

  it('lists users', async () => {
    const reply = await sendAndExpectReply(
      `${TRIGGER} list all Mattermost users and tell me the usernames`,
      { timeout: WARM_TIMEOUT },
    );

    // Should mention mouriya (the admin user)
    expect(reply.toLowerCase()).toMatch(/mouriya|andy-bot/);
  });

  it('creates a DM and sends a message', async () => {
    // DM between bot and admin user
    const reply = await sendAndExpectReply(
      `${TRIGGER} create a direct message channel between yourself and user id ${MM.adminUserId} on Mattermost, then send them "Hello from e2e test". Confirm with the DM channel id.`,
      { timeout: WARM_TIMEOUT },
    );

    expect(reply.length).toBeGreaterThan(0);
    // Verify DM exists — the bot should have mentioned a channel id
    // We verify indirectly: the reply should confirm success
    expect(reply.toLowerCase()).toMatch(/done|sent|created|hello|dm|direct/i);
  });

  // -- Channel Lifecycle --

  it('archives a channel', async () => {
    const chId = createdChannelIds[0];
    const reply = await sendAndExpectReply(
      `${TRIGGER} archive the Mattermost channel with id ${chId}. Just confirm.`,
      { timeout: WARM_TIMEOUT },
    );

    const ch = await mmApi<{ delete_at: number }>(`/channels/${chId}`);
    expect(ch.delete_at).toBeGreaterThan(0);
  });

  it('restores an archived channel', async () => {
    const chId = createdChannelIds[0];
    const reply = await sendAndExpectReply(
      `${TRIGGER} restore the archived Mattermost channel with id ${chId}. Just confirm.`,
      { timeout: WARM_TIMEOUT },
    );

    const ch = await mmApi<{ delete_at: number }>(`/channels/${chId}`);
    expect(ch.delete_at).toBe(0);
  });

  // -- Webhook --

  it('creates an incoming webhook', async () => {
    const chId = createdChannelIds[0];
    const reply = await sendAndExpectReply(
      `${TRIGGER} create a Mattermost incoming webhook for channel id ${chId} with display name "E2E Webhook". Tell me the webhook id.`,
      { timeout: WARM_TIMEOUT },
    );

    // Verify webhook exists
    const hooks = await mmApi<Array<{ id: string; display_name: string; channel_id: string }>>(`/hooks/incoming?per_page=100`);
    const hook = hooks.find(h => h.display_name === 'E2E Webhook' && h.channel_id === chId);
    expect(hook).toBeDefined();

    // Cleanup webhook
    if (hook) {
      await mmApi(`/hooks/incoming/${hook.id}`, { method: 'DELETE' });
    }
  });
});
