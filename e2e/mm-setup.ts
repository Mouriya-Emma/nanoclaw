/**
 * Mattermost E2E test setup — analogous to setup.ts for Telegram.
 *
 * Env vars (all have defaults for the local test instance):
 *   MM_URL, MM_BOT_TOKEN, MM_ADMIN_TOKEN, MM_CHANNEL_ID, MM_ADMIN_USER_ID, MM_BOT_USER_ID
 */
import WebSocket from 'ws';

// Polyfill for our channel implementation
if (!globalThis.WebSocket) (globalThis as any).WebSocket = WebSocket;

export const MM = {
  url: process.env.MM_URL || 'http://192.168.1.41:8065',
  botToken: process.env.MM_BOT_TOKEN || 'rzb5omofkidm7y6ij39fk9yizw',
  adminToken: process.env.MM_ADMIN_TOKEN || 'utoc9ubz6prqmjwttbynj8pz8w',
  channelId: process.env.MM_CHANNEL_ID || '6dj4tbgg3f8ejkocidopr99g7r',
  adminUserId: process.env.MM_ADMIN_USER_ID || 'bd8ckmo4o7nejkr3bfrqy8xebc',
  botUserId: process.env.MM_BOT_USER_ID || 'kfpdsyeantbiifdcfhicn1kcay',
  jid(): string {
    return `mm:${this.channelId}`;
  },
};

// --- REST helpers ---

export async function mmApi<T>(
  endpoint: string,
  opts: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token = MM.adminToken, ...fetchOpts } = opts;
  const resp = await fetch(`${MM.url}/api/v4${endpoint}`, {
    ...fetchOpts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...fetchOpts.headers,
    },
  });
  if (!resp.ok) throw new Error(`MM API ${resp.status}: ${await resp.text()}`);
  return resp.json() as Promise<T>;
}

/** Post a message as the admin user. */
export async function adminPost(message: string): Promise<string> {
  const post = await mmApi<{ id: string }>('/posts', {
    method: 'POST',
    body: JSON.stringify({ channel_id: MM.channelId, message }),
  });
  return post.id;
}

/** Delete a post (cleanup). */
export async function deletePost(postId: string): Promise<void> {
  await fetch(`${MM.url}/api/v4/posts/${postId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${MM.adminToken}` },
  });
}

/** Get recent posts in the test channel. */
export async function getRecentPosts(): Promise<
  { order: string[]; posts: Record<string, { id: string; message: string; user_id: string }> }
> {
  return mmApi(`/channels/${MM.channelId}/posts?per_page=20`);
}

// --- WebSocket listener for bot replies ---

let ws: WebSocket | null = null;
type MsgHandler = (post: { id: string; message: string; user_id: string; channel_id: string }) => void;
const handlers: MsgHandler[] = [];

export function startWsListener(): Promise<void> {
  return new Promise((resolve, reject) => {
    const wsUrl = MM.url.replace(/^http/, 'ws') + '/api/v4/websocket';
    ws = new WebSocket(wsUrl);
    let resolved = false;

    ws.on('open', () => {
      ws!.send(JSON.stringify({
        action: 'authentication_challenge',
        seq: 1,
        data: { token: MM.adminToken },
      }));
    });

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if ((msg.status === 'OK' || msg.event === 'hello') && !resolved) {
        resolved = true;
        resolve();
        return;
      }
      if (msg.event === 'posted' && msg.data?.post) {
        const post = JSON.parse(msg.data.post);
        for (const h of handlers) h(post);
      }
    });

    ws.on('error', (err) => {
      if (!resolved) { resolved = true; reject(err); }
    });
  });
}

export function stopWsListener(): void {
  if (ws) { ws.close(); ws = null; }
  handlers.length = 0;
}

/** Wait for a bot reply matching a condition. */
export function waitForBotReply(
  opts?: { match?: string | RegExp; timeout?: number },
): Promise<string> {
  const timeout = opts?.timeout ?? 60_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
      reject(new Error(`Timed out waiting for bot reply (${timeout}ms)`));
    }, timeout);

    const handler: MsgHandler = (post) => {
      if (post.user_id !== MM.botUserId) return;
      if (post.channel_id !== MM.channelId) return;
      const msg = post.message;
      if (opts?.match) {
        const ok = typeof opts.match === 'string' ? msg.includes(opts.match) : opts.match.test(msg);
        if (!ok) return;
      }
      clearTimeout(timer);
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
      resolve(msg);
    };
    handlers.push(handler);
  });
}

// --- High-level helpers (mirror Telegram helpers.ts) ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a message (as admin user) and wait for the bot to reply.
 */
export async function sendAndExpectReply(
  text: string,
  opts?: { timeout?: number; match?: string | RegExp },
): Promise<string> {
  const replyPromise = waitForBotReply(opts);
  await adminPost(text);
  return replyPromise;
}

/**
 * Send a message and assert no bot reply within the wait period.
 */
export async function sendAndExpectNoReply(
  text: string,
  opts?: { wait?: number },
): Promise<void> {
  const wait = opts?.wait ?? 15_000;
  let gotReply = false;
  let replyText = '';

  const handler: MsgHandler = (post) => {
    if (post.user_id === MM.botUserId && post.channel_id === MM.channelId) {
      gotReply = true;
      replyText = post.message;
    }
  };
  handlers.push(handler);
  await adminPost(text);
  await sleep(wait);
  const idx = handlers.indexOf(handler);
  if (idx >= 0) handlers.splice(idx, 1);
  if (gotReply) throw new Error(`Expected no reply but got: "${replyText}"`);
}

/** Send a message without waiting for reply. */
export async function send(text: string): Promise<void> {
  await adminPost(text);
}

export async function interTestDelay(): Promise<void> {
  await sleep(2000);
}
