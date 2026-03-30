import WebSocket from 'ws';

import { TRIGGER_PATTERN } from '../config.js';
import { deleteUserToken, getUserToken, setUserToken } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { handleSharedCommand } from './commands.js';
import { registerChannel, ChannelOpts } from './registry.js';

// --- Mattermost API types ---

interface MattermostPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  create_at: number;
  type: string;
}

interface MattermostUser {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
}

interface MattermostChannelInfo {
  id: string;
  display_name: string;
  name: string;
  type: string; // 'O' = public, 'P' = private, 'D' = DM, 'G' = group DM
}

interface WsMessage {
  event?: string;
  action?: string;
  status?: string;
  seq?: number;
  seq_reply?: number;
  data?: Record<string, string>;
  broadcast?: { channel_id?: string; user_id?: string; team_id?: string };
}

// --- Constants ---

const MAX_MESSAGE_LENGTH = 16383;
const WS_RECONNECT_DELAY = 3000;
const WS_MAX_RECONNECT_DELAY = 60000;
export class MattermostChannel implements Channel {
  name = 'mattermost';

  private opts: ChannelOpts;
  private baseUrl: string;
  private botToken: string;
  private botUserId: string | null = null;
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = WS_RECONNECT_DELAY;
  private shouldReconnect = true;
  private wsSeq = 1;

  // Channel info cache: channelId → MattermostChannelInfo (rarely changes)
  private channelCache = new Map<string, MattermostChannelInfo>();

  constructor(baseUrl: string, botToken: string, opts: ChannelOpts) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.botToken = botToken;
    this.opts = opts;
  }

  // --- REST API ---

  private async api<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v4${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mattermost API error: ${response.status} ${error}`);
    }

    return response.json() as T;
  }

  private async apiWithToken<T>(
    endpoint: string,
    token: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v4${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Mattermost API error: ${response.status} ${error}`);
    }

    return response.json() as T;
  }

  async executeSlashCommand(
    userId: string,
    command: string,
    channelId: string,
  ): Promise<{ ok: boolean; response?: string; error?: string }> {
    const token = getUserToken(userId, 'mattermost');
    if (!token) {
      return {
        ok: false,
        error:
          'No token stored for this user. Ask them to run /delegate in a DM first.',
      };
    }

    try {
      const result = await this.apiWithToken<{
        response_type?: string;
        text?: string;
      }>('/commands/execute', token, {
        method: 'POST',
        body: JSON.stringify({ channel_id: channelId, command }),
      });
      return { ok: true, response: result.text || 'Command executed' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Token might be revoked
      if (msg.includes('401')) {
        return {
          ok: false,
          error:
            'Token expired or revoked. Ask the user to run /delegate again.',
        };
      }
      return { ok: false, error: msg };
    }
  }

  private async getUser(userId: string): Promise<MattermostUser> {
    try {
      return await this.api<MattermostUser>(`/users/${userId}`);
    } catch {
      return { id: userId, username: 'unknown' };
    }
  }

  private async getChannelInfo(
    channelId: string,
  ): Promise<MattermostChannelInfo | null> {
    const cached = this.channelCache.get(channelId);
    if (cached) return cached;
    try {
      const info = await this.api<MattermostChannelInfo>(
        `/channels/${channelId}`,
      );
      this.channelCache.set(channelId, info);
      return info;
    } catch {
      return null;
    }
  }

  // --- WebSocket ---

  async connect(): Promise<void> {
    // Authenticate first
    const me = await this.api<MattermostUser>('/users/me');
    this.botUserId = me.id;
    logger.info(
      { username: me.username, userId: me.id },
      'Mattermost bot authenticated',
    );

    // Connect WebSocket
    await this.connectWs();

    this.connected = true;
    console.log(`\n  Mattermost bot: @${me.username}`);
    console.log(
      `  Send a direct message or mention in a channel to interact\n`,
    );
  }

  private connectWs(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = this.baseUrl
        .replace(/^http/, 'ws')
        .concat('/api/v4/websocket');

      this.ws = new WebSocket(wsUrl);
      let resolved = false;

      this.ws.on('open', () => {
        // Authenticate via challenge
        this.wsSend({
          action: 'authentication_challenge',
          seq: this.wsSeq++,
          data: { token: this.botToken },
        });
      });

      this.ws.on('message', (raw: Buffer) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Auth response
        if (msg.status === 'OK' && msg.seq_reply && !resolved) {
          resolved = true;
          this.reconnectDelay = WS_RECONNECT_DELAY;
          logger.info('Mattermost WebSocket connected');
          resolve();
          return;
        }

        // Hello event (confirms connection)
        if (msg.event === 'hello' && !resolved) {
          resolved = true;
          this.reconnectDelay = WS_RECONNECT_DELAY;
          resolve();
          return;
        }

        // Route events
        if (msg.event === 'posted') {
          this.handlePosted(msg);
        }
      });

      this.ws.on('close', () => {
        logger.warn('Mattermost WebSocket closed');
        this.connected = false;
        if (this.shouldReconnect) this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        logger.error({ err }, 'Mattermost WebSocket error');
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    logger.info(
      { delayMs: this.reconnectDelay },
      'Mattermost WebSocket reconnecting',
    );
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connectWs();
        this.connected = true;
      } catch (err) {
        logger.error({ err }, 'Mattermost WebSocket reconnection failed');
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          WS_MAX_RECONNECT_DELAY,
        );
        if (this.shouldReconnect) this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private wsSend(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // --- Event handling ---

  private async handlePosted(msg: WsMessage): Promise<void> {
    if (!msg.data?.post) return;

    let post: MattermostPost;
    try {
      post = JSON.parse(msg.data.post);
    } catch {
      return;
    }

    // Skip own messages
    if (post.user_id === this.botUserId) return;

    // Skip system messages
    if (post.type && post.type !== '') return;

    const chatJid = `mm:${post.channel_id}`;
    const timestamp = new Date(post.create_at).toISOString();

    // Get sender info (cached)
    const user = await this.getUser(post.user_id);
    const senderName = user.first_name || user.username || 'unknown';

    // Get channel info for metadata
    const channelInfo = await this.getChannelInfo(post.channel_id);
    const channelName = channelInfo?.display_name || post.channel_id;
    const isGroup =
      channelInfo?.type === 'O' ||
      channelInfo?.type === 'P' ||
      channelInfo?.type === 'G';

    // Store chat metadata
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      channelName,
      'mattermost',
      isGroup,
    );

    // Handle commands (messages starting with /)
    if (post.message.startsWith('/')) {
      this.handleCommand(post, chatJid);
      return;
    }

    // Check if channel is registered
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, channelName },
        'Message from unregistered Mattermost channel',
      );
      return;
    }

    // Check trigger requirement
    let content = post.message;
    if (group.requiresTrigger !== false && !group.isMain) {
      if (!TRIGGER_PATTERN.test(content.trim())) return;
      content = content.replace(TRIGGER_PATTERN, '').trim();
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: post.id,
      chat_jid: chatJid,
      sender: post.user_id,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, channelName, sender: senderName },
      'Mattermost message received',
    );
  }

  // --- Commands ---

  private async handleCommand(
    post: MattermostPost,
    chatJid: string,
  ): Promise<void> {
    const parts = post.message.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = post.message.slice(cmd.length).trim();

    // Try shared command handler first
    const group = this.opts.registeredGroups()[chatJid] || null;
    const user = await this.getUser(post.user_id);
    const result = await handleSharedCommand(cmd, args, {
      chatJid,
      userId: post.user_id,
      senderName: user.first_name || user.username || 'unknown',
      channelName: 'mattermost',
      timestamp: new Date(post.create_at).toISOString(),
      messageId: post.id,
      group,
      opts: this.opts,
    });

    if (result) {
      let text = result.text;
      if (result.choices) {
        text = result.choicePrompt || result.text;
        text +=
          '\n' +
          result.choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n');
      }
      await this.sendToChannel(post.channel_id, text);
      return;
    }

    // Channel-specific commands
    switch (cmd) {
      case '/chatid': {
        const channelInfo = await this.getChannelInfo(post.channel_id);
        const name = channelInfo?.display_name || 'Unknown';
        const type = channelInfo?.type || '?';
        const typeLabel =
          type === 'O'
            ? 'Public'
            : type === 'P'
              ? 'Private'
              : type === 'D'
                ? 'Direct Message'
                : type === 'G'
                  ? 'Group DM'
                  : type;
        await this.sendToChannel(
          post.channel_id,
          `**Chat ID:** \`${chatJid}\`\n**Name:** ${name}\n**Type:** ${typeLabel}`,
        );
        break;
      }

      case '/delegate': {
        // Only accept token submission in DM channels
        const authChannelInfo = await this.getChannelInfo(post.channel_id);
        if (!authChannelInfo || authChannelInfo.type !== 'D') {
          await this.sendToChannel(
            post.channel_id,
            'Please send `/delegate` in a **direct message** to me for security.',
          );
          return;
        }

        const token = parts[1];
        if (!token) {
          await this.sendToChannel(
            post.channel_id,
            [
              'To delegate slash command execution, I need your Mattermost **Personal Access Token**.',
              '',
              '1. Go to your profile picture → **Profile** → **Security** → **Personal Access Tokens**',
              '2. Click **Create Token**, give it a description like "andy-bot delegation"',
              '3. Copy the **Token ID** (not the Access Token ID) and send:',
              '```',
              '/delegate <your-token>',
              '```',
              '',
              'Your token will be stored securely and only used to execute slash commands on your behalf.',
            ].join('\n'),
          );
          return;
        }

        // Validate token by calling /users/me
        try {
          const tokenUser = await this.apiWithToken<MattermostUser>(
            '/users/me',
            token,
          );
          // Verify token belongs to the sender
          if (tokenUser.id !== post.user_id) {
            await this.sendToChannel(
              post.channel_id,
              'This token does not belong to you.',
            );
            return;
          }

          setUserToken(post.user_id, 'mattermost', token);

          // Delete the message containing the token for security
          try {
            await this.api(`/posts/${post.id}`, { method: 'DELETE' });
          } catch {
            // Bot may lack permission; warn user
            await this.sendToChannel(
              post.channel_id,
              'Could not auto-delete your token message. Please delete it manually.',
            );
          }

          await this.sendToChannel(
            post.channel_id,
            `Token stored for **${tokenUser.username}**. I can now execute slash commands on your behalf.`,
          );
          logger.info(
            { userId: post.user_id, username: tokenUser.username },
            'User token stored for slash command delegation',
          );
        } catch {
          await this.sendToChannel(
            post.channel_id,
            'Invalid token. Please check and try again.',
          );
        }
        break;
      }

      case '/revoke': {
        deleteUserToken(post.user_id, 'mattermost');
        await this.sendToChannel(
          post.channel_id,
          'Your token has been revoked. I can no longer execute slash commands on your behalf.',
        );
        logger.info(
          { userId: post.user_id },
          'User token revoked for slash command delegation',
        );
        break;
      }
    }
  }

  // --- Send messages ---

  private async sendToChannel(channelId: string, text: string): Promise<void> {
    await this.api('/posts', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channelId, message: text }),
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^mm:/, '');
    try {
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.sendToChannel(channelId, text);
      } else {
        // Split on newline boundaries when possible
        const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
        for (const chunk of chunks) {
          await this.sendToChannel(channelId, chunk);
        }
      }
      logger.info({ jid, length: text.length }, 'Mattermost message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Mattermost message');
    }
  }

  // --- Typing indicator via WebSocket ---

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const channelId = jid.replace(/^mm:/, '');
    this.wsSend({
      action: 'user_typing',
      seq: this.wsSeq++,
      data: { channel_id: channelId, parent_id: '' },
    });
  }

  // --- Channel interface ---

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mm:');
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.botUserId = null;
    logger.info('Mattermost bot stopped');
  }
}

// --- Helpers ---

/** Split a long message into chunks, preferring newline boundaries. */
function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Find last newline within limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0 || splitIdx < maxLen / 2) {
      // No good newline; fall back to space
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx <= 0 || splitIdx < maxLen / 2) {
      // Hard cut
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// --- Self-register ---

registerChannel('mattermost', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['MATTERMOST_URL', 'MATTERMOST_BOT_TOKEN']);
  const url = process.env.MATTERMOST_URL || envVars.MATTERMOST_URL || '';
  const token =
    process.env.MATTERMOST_BOT_TOKEN || envVars.MATTERMOST_BOT_TOKEN || '';
  if (!url || !token) return null;
  return new MattermostChannel(url, token, opts);
});
