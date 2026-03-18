import { Bot, InlineKeyboard } from 'grammy';

import {
  getAuthStatus,
  isValidProvider,
  revokeAuth,
  startOAuthFlow,
} from '../auth-manager.js';
import { ASSISTANT_NAME, PI_PROVIDERS, TRIGGER_PATTERN } from '../config.js';
import { getLastPiPreference, setLastPiPreference } from '../db.js';
import { getToolRequirements } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  ModelPreference,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
  onClearSession?: (jid: string) => void;
  onStopContainer?: (jid: string) => void;
  onSetModel?: (jid: string, provider: string, modelId?: string) => void;
  onGetModel?: (jid: string) => ModelPreference;
}

/** Build JID from a Telegram context, including thread_id for forum topics. */
export function buildJid(ctx: {
  chat: { id: number; type: string };
  message?: { message_thread_id?: number; is_topic_message?: boolean };
}): string {
  const chatId = ctx.chat.id;
  const threadId = ctx.message?.message_thread_id;
  // Only append thread_id for supergroup forum topics
  if (threadId && ctx.message?.is_topic_message && ctx.chat.type === 'supergroup') {
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
    if (!isNaN(threadNum) && possibleThread.length > 0 && !possibleThread.startsWith('-')) {
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
  /** Pending OAuth code input resolvers keyed by chat ID */
  private pendingAuthResolve = new Map<number, (code: string) => void>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Resolve a group for a command context.
   * Falls back to parent group for unregistered forum topics.
   */
  private resolveGroup(ctx: any): { jid: string; group: RegisteredGroup } | null {
    const jid = buildJid({ chat: ctx.chat, message: ctx.message });
    const groups = this.opts.registeredGroups();
    const group = groups[jid];
    if (group) return { jid, group };

    // Try auto-register topic
    const autoGroup = this.tryAutoRegisterTopic(jid, ctx.message);
    if (autoGroup) return { jid, group: autoGroup };

    // Fallback: use parent group for forum topics
    const { chatId, threadId } = parseJid(jid);
    if (threadId) {
      const parentJid = `tg:${chatId}`;
      const parentGroup = groups[parentJid];
      if (parentGroup) return { jid: parentJid, group: parentGroup };
    }

    return null;
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

      ctx.reply(
        `Chat ID: \`${jid}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Clear session — next message starts a fresh conversation
    this.bot.command('clear', (ctx) => {
      const resolved = this.resolveGroup(ctx);
      if (!resolved) { ctx.reply('This chat is not registered.'); return; }
      this.opts.onClearSession?.(resolved.jid);
      ctx.reply('Session cleared. Next message starts a fresh conversation.');
    });

    // Stop active container for this chat
    this.bot.command('stop', (ctx) => {
      const resolved = this.resolveGroup(ctx);
      if (!resolved) { ctx.reply('This chat is not registered.'); return; }
      this.opts.onStopContainer?.(resolved.jid);
      ctx.reply('Container stopped.');
    });

    // Switch model within current provider (does NOT change runtime or clear session)
    this.bot.command('model', async (ctx) => {
      const resolved = this.resolveGroup(ctx);
      if (!resolved) { ctx.reply('This chat is not registered.'); return; }
      const { jid } = resolved;

      const current = this.opts.onGetModel?.(jid) || { provider: 'claude' };
      const modelId = ctx.match?.trim();
      if (!modelId) {
        // Show model buttons for current provider
        if (current.provider === 'claude') {
          ctx.reply('Claude Agent SDK uses the default model. Use /pi to switch to pi-mono first.');
          return;
        }
        try {
          const piAi = await import('@mariozechner/pi-ai');
          const models = piAi.getModels(current.provider as any);
          const kb = new InlineKeyboard();
          for (let i = 0; i < models.length; i++) {
            const m = models[i] as any;
            const label = m.id === current.modelId ? `✓ ${m.id}` : m.id;
            kb.text(label, `model:${m.id}`);
            if ((i + 1) % 2 === 0) kb.row();
          }
          ctx.reply(`Provider: ${current.provider}\nSelect a model:`, { reply_markup: kb });
        } catch {
          ctx.reply(`Could not load models for ${current.provider}.`);
        }
        return;
      }

      this.opts.onSetModel?.(jid, current.provider, modelId);
      // Also update pi preference if current provider is a pi provider
      if (current.provider !== 'claude') {
        const resolved2 = this.resolveGroup(ctx);
        if (resolved2) setLastPiPreference(resolved2.group.folder, current.provider, modelId);
      }
      ctx.reply(`Model set to ${modelId} (provider: ${current.provider}).`);
    });

    // Switch to pi-mono runtime (clears session)
    this.bot.command('pi', (ctx) => {
      const resolved = this.resolveGroup(ctx);
      if (!resolved) { ctx.reply('This chat is not registered.'); return; }
      const { jid, group } = resolved;

      const provider = ctx.match?.trim().toLowerCase();

      if (provider && !(PI_PROVIDERS as readonly string[]).includes(provider)) {
        ctx.reply(`Unknown pi-mono provider: ${provider}\nValid: ${PI_PROVIDERS.join(', ')}`);
        return;
      }

      // No argument: show provider buttons
      if (!provider) {
        const authed = getAuthStatus().filter(s => s.authenticated);
        if (authed.length === 0) {
          ctx.reply(`No authenticated pi-mono provider. Use /pi_login <provider> first.`);
          return;
        }
        const current = this.opts.onGetModel?.(jid) || { provider: 'claude' };
        const kb = new InlineKeyboard();
        for (const s of authed) {
          const label = s.provider === current.provider ? `✓ ${s.provider}` : s.provider;
          kb.text(label, `pi:${s.provider}`).row();
        }
        ctx.reply('Select a pi-mono provider:', { reply_markup: kb });
        return;
      }

      // Restore saved modelId if switching back to the same provider
      const lastPi = getLastPiPreference(group.folder);
      const restoredModelId = lastPi?.provider === provider ? lastPi.modelId : undefined;
      setLastPiPreference(group.folder, provider, restoredModelId);
      this.opts.onSetModel?.(jid, provider, restoredModelId);
      this.opts.onClearSession?.(jid);
      const modelSuffix = restoredModelId ? ` (model: ${restoredModelId})` : '';
      ctx.reply(`Switched to pi-mono/${provider}${modelSuffix}. Session cleared.`);
    });

    // Switch to Claude Agent SDK runtime (clears session)
    this.bot.command('cla', (ctx) => {
      const resolved = this.resolveGroup(ctx);
      if (!resolved) { ctx.reply('This chat is not registered.'); return; }
      // Save current pi preference before switching away
      const current = this.opts.onGetModel?.(resolved.jid);
      if (current && current.provider !== 'claude') {
        setLastPiPreference(resolved.group.folder, current.provider, current.modelId);
      }
      this.opts.onSetModel?.(resolved.jid, 'claude');
      this.opts.onClearSession?.(resolved.jid);
      ctx.reply('Switched to Claude Agent SDK. Session cleared.');
    });

    // One-shot query with a specific provider
    this.bot.command('ask', (ctx) => {
      const resolved = this.resolveGroup(ctx);
      if (!resolved) { ctx.reply('This chat is not registered.'); return; }
      const { jid } = resolved;

      const args = ctx.match?.trim();
      if (!args) {
        ctx.reply('Usage: /ask <provider> <message>\nExample: /ask gemini What is the weather?');
        return;
      }

      const spaceIdx = args.indexOf(' ');
      if (spaceIdx === -1) {
        ctx.reply('Usage: /ask <provider> <message>');
        return;
      }

      const providerArg = args.slice(0, spaceIdx).toLowerCase();
      const message = args.slice(spaceIdx + 1);

      const providerMap: Record<string, string> = {
        gemini: 'google',
        gpt: 'openai',
        codex: 'openai',
        copilot: 'github-copilot',
        claude: 'claude',
        google: 'google',
        openai: 'openai',
        anthropic: 'anthropic',
        'github-copilot': 'github-copilot',
        'google-antigravity': 'google-antigravity',
      };

      const resolvedProvider = providerMap[providerArg];
      if (!resolvedProvider) {
        ctx.reply(`Unknown provider: ${providerArg}\nValid: claude, anthropic, gemini, google, openai, codex, copilot, github-copilot, google-antigravity`);
        return;
      }

      const timestamp = new Date(ctx.message!.date * 1000).toISOString();
      const senderName = ctx.from?.first_name || ctx.from?.username || 'Unknown';
      const sender = ctx.from?.id.toString() || '';

      this.opts.onChatMetadata(jid, timestamp);
      this.opts.onMessage(jid, {
        id: ctx.message!.message_id.toString(),
        chat_jid: jid,
        sender,
        sender_name: senderName,
        content: `__ASK_${resolvedProvider.toUpperCase()}__ ${message}`,
        timestamp,
        is_from_me: false,
      });

      this.reactSeen(ctx.chat.id, ctx.message!.message_id);
    });

    // Pi-mono OAuth login
    this.bot.command('pi_login', async (ctx) => {
      const args = ctx.match?.trim();

      if (!args) {
        const status = getAuthStatus();
        const kb = new InlineKeyboard();
        for (const s of status) {
          const label = s.authenticated ? `✅ ${s.provider}` : `❌ ${s.provider}`;
          kb.text(label, `login:${s.provider}`).row();
        }
        // Add revoke button for authenticated providers
        const authed = status.filter(s => s.authenticated);
        if (authed.length > 0) {
          for (const s of authed) {
            kb.text(`🗑 Revoke ${s.provider}`, `revoke:${s.provider}`).row();
          }
        }
        ctx.reply('Pi-mono OAuth — select a provider to login:', { reply_markup: kb });
        return;
      }

      if (args.startsWith('revoke ')) {
        const provider = args.slice(7).trim();
        const revoked = revokeAuth(provider);
        ctx.reply(revoked ? `Credentials for ${provider} revoked.` : `No credentials found for ${provider}.`);
        return;
      }

      const provider = args.toLowerCase();
      if (!isValidProvider(provider)) {
        const status = getAuthStatus();
        ctx.reply(`Unknown provider: ${provider}\nValid: ${status.map(s => s.provider).join(', ')}`);
        return;
      }

      const chatId = ctx.chat.id;
      if (this.pendingAuthResolve.has(chatId)) {
        ctx.reply('An OAuth flow is already in progress for this chat. Paste the code or wait for it to complete.');
        return;
      }

      ctx.reply(`Starting OAuth for ${provider}...`);

      try {
        await startOAuthFlow(provider, {
          onUrl: (url, instructions) => {
            const msg = instructions
              ? `${instructions}\n\n${url}\n\nPaste the code/URL you receive back here.`
              : `Open this URL to authenticate:\n${url}\n\nPaste the code/URL you receive back here.`;
            ctx.reply(msg);
          },
          onMessage: (msg) => ctx.reply(msg),
          onPromptCode: () => new Promise<string>((resolve) => {
            this.pendingAuthResolve.set(chatId, resolve);
          }),
        });

        ctx.reply(`✅ ${provider} authenticated successfully.`);
      } catch (err) {
        ctx.reply(`❌ OAuth failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.pendingAuthResolve.delete(chatId);
      }
    });

    this.bot.command('requirements', async (ctx) => {
      const reqs = getToolRequirements();
      if (reqs.length === 0) {
        ctx.reply('No tool requirements recorded.');
        return;
      }

      const lines = reqs.map(r => {
        const auth = r.needs_auth ? ` [needs auth: ${r.auth_provider || 'unknown'}]` : '';
        return `• ${r.tool_name} (${r.group_folder})${auth}\n  ${r.reason || 'No reason given'}`;
      });

      ctx.reply(`Tool requirements:\n\n${lines.join('\n\n')}`);
    });

    // Handle inline keyboard callbacks for /pi, /model, /pi_login
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const chatJid = buildJid({ chat: ctx.chat!, message: ctx.callbackQuery.message as any });

      // Resolve group with fallback to parent for forum topics
      const resolveCallbackGroup = (): { jid: string; group: RegisteredGroup } | null => {
        const groups = this.opts.registeredGroups();
        const group = groups[chatJid];
        if (group) return { jid: chatJid, group };
        const { chatId, threadId } = parseJid(chatJid);
        if (threadId) {
          const parentJid = `tg:${chatId}`;
          const parentGroup = groups[parentJid];
          if (parentGroup) return { jid: parentJid, group: parentGroup };
        }
        return null;
      };

      if (data.startsWith('pi:')) {
        const resolved = resolveCallbackGroup();
        if (!resolved) { await ctx.answerCallbackQuery({ text: 'Chat not registered.' }); return; }
        const provider = data.slice(3);
        const lastPi = getLastPiPreference(resolved.group.folder);
        const restoredModelId = lastPi?.provider === provider ? lastPi.modelId : undefined;
        setLastPiPreference(resolved.group.folder, provider, restoredModelId);
        this.opts.onSetModel?.(resolved.jid, provider, restoredModelId);
        this.opts.onClearSession?.(resolved.jid);
        const modelSuffix = restoredModelId ? ` (model: ${restoredModelId})` : '';
        await ctx.editMessageText(`Switched to pi-mono/${provider}${modelSuffix}. Session cleared.`);
        await ctx.answerCallbackQuery();
      } else if (data.startsWith('model:')) {
        const resolved = resolveCallbackGroup();
        if (!resolved) { await ctx.answerCallbackQuery({ text: 'Chat not registered.' }); return; }
        const modelId = data.slice(6);
        const current = this.opts.onGetModel?.(resolved.jid) || { provider: 'claude' };
        this.opts.onSetModel?.(resolved.jid, current.provider, modelId);
        if (current.provider !== 'claude') {
          setLastPiPreference(resolved.group.folder, current.provider, modelId);
        }
        await ctx.editMessageText(`Model set to ${modelId} (provider: ${current.provider}).`);
        await ctx.answerCallbackQuery();
      } else if (data.startsWith('login:')) {
        const provider = data.slice(6);
        if (!isValidProvider(provider)) {
          await ctx.answerCallbackQuery({ text: 'Invalid provider.' });
          return;
        }
        const chatId = ctx.chat!.id;
        if (this.pendingAuthResolve.has(chatId)) {
          await ctx.answerCallbackQuery({ text: 'OAuth already in progress.' });
          return;
        }
        await ctx.editMessageText(`Starting OAuth for ${provider}...`);
        await ctx.answerCallbackQuery();
        try {
          await startOAuthFlow(provider, {
            onUrl: (url, instructions) => {
              const msg = instructions
                ? `${instructions}\n\n${url}\n\nPaste the code/URL you receive back here.`
                : `Open this URL to authenticate:\n${url}\n\nPaste the code/URL you receive back here.`;
              this.bot!.api.sendMessage(chatId, msg);
            },
            onMessage: (msg) => this.bot!.api.sendMessage(chatId, msg),
            onPromptCode: () => new Promise<string>((resolve) => {
              this.pendingAuthResolve.set(chatId, resolve);
            }),
          });
          this.bot!.api.sendMessage(chatId, `✅ ${provider} authenticated successfully.`);
        } catch (err) {
          this.bot!.api.sendMessage(chatId, `❌ OAuth failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.pendingAuthResolve.delete(chatId);
        }
      } else if (data.startsWith('revoke:')) {
        const provider = data.slice(7);
        const revoked = revokeAuth(provider);
        await ctx.editMessageText(revoked ? `Credentials for ${provider} revoked.` : `No credentials found for ${provider}.`);
        await ctx.answerCallbackQuery();
      } else {
        await ctx.answerCallbackQuery();
      }
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      // Intercept messages for pending OAuth code input
      const pendingResolve = this.pendingAuthResolve.get(ctx.chat.id);
      if (pendingResolve) {
        this.pendingAuthResolve.delete(ctx.chat.id);
        pendingResolve(ctx.message.text.trim());
        return;
      }

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
      let group: RegisteredGroup | undefined = this.opts.registeredGroups()[chatJid];
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
      let group: RegisteredGroup | undefined = this.opts.registeredGroups()[chatJid];
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
    this.bot.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
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
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
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
    message?: { reply_to_message?: { forum_topic_created?: { name?: string } }; message_thread_id?: number },
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
    this.bot.api.setMessageReaction(chatId, messageId, [
      { type: 'emoji', emoji: '👀' },
    ]).catch((err) => {
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
