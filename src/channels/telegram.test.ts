import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  DATA_DIR: '/tmp/nanoclaw-test-data',
  TRIGGER_PATTERN: /^@Andy\b/i,
  PI_PROVIDERS: [
    'anthropic',
    'google',
    'openai',
    'github-copilot',
    'google-antigravity',
  ],
}));

// Mock auth-manager
const mockGetAuthStatus = vi.fn(() => [
  { provider: 'anthropic', authenticated: false },
  { provider: 'openai-codex', authenticated: false },
  { provider: 'google-gemini-cli', authenticated: false },
  { provider: 'google-antigravity', authenticated: false },
  { provider: 'github-copilot', authenticated: false },
]);
vi.mock('../auth-manager.js', () => ({
  getAuthStatus: () => mockGetAuthStatus(),
  isValidProvider: vi.fn(),
  revokeAuth: vi.fn(),
  startOAuthFlow: vi.fn(),
}));

// Mock db (getLastPiPreference, setLastPiPreference, getToolRequirements)
const mockGetLastPiPreference = vi.fn<
  (folder: string) => { provider: string; modelId?: string } | undefined
>(() => undefined);
const mockSetLastPiPreference = vi.fn();
const mockGetToolRequirements = vi.fn(() => []);
vi.mock('../db.js', () => ({
  getLastPiPreference: (folder: string) => mockGetLastPiPreference(folder),
  setLastPiPreference: (folder: string, provider: string, modelId?: string) =>
    mockSetLastPiPreference(folder, provider, modelId),
  getToolRequirements: () => mockGetToolRequirements(),
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      setMessageReaction: vi.fn().mockResolvedValue(undefined),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
  InlineKeyboard: class MockInlineKeyboard {
    rows: any[] = [];
    text(_label: string, _data: string) {
      return this;
    }
    row() {
      return this;
    }
  },
}));

import { TelegramChannel, buildJid, parseJid } from './telegram.js';
import { ChannelOpts } from './registry.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: any;
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
      ...(overrides.message_thread_id !== undefined && {
        message_thread_id: overrides.message_thread_id,
      }),
      ...(overrides.is_topic_message !== undefined && {
        is_topic_message: overrides.is_topic_message,
      }),
      ...(overrides.reply_to_message !== undefined && {
        reply_to_message: overrides.reply_to_message,
      }),
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  extra?: Record<string, any>;
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: any;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      ...(overrides.extra || {}),
      ...(overrides.message_thread_id !== undefined && {
        message_thread_id: overrides.message_thread_id,
      }),
      ...(overrides.is_topic_message !== undefined && {
        is_topic_message: overrides.is_topic_message,
      }),
      ...(overrides.reply_to_message !== undefined && {
        reply_to_message: overrides.reply_to_message,
      }),
    },
    me: { username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips command messages (starting with /)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: '/start' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Andy @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('stores photo with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('stores photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ caption: 'Look at this' });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Look at this' }),
      );
    });

    it('stores video with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores voice message with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Voice message]' }),
      );
    });

    it('stores audio with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores document with filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf' } },
      });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: report.pdf]' }),
      );
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ extra: { document: {} } });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Document: file]' }),
      );
    });

    it('stores sticker with emoji', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        undefined,
      );
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        undefined,
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        undefined,
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        undefined,
      );
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
        undefined,
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  // --- /pi command ---

  describe('/pi command', () => {
    function createCommandCtx(args: string) {
      return {
        chat: { id: 100200300, type: 'group' as const },
        from: { id: 99001, first_name: 'Alice' },
        message: { message_id: 1 } as any,
        match: args,
        reply: vi.fn(),
      };
    }

    function optsWithModel() {
      return createTestOpts({
        onSetModel: vi.fn(),
        onClearSession: vi.fn(),
        onGetModel: vi.fn(() => ({ provider: 'claude' })),
      });
    }

    it('/pi anthropic switches to pi-mono provider and clears session', async () => {
      const opts = optsWithModel();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('pi')!;
      await handler(createCommandCtx('anthropic'));

      expect(opts.onSetModel).toHaveBeenCalledWith(
        'tg:100200300',
        'anthropic',
        undefined,
      );
      expect(opts.onClearSession).toHaveBeenCalledWith('tg:100200300');
      expect(mockSetLastPiPreference).toHaveBeenCalledWith(
        'test-group',
        'anthropic',
        undefined,
      );
    });

    it('/pi google switches to google provider', async () => {
      const opts = optsWithModel();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('pi')!;
      await handler(createCommandCtx('google'));

      expect(opts.onSetModel).toHaveBeenCalledWith(
        'tg:100200300',
        'google',
        undefined,
      );
      expect(opts.onClearSession).toHaveBeenCalled();
    });

    it('/pi without args shows provider buttons', async () => {
      mockGetAuthStatus.mockReturnValueOnce([
        { provider: 'openai', authenticated: true },
        { provider: 'google', authenticated: true },
      ]);
      const opts = optsWithModel();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('pi')!;
      const ctx = createCommandCtx('');
      await handler(ctx);

      expect(opts.onSetModel).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        'Select a pi-mono provider:',
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
    });

    it('/pi without args and no auth shows error', async () => {
      mockGetLastPiPreference.mockReturnValueOnce(undefined);
      mockGetAuthStatus.mockReturnValueOnce([
        { provider: 'anthropic', authenticated: false },
        { provider: 'openai-codex', authenticated: false },
        { provider: 'google-gemini-cli', authenticated: false },
        { provider: 'google-antigravity', authenticated: false },
        { provider: 'github-copilot', authenticated: false },
      ]);
      const opts = optsWithModel();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('pi')!;
      const ctx = createCommandCtx('');
      await handler(ctx);

      expect(opts.onSetModel).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('No authenticated'),
      );
    });

    it('/pi invalid rejects unknown provider', async () => {
      const opts = optsWithModel();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('pi')!;
      const ctx = createCommandCtx('banana');
      await handler(ctx);

      expect(opts.onSetModel).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Unknown pi-mono provider'),
      );
    });

    it('/pi rejects unregistered chat', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
        onSetModel: vi.fn(),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('pi')!;
      const ctx = createCommandCtx('anthropic');
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
    });
  });

  // --- /cla command ---

  describe('/cla command', () => {
    function createCommandCtx() {
      return {
        chat: { id: 100200300, type: 'group' as const },
        from: { id: 99001, first_name: 'Alice' },
        message: { message_id: 1 } as any,
        reply: vi.fn(),
      };
    }

    it('/cla switches to Claude Agent SDK and clears session', async () => {
      const opts = createTestOpts({
        onSetModel: vi.fn(),
        onClearSession: vi.fn(),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('cla')!;
      await handler(createCommandCtx());

      expect(opts.onSetModel).toHaveBeenCalledWith('tg:100200300', 'claude');
      expect(opts.onClearSession).toHaveBeenCalledWith('tg:100200300');
    });

    it('/cla rejects unregistered chat', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('cla')!;
      const ctx = createCommandCtx();
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('This chat is not registered.');
    });
  });

  // --- /model command ---

  describe('/model command', () => {
    function createCommandCtx(args: string) {
      return {
        chat: { id: 100200300, type: 'group' as const },
        from: { id: 99001, first_name: 'Alice' },
        message: { message_id: 1 } as any,
        match: args,
        reply: vi.fn(),
      };
    }

    it('/model sets model within current provider', async () => {
      const opts = createTestOpts({
        onGetModel: vi.fn(() => ({ provider: 'google' })),
        onSetModel: vi.fn(),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      await handler(createCommandCtx('gemini-2.5-flash'));

      expect(opts.onSetModel).toHaveBeenCalledWith(
        'tg:100200300',
        'google',
        'gemini-2.5-flash',
      );
    });

    it('/model preserves current provider (does not switch runtime)', async () => {
      const opts = createTestOpts({
        onGetModel: vi.fn(() => ({
          provider: 'anthropic',
          modelId: 'old-model',
        })),
        onSetModel: vi.fn(),
        onClearSession: vi.fn(),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      await handler(createCommandCtx('claude-sonnet-4'));

      expect(opts.onSetModel).toHaveBeenCalledWith(
        'tg:100200300',
        'anthropic',
        'claude-sonnet-4',
      );
      // Does NOT clear session
      expect(opts.onClearSession).not.toHaveBeenCalled();
    });

    it('/model without args shows current status', async () => {
      const opts = createTestOpts({
        onGetModel: vi.fn(() => ({
          provider: 'google',
          modelId: 'gemini-2.5-flash',
        })),
        onSetModel: vi.fn(),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('model')!;
      const ctx = createCommandCtx('');
      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('google'),
        expect.anything(),
      );
      expect(opts.onSetModel).not.toHaveBeenCalled();
    });
  });

  // --- /ask extended providers ---

  describe('/ask command with extended providers', () => {
    function createAskCtx(args: string) {
      return {
        chat: { id: 100200300, type: 'group' as const },
        from: { id: 99001, first_name: 'Alice', username: 'alice_user' },
        message: { message_id: 1, date: Math.floor(Date.now() / 1000) } as any,
        match: args,
        reply: vi.fn(),
      };
    }

    it('/ask anthropic routes to anthropic provider', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ask')!;
      await handler(createAskCtx('anthropic What is 2+2?'));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '__ASK_ANTHROPIC__ What is 2+2?',
        }),
      );
    });

    it('/ask copilot maps to github-copilot provider', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ask')!;
      await handler(createAskCtx('copilot Help me code'));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '__ASK_GITHUB-COPILOT__ Help me code',
        }),
      );
    });

    it('/ask gemini still maps to google', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ask')!;
      await handler(createAskCtx('gemini Explain quantum'));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '__ASK_GOOGLE__ Explain quantum',
        }),
      );
    });

    it('/ask github-copilot works with full name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ask')!;
      await handler(createAskCtx('github-copilot Write a function'));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '__ASK_GITHUB-COPILOT__ Write a function',
        }),
      );
    });

    it('/ask unknown-provider shows error', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ask')!;
      const ctx = createAskCtx('banana Hello');
      await handler(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Unknown provider'),
      );
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });

  // --- buildJid / parseJid ---

  describe('buildJid', () => {
    it('returns simple JID for regular group', () => {
      expect(buildJid({ chat: { id: -1001234, type: 'group' } })).toBe(
        'tg:-1001234',
      );
    });

    it('returns simple JID for private chat', () => {
      expect(buildJid({ chat: { id: 99001, type: 'private' } })).toBe(
        'tg:99001',
      );
    });

    it('returns JID with thread_id for supergroup forum topic', () => {
      expect(
        buildJid({
          chat: { id: -1001234, type: 'supergroup' },
          message: { message_thread_id: 5678, is_topic_message: true },
        }),
      ).toBe('tg:-1001234:5678');
    });

    it('returns simple JID when thread_id present but not a topic message', () => {
      expect(
        buildJid({
          chat: { id: -1001234, type: 'supergroup' },
          message: { message_thread_id: 5678, is_topic_message: false },
        }),
      ).toBe('tg:-1001234');
    });

    it('returns simple JID when thread_id present but chat is not supergroup', () => {
      expect(
        buildJid({
          chat: { id: -1001234, type: 'group' },
          message: { message_thread_id: 5678, is_topic_message: true },
        }),
      ).toBe('tg:-1001234');
    });

    it('returns simple JID when no message provided', () => {
      expect(buildJid({ chat: { id: -1001234, type: 'supergroup' } })).toBe(
        'tg:-1001234',
      );
    });
  });

  describe('parseJid', () => {
    it('parses simple positive chat ID', () => {
      expect(parseJid('tg:99001')).toEqual({ chatId: '99001' });
    });

    it('parses simple negative chat ID', () => {
      expect(parseJid('tg:-1001234')).toEqual({ chatId: '-1001234' });
    });

    it('parses JID with thread_id', () => {
      expect(parseJid('tg:-1001234:5678')).toEqual({
        chatId: '-1001234',
        threadId: 5678,
      });
    });

    it('parses positive chat ID with thread_id', () => {
      expect(parseJid('tg:99001:42')).toEqual({
        chatId: '99001',
        threadId: 42,
      });
    });
  });

  // --- Forum topic support ---

  describe('forum topic support', () => {
    it('uses topic JID for supergroup forum messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:-1001234:5678': {
            name: 'Dev Topic',
            folder: 'dev-topic-5678',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: -1001234,
        chatType: 'supergroup',
        text: 'Hello topic',
        message_thread_id: 5678,
        is_topic_message: true,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234:5678',
        expect.objectContaining({
          chat_jid: 'tg:-1001234:5678',
          content: 'Hello topic',
        }),
      );
    });

    it('auto-registers topic when parent group is registered', async () => {
      const onRegisterGroup = vi.fn();
      const groups: Record<string, any> = {
        'tg:-1001234': {
          name: 'Parent Group',
          folder: 'parent-group',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requiresTrigger: false,
        },
      };
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => groups),
        onRegisterGroup: vi.fn((jid, group) => {
          groups[jid] = group;
          onRegisterGroup(jid, group);
        }),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: -1001234,
        chatType: 'supergroup',
        text: 'Hello from topic',
        message_thread_id: 42,
        is_topic_message: true,
        reply_to_message: {
          forum_topic_created: { name: 'Dev Chat' },
        },
      });
      await triggerTextMessage(ctx);

      expect(onRegisterGroup).toHaveBeenCalledWith(
        'tg:-1001234:42',
        expect.objectContaining({
          name: 'Dev Chat',
          folder: 'parent-group-topic-42',
          trigger: '@Andy',
          requiresTrigger: false,
        }),
      );
      // Message should also be delivered after auto-registration
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234:42',
        expect.objectContaining({ content: 'Hello from topic' }),
      );
    });

    it('uses fallback topic name when forum_topic_created is missing', async () => {
      const groups: Record<string, any> = {
        'tg:-1001234': {
          name: 'Parent',
          folder: 'parent',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      };
      const onRegisterGroup = vi.fn((jid: string, group: any) => {
        groups[jid] = group;
      });
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => groups),
        onRegisterGroup,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: -1001234,
        chatType: 'supergroup',
        text: 'Hi',
        message_thread_id: 99,
        is_topic_message: true,
      });
      await triggerTextMessage(ctx);

      expect(onRegisterGroup).toHaveBeenCalledWith(
        'tg:-1001234:99',
        expect.objectContaining({
          name: 'Topic 99',
          folder: 'parent-topic-99',
        }),
      );
    });

    it('does not auto-register if no onRegisterGroup callback', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:-1001234': {
            name: 'Parent',
            folder: 'parent',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
        // No onRegisterGroup callback
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: -1001234,
        chatType: 'supergroup',
        text: 'Hi',
        message_thread_id: 99,
        is_topic_message: true,
      });
      await triggerTextMessage(ctx);

      // Message not delivered (unregistered)
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not auto-register if parent group is not registered', async () => {
      const onRegisterGroup = vi.fn();
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
        onRegisterGroup,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatId: -1001234,
        chatType: 'supergroup',
        text: 'Hi',
        message_thread_id: 42,
        is_topic_message: true,
      });
      await triggerTextMessage(ctx);

      expect(onRegisterGroup).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('sendMessage passes thread_id for topic JIDs', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234:5678', 'Topic reply');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234',
        'Topic reply',
        { message_thread_id: 5678 },
      );
    });

    it('sendMessage does not pass thread_id for regular JIDs', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234', 'Regular reply');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234',
        'Regular reply',
        undefined,
      );
    });

    it('setTyping passes thread_id for topic JIDs', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:-1001234:5678', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '-1001234',
        'typing',
        { message_thread_id: 5678 },
      );
    });

    it('/chatid shows topic JID in forum context', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: {
          id: -1001234,
          type: 'supergroup' as const,
          title: 'Forum Group',
        },
        from: { first_name: 'Alice' },
        message: { message_thread_id: 42, is_topic_message: true },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:-1001234:42'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('auto-registers non-text media in forum topics', async () => {
      const groups: Record<string, any> = {
        'tg:-1001234': {
          name: 'Parent',
          folder: 'parent',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      };
      const onRegisterGroup = vi.fn((jid: string, group: any) => {
        groups[jid] = group;
      });
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => groups),
        onRegisterGroup,
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        chatId: -1001234,
        chatType: 'supergroup',
        message_thread_id: 77,
        is_topic_message: true,
      });
      await triggerMediaMessage('message:photo', ctx);

      expect(onRegisterGroup).toHaveBeenCalledWith(
        'tg:-1001234:77',
        expect.objectContaining({ folder: 'parent-topic-77' }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234:77',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });
  });
});
