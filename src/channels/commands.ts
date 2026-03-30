import { ASSISTANT_NAME, PI_PROVIDERS } from '../config.js';
import {
  getLastPiPreference,
  getToolRequirements,
  setLastPiPreference,
} from '../db.js';
import { RegisteredGroup } from '../types.js';
import { ChannelOpts } from './registry.js';

// --- Types ---

export interface CommandContext {
  chatJid: string;
  userId: string;
  senderName: string;
  channelName: string;
  timestamp: string;
  messageId: string;
  group: RegisteredGroup | null;
  opts: ChannelOpts;
}

export interface CommandResult {
  text: string;
  choices?: { label: string; value: string }[];
  choicePrompt?: string;
}

// --- Shared command dispatcher ---

export async function handleSharedCommand(
  cmd: string,
  args: string,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  switch (cmd) {
    case '/ping':
      return { text: `${ASSISTANT_NAME} is online.` };

    case '/clear':
      return handleClear(ctx);

    case '/stop':
      return handleStop(ctx);

    case '/cla':
      return handleCla(ctx);

    case '/ask':
      return handleAsk(args, ctx);

    case '/requirements':
      return handleRequirements();

    case '/pi':
      return handlePi(args, ctx);

    case '/model':
      return await handleModel(args, ctx);

    default:
      return null;
  }
}

// --- Command implementations ---

function requireGroup(ctx: CommandContext): CommandResult | null {
  if (!ctx.group) return { text: 'This chat is not registered.' };
  return null;
}

function handleClear(ctx: CommandContext): CommandResult {
  const err = requireGroup(ctx);
  if (err) return err;
  ctx.opts.onClearSession?.(ctx.chatJid);
  return { text: 'Session cleared. Next message starts a fresh conversation.' };
}

function handleStop(ctx: CommandContext): CommandResult {
  const err = requireGroup(ctx);
  if (err) return err;
  ctx.opts.onStopContainer?.(ctx.chatJid);
  return { text: 'Container stopped.' };
}

function handleCla(ctx: CommandContext): CommandResult {
  const err = requireGroup(ctx);
  if (err) return err;

  // Save current pi preference before switching away
  const current = ctx.opts.onGetModel?.(ctx.chatJid);
  if (current && current.provider !== 'claude') {
    setLastPiPreference(ctx.group!.folder, current.provider, current.modelId);
  }
  ctx.opts.onSetModel?.(ctx.chatJid, 'claude');
  ctx.opts.onClearSession?.(ctx.chatJid);
  return { text: 'Switched to Claude Agent SDK. Session cleared.' };
}

function handleAsk(args: string, ctx: CommandContext): CommandResult | null {
  const err = requireGroup(ctx);
  if (err) return err;

  if (!args) {
    return {
      text: 'Usage: /ask <provider> <message>\nExample: /ask gemini What is the weather?',
    };
  }

  const spaceIdx = args.indexOf(' ');
  if (spaceIdx === -1) {
    return { text: 'Usage: /ask <provider> <message>' };
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
    return {
      text: `Unknown provider: ${providerArg}\nValid: claude, anthropic, gemini, google, openai, codex, copilot, github-copilot, google-antigravity`,
    };
  }

  ctx.opts.onChatMetadata(ctx.chatJid, ctx.timestamp);
  ctx.opts.onMessage(ctx.chatJid, {
    id: ctx.messageId,
    chat_jid: ctx.chatJid,
    sender: ctx.userId,
    sender_name: ctx.senderName,
    content: `__ASK_${resolvedProvider.toUpperCase()}__ ${message}`,
    timestamp: ctx.timestamp,
    is_from_me: false,
  });

  // Return null — message was injected, no text reply needed
  return null;
}

function handleRequirements(): CommandResult {
  const reqs = getToolRequirements();
  if (reqs.length === 0) {
    return { text: 'No tool requirements recorded.' };
  }

  const lines = reqs.map((r) => {
    const auth = r.needs_auth
      ? ` [needs auth: ${r.auth_provider || 'unknown'}]`
      : '';
    return `• ${r.tool_name} (${r.group_folder})${auth}\n  ${r.reason || 'No reason given'}`;
  });

  return { text: `Tool requirements:\n\n${lines.join('\n\n')}` };
}

async function handlePi(args: string, ctx: CommandContext): Promise<CommandResult> {
  const err = requireGroup(ctx);
  if (err) return err;

  const provider = args.trim().toLowerCase();

  if (provider) {
    if (!(PI_PROVIDERS as readonly string[]).includes(provider)) {
      return {
        text: `Unknown pi-mono provider: ${provider}\nValid: ${PI_PROVIDERS.join(', ')}`,
      };
    }
    return switchToPiProvider(ctx.chatJid, provider, ctx.group!, ctx.opts);
  }

  // No arg — return choices
  const { getAuthStatus } = await import('../auth-manager.js');
  const authed = getAuthStatus().filter((s) => s.authenticated);
  if (authed.length === 0) {
    return {
      text: 'No authenticated pi-mono provider. Use /pi_login <provider> first.',
    };
  }

  const current = ctx.opts.onGetModel?.(ctx.chatJid) || { provider: 'claude' };
  const choices = authed.map((s) => ({
    label: s.provider === current.provider ? `✓ ${s.provider}` : s.provider,
    value: `pi:${s.provider}`,
  }));

  return {
    text: 'Select a pi-mono provider:',
    choicePrompt: 'Select a pi-mono provider:',
    choices,
  };
}

async function handleModel(
  args: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const err = requireGroup(ctx);
  if (err) return err;

  const current = ctx.opts.onGetModel?.(ctx.chatJid) || { provider: 'claude' };

  const modelId = args.trim();
  if (modelId) {
    return switchModel(ctx.chatJid, modelId, ctx.group!, ctx.opts);
  }

  // No arg — show model choices for current provider
  if (current.provider === 'claude') {
    return {
      text: 'Claude Agent SDK uses the default model. Use /pi to switch to pi-mono first.',
    };
  }

  try {
    const piAi = await import('@mariozechner/pi-ai');
    const models = piAi.getModels(current.provider as any);
    const choices = (models as any[]).map((m: any) => ({
      label: m.id === current.modelId ? `✓ ${m.id}` : m.id,
      value: `model:${m.id}`,
    }));
    return {
      text: `Provider: ${current.provider}`,
      choicePrompt: `Provider: ${current.provider}\nSelect a model:`,
      choices,
    };
  } catch {
    return { text: `Could not load models for ${current.provider}.` };
  }
}

// --- Exported helpers for callback handlers ---

export function switchToPiProvider(
  jid: string,
  provider: string,
  group: RegisteredGroup,
  opts: ChannelOpts,
): CommandResult {
  const lastPi = getLastPiPreference(group.folder);
  const restoredModelId =
    lastPi?.provider === provider ? lastPi.modelId : undefined;
  setLastPiPreference(group.folder, provider, restoredModelId);
  opts.onSetModel?.(jid, provider, restoredModelId);
  opts.onClearSession?.(jid);
  const modelSuffix = restoredModelId ? ` (model: ${restoredModelId})` : '';
  return { text: `Switched to pi-mono/${provider}${modelSuffix}. Session cleared.` };
}

export function switchModel(
  jid: string,
  modelId: string,
  group: RegisteredGroup,
  opts: ChannelOpts,
): CommandResult {
  const current = opts.onGetModel?.(jid) || { provider: 'claude' };
  opts.onSetModel?.(jid, current.provider, modelId);
  if (current.provider !== 'claude') {
    setLastPiPreference(group.folder, current.provider, modelId);
  }
  return {
    text: `Model set to ${modelId} (provider: ${current.provider}).`,
  };
}
