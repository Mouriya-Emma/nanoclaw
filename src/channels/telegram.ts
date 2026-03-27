import { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel } from './registry.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
  onClearSession?: (jid: string) => void;
  onStopContainer?: (jid: string) => void;
}

/** Build JID from a Telegram context, including thread_id for forum topics. */
export function buildJid(ctx: {
  chat: { id: number; type: string };
  message?: { message_thread_id?: number; is_topic_message?: boolean };
}): string {
  const chatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id;
  // Only append thread_id for supergroup forum topics
  if (
    threadId &&
    ctx.message?.is_topic_message &&
    ctx.chat.type === 'supergroup'
  ) {
    return `tg:${chatId}:${threadId}`;
  }
  return `tg:${chatId}`;
}

/** Parse a Telegram JID into chat_id and optional thread_id. */
export function parseJid(jid: string): { chatId: string; threadId?: number } {
  const stripped = jid.replace(/^tg:/, '');
  const colonIdx = stripped.lastIndexOf(':');
  // tg:-1001234:5678 → chatId=-1001234, threadId=5678
  // tg:-1001234 → chatId=-1001234
  // Need to handle negative IDs: find last colon that separates threadId
  if (colonIdx > 0) {
    const possibleThread = stripped.slice(colonIdx + 1);
    const threadNum = Number(possibleThread);
    if (
      !isNaN(threadNum) &&
      possibleThread.length > 0 &&
      !possibleThread.startsWith('-')
    ) {
      return {
        chatId: stripped.slice(0, colonIdx),
        threadId: threadNum,
      };
    }
  }
  return { chatId: stripped };
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      const jid = buildJid({
        chat: ctx.chat,
        message: ctx.message as any,
      });

      ctx.reply(`Chat ID: \`${jid}\`\nName: ${chatName}\nType: ${chatType}`, {
        parse_mode: 'Markdown',
      });
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Clear session — next message starts a fresh conversation
    this.bot.command('clear', (ctx) => {
      const jid = buildJid({ chat: ctx.chat, message: ctx.message as any });
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }
      this.opts.onClearSession?.(jid);
      ctx.reply('Session cleared. Next message starts a fresh conversation.');
    });

    // Stop active container for this chat
    this.bot.command('stop', (ctx) => {
      const jid = buildJid({ chat: ctx.chat, message: ctx.message as any });
      const group = this.opts.registeredGroups()[jid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }
      this.opts.onStopContainer?.(jid);
      ctx.reply('Container stopped.');
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = buildJid({ chat: ctx.chat, message: ctx.message as any });
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Auto-register forum topics when parent group is registered
      let group: RegisteredGroup | undefined =
        this.opts.registeredGroups()[chatJid];
      if (!group) {
        group = this.tryAutoRegisterTopic(chatJid, ctx.message as any);
      }

      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      // React with 👀 to indicate the bot has seen the message
      this.reactSeen(ctx.chat.id, ctx.message.message_id);

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = buildJid({ chat: ctx.chat, message: ctx.message });
      let group: RegisteredGroup | undefined =
        this.opts.registeredGroups()[chatJid];
      if (!group) {
        group = this.tryAutoRegisterTopic(chatJid, ctx.message);
      }
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId } = parseJid(jid);
      const extra = threadId ? { message_thread_id: threadId } : undefined;

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(chatId, text, extra);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            chatId,
            text.slice(i, i + MAX_LENGTH),
            extra,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  /**
   * If the JID contains a thread_id and the parent group is registered,
   * auto-register this topic as an independent group.
   */
  private tryAutoRegisterTopic(
    chatJid: string,
    message?: {
      reply_to_message?: { forum_topic_created?: { name?: string } };
      message_thread_id?: number;
    },
  ): RegisteredGroup | undefined {
    const { chatId, threadId } = parseJid(chatJid);
    if (!threadId) return undefined;
    if (!this.opts.onRegisterGroup) return undefined;

    const parentJid = `tg:${chatId}`;
    const groups = this.opts.registeredGroups();
    const parentGroup = groups[parentJid];
    if (!parentGroup) return undefined;

    // Derive topic name from forum_topic_created or fallback
    const topicName =
      message?.reply_to_message?.forum_topic_created?.name ||
      `Topic ${threadId}`;

    const group: RegisteredGroup = {
      name: topicName,
      folder: `${parentGroup.folder}-topic-${threadId}`,
      trigger: parentGroup.trigger,
      added_at: new Date().toISOString(),
      requiresTrigger: parentGroup.requiresTrigger,
    };

    this.opts.onRegisterGroup(chatJid, group);
    logger.info(
      { chatJid, topicName, parentJid },
      'Auto-registered forum topic',
    );
    return group;
  }

  /** Add 👀 reaction to indicate the bot has seen a message. */
  private reactSeen(chatId: number, messageId: number): void {
    if (!this.bot) return;
    this.bot.api
      .setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '👀' }])
      .catch((err) => {
        logger.debug({ chatId, messageId, err }, 'Failed to set seen reaction');
      });
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const { chatId, threadId } = parseJid(jid);
      const extra = threadId ? { message_thread_id: threadId } : undefined;
      await this.bot.api.sendChatAction(chatId, 'typing', extra);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

// Self-register with the channel registry
registerChannel('telegram', (opts) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return new TelegramChannel(token, {
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    registeredGroups: opts.registeredGroups,
    onRegisterGroup: opts.onRegisterGroup,
    onClearSession: opts.onClearSession,
    onStopContainer: opts.onStopContainer,
  });
});
