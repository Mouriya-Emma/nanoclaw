import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

import { MattermostChannel } from './mattermost.js';

type MockWs = EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
};

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock ws module — factory cannot reference top-level variables (hoisting)
vi.mock('ws', () => {
  const { EventEmitter } = require('events');
  class WS extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
  }
  return { default: WS, WebSocket: WS };
});

// --- Helpers ---

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

function makeMockOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
    onClearSession: vi.fn(),
    onStopContainer: vi.fn(),
  };
}

function makePost(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'post1',
    channel_id: 'ch1',
    user_id: 'user1',
    message: 'hello world',
    create_at: 1700000000000,
    type: '',
    ...overrides,
  });
}

function makeWsPostedEvent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: 'posted',
    data: {
      post: makePost(overrides),
      sender_name: '@testuser',
      channel_type: 'O',
    },
    broadcast: { channel_id: 'ch1' },
    seq: 1,
  });
}

// --- Tests ---

describe('MattermostChannel', () => {
  let channel: MattermostChannel;
  let opts: ReturnType<typeof makeMockOpts>;
  let wsInstance: MockWs;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = makeMockOpts();
    channel = new MattermostChannel(
      'https://mm.example.com',
      'test-token',
      opts,
    );
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  async function connectChannel() {
    // Mock /users/me
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'bot123', username: 'andybot' }),
    );

    const connectPromise = channel.connect();

    // Wait for WebSocket constructor to fire
    await new Promise((r) => setTimeout(r, 10));

    // Get the ws instance (created by the constructor mock)
    wsInstance = (channel as any).ws;

    // Simulate WebSocket open → auth challenge → hello
    wsInstance.emit('open');
    await new Promise((r) => setTimeout(r, 10));

    // Simulate auth OK response
    wsInstance.emit(
      'message',
      Buffer.from(JSON.stringify({ status: 'OK', seq_reply: 1 })),
    );

    await connectPromise;
    mockFetch.mockClear();
  }

  describe('connect', () => {
    it('authenticates via REST and connects WebSocket', async () => {
      await connectChannel();

      expect(channel.isConnected()).toBe(true);
      // Auth challenge was sent
      expect(wsInstance.send).toHaveBeenCalledWith(
        expect.stringContaining('authentication_challenge'),
      );
    });

    it('throws on auth failure', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ message: 'Unauthorized' }, 401),
      );

      await expect(channel.connect()).rejects.toThrow(
        'Mattermost API error: 401',
      );
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('message handling', () => {
    beforeEach(async () => {
      await connectChannel();
    });

    it('delivers messages from registered channels', async () => {
      opts.registeredGroups.mockReturnValue({
        'mm:ch1': {
          name: 'test',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2024-01-01',
          isMain: true,
        },
      });

      // Mock user lookup
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice', first_name: 'Alice' }),
      );
      // Mock channel info
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );

      wsInstance.emit('message', Buffer.from(makeWsPostedEvent()));
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'mm:ch1',
        expect.objectContaining({
          id: 'post1',
          chat_jid: 'mm:ch1',
          sender: 'user1',
          sender_name: 'Alice',
          content: 'hello world',
        }),
      );
    });

    it('skips messages from unregistered channels', async () => {
      opts.registeredGroups.mockReturnValue({});

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice' }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );

      wsInstance.emit('message', Buffer.from(makeWsPostedEvent()));
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips own messages', async () => {
      wsInstance.emit(
        'message',
        Buffer.from(makeWsPostedEvent({ user_id: 'bot123' })),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips system messages', async () => {
      wsInstance.emit(
        'message',
        Buffer.from(makeWsPostedEvent({ type: 'system_join_channel' })),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('requires trigger for non-main groups', async () => {
      opts.registeredGroups.mockReturnValue({
        'mm:ch1': {
          name: 'test',
          folder: 'other',
          trigger: '@Andy',
          added_at: '2024-01-01',
          requiresTrigger: true,
        },
      });

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice' }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );

      // Message without trigger — should be skipped
      wsInstance.emit('message', Buffer.from(makeWsPostedEvent()));
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('strips trigger and delivers for non-main groups', async () => {
      opts.registeredGroups.mockReturnValue({
        'mm:ch1': {
          name: 'test',
          folder: 'other',
          trigger: '@Andy',
          added_at: '2024-01-01',
          requiresTrigger: true,
        },
      });

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice', first_name: 'Alice' }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );

      wsInstance.emit(
        'message',
        Buffer.from(
          makeWsPostedEvent({ message: '@Andy what is the weather?' }),
        ),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'mm:ch1',
        expect.objectContaining({
          content: 'what is the weather?',
        }),
      );
    });

    it('caches channel info across messages', async () => {
      opts.registeredGroups.mockReturnValue({
        'mm:ch1': {
          name: 'test',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2024-01-01',
          isMain: true,
        },
      });

      // First message: user fetch + channel fetch
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice', first_name: 'Alice' }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );

      wsInstance.emit('message', Buffer.from(makeWsPostedEvent()));
      await new Promise((r) => setTimeout(r, 50));

      // Second message: user fetch again, but channel info is cached
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice', first_name: 'Alice' }),
      );

      wsInstance.emit(
        'message',
        Buffer.from(makeWsPostedEvent({ id: 'post2', message: 'second msg' })),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledTimes(2);
      // 3 fetch calls: 2 user + 1 channel (channel cached on second)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('commands', () => {
    beforeEach(async () => {
      await connectChannel();
    });

    it('handles /chatid command', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice' }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );
      // For the reply post
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'reply1' }));

      wsInstance.emit(
        'message',
        Buffer.from(makeWsPostedEvent({ message: '/chatid' })),
      );
      await new Promise((r) => setTimeout(r, 50));

      // Should have sent a reply with the JID
      expect(mockFetch).toHaveBeenCalledWith(
        'https://mm.example.com/api/v4/posts',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('mm:ch1'),
        }),
      );
      // Should NOT deliver as a regular message
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles /ping command', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice' }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'reply1' }));

      wsInstance.emit(
        'message',
        Buffer.from(makeWsPostedEvent({ message: '/ping' })),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(mockFetch).toHaveBeenCalledWith(
        'https://mm.example.com/api/v4/posts',
        expect.objectContaining({
          body: expect.stringContaining('Andy is online'),
        }),
      );
    });

    it('handles /clear command for registered channel', async () => {
      opts.registeredGroups.mockReturnValue({
        'mm:ch1': {
          name: 'test',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2024-01-01',
        },
      });

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice' }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'reply1' }));

      wsInstance.emit(
        'message',
        Buffer.from(makeWsPostedEvent({ message: '/clear' })),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onClearSession).toHaveBeenCalledWith('mm:ch1');
    });

    it('handles /stop command for registered channel', async () => {
      opts.registeredGroups.mockReturnValue({
        'mm:ch1': {
          name: 'test',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2024-01-01',
        },
      });

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice' }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'reply1' }));

      wsInstance.emit(
        'message',
        Buffer.from(makeWsPostedEvent({ message: '/stop' })),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onStopContainer).toHaveBeenCalledWith('mm:ch1');
    });

    it('replies error for /clear on unregistered channel', async () => {
      opts.registeredGroups.mockReturnValue({});

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'user1', username: 'alice' }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 'ch1',
          display_name: 'General',
          name: 'general',
          type: 'O',
        }),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'reply1' }));

      wsInstance.emit(
        'message',
        Buffer.from(makeWsPostedEvent({ message: '/clear' })),
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onClearSession).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://mm.example.com/api/v4/posts',
        expect.objectContaining({
          body: expect.stringContaining('not registered'),
        }),
      );
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      await connectChannel();
    });

    it('sends a message to the correct channel', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'post1' }));

      await channel.sendMessage('mm:channel123', 'Hello!');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://mm.example.com/api/v4/posts',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            channel_id: 'channel123',
            message: 'Hello!',
          }),
        }),
      );
    });

    it('splits long messages', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 'post1' }));

      const longMessage = 'x'.repeat(20000);
      await channel.sendMessage('mm:channel123', longMessage);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('ownsJid', () => {
    it('owns mm: prefixed JIDs', () => {
      expect(channel.ownsJid('mm:channel123')).toBe(true);
    });

    it('does not own other JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('slack:C123')).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('stops WebSocket and clears state', async () => {
      await connectChannel();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(wsInstance.close).toHaveBeenCalled();
    });
  });

  describe('setTyping', () => {
    it('sends user_typing via WebSocket', async () => {
      await connectChannel();

      await channel.setTyping('mm:ch1', true);

      expect(wsInstance.send).toHaveBeenCalledWith(
        expect.stringContaining('user_typing'),
      );
    });

    it('does nothing when isTyping is false', async () => {
      await connectChannel();
      wsInstance.send.mockClear();

      await channel.setTyping('mm:ch1', false);

      expect(wsInstance.send).not.toHaveBeenCalled();
    });
  });
});
