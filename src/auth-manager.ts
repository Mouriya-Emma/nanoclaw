import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const AUTH_FILE = path.join(DATA_DIR, 'pi-auth.json');

export interface AuthCredentials {
  [provider: string]: Record<string, unknown>;
}

export type OAuthCallbacks = {
  onUrl: (url: string, instructions?: string) => void;
  onMessage: (msg: string) => void;
  onPromptCode: () => Promise<string>;
};

const PROVIDERS = [
  'anthropic',
  'openai-codex',
  'google-gemini-cli',
  'google-antigravity',
  'github-copilot',
] as const;

export type ProviderId = (typeof PROVIDERS)[number];

export function readAuthCredentials(): AuthCredentials {
  if (!fs.existsSync(AUTH_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeAuthCredentials(creds: AuthCredentials): void {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(creds, null, 2));
}

export function getAuthStatus(): Array<{ provider: string; authenticated: boolean }> {
  const creds = readAuthCredentials();
  return PROVIDERS.map(p => ({ provider: p, authenticated: !!creds[p] }));
}

export function revokeAuth(provider: string): boolean {
  const creds = readAuthCredentials();
  if (!creds[provider]) return false;
  delete creds[provider];
  writeAuthCredentials(creds);
  return true;
}

export function isValidProvider(provider: string): provider is ProviderId {
  return (PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Start an OAuth login flow for a provider.
 *
 * Each provider has a different API shape. The callbacks abstract
 * Telegram interaction:
 * - onUrl: show the user an auth URL
 * - onMessage: send progress/instruction messages
 * - onPromptCode: wait for the user to paste back a code/URL
 */
export async function startOAuthFlow(
  provider: ProviderId,
  callbacks: OAuthCallbacks,
): Promise<void> {
  const piAi = await import('@mariozechner/pi-ai');

  let credentials: Record<string, unknown>;

  switch (provider) {
    case 'anthropic': {
      // Simple flow: onAuthUrl + onPromptCode (returns "code#state")
      credentials = await piAi.loginAnthropic(
        (url: string) => callbacks.onUrl(url),
        () => callbacks.onPromptCode(),
      );
      break;
    }

    case 'google-gemini-cli': {
      // Local server on :8085 + manual fallback
      credentials = await piAi.loginGeminiCli(
        (info: { url: string; instructions?: string }) =>
          callbacks.onUrl(info.url, info.instructions),
        (msg: string) => callbacks.onMessage(msg),
        () => callbacks.onPromptCode(),
      );
      break;
    }

    case 'openai-codex': {
      // Local server on :1455 + prompt fallback
      credentials = await piAi.loginOpenAICodex({
        onAuth: (info: { url: string; instructions?: string }) =>
          callbacks.onUrl(info.url, info.instructions),
        onPrompt: async (prompt: { message: string }) => {
          callbacks.onMessage(prompt.message);
          return callbacks.onPromptCode();
        },
        onProgress: (msg: string) => callbacks.onMessage(msg),
        onManualCodeInput: () => callbacks.onPromptCode(),
      });
      break;
    }

    case 'google-antigravity': {
      // Local server on :51121 + manual fallback
      credentials = await piAi.loginAntigravity(
        (info: { url: string; instructions?: string }) =>
          callbacks.onUrl(info.url, info.instructions),
        (msg: string) => callbacks.onMessage(msg),
        () => callbacks.onPromptCode(),
      );
      break;
    }

    case 'github-copilot': {
      // Device code flow — no local server
      credentials = await piAi.loginGitHubCopilot({
        onAuth: (url: string, instructions?: string) =>
          callbacks.onUrl(url, instructions),
        onPrompt: async (prompt: { message: string; allowEmpty?: boolean }) => {
          if (prompt.allowEmpty) {
            // GitHub Enterprise domain prompt — default to empty (github.com)
            callbacks.onMessage(`${prompt.message} (send empty for github.com)`);
            return '';
          }
          callbacks.onMessage(prompt.message);
          return callbacks.onPromptCode();
        },
        onProgress: (msg: string) => callbacks.onMessage(msg),
      });
      break;
    }
  }

  // Persist credentials
  const allCreds = readAuthCredentials();
  allCreds[provider] = credentials;
  writeAuthCredentials(allCreds);
  logger.info({ provider }, 'OAuth credentials saved');
}
