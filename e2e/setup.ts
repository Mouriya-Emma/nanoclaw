import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readEnvFile } from '../src/env.js';

const env = readEnvFile([
  'E2E_TELEGRAM_API_ID',
  'E2E_TELEGRAM_API_HASH',
  'E2E_TELEGRAM_SESSION',
  'E2E_TELEGRAM_CHAT_ID',
  'E2E_BOT_USER_ID',
]);

function required(key: string): string {
  const val = process.env[key] || env[key];
  if (!val) throw new Error(`Missing env var: ${key}. Run "npm run e2e:auth" first.`);
  return val;
}

export const E2E_CONFIG = {
  apiId: () => parseInt(required('E2E_TELEGRAM_API_ID'), 10),
  apiHash: () => required('E2E_TELEGRAM_API_HASH'),
  session: () => required('E2E_TELEGRAM_SESSION'),
  chatId: () => BigInt(required('E2E_TELEGRAM_CHAT_ID')),
  botUserId: () => BigInt(required('E2E_BOT_USER_ID')),
};

let client: TelegramClient | null = null;

export async function getClient(): Promise<TelegramClient> {
  if (client?.connected) return client;

  client = new TelegramClient(
    new StringSession(E2E_CONFIG.session()),
    E2E_CONFIG.apiId(),
    E2E_CONFIG.apiHash(),
    { connectionRetries: 5 },
  );

  await client.connect();
  return client;
}

export async function disconnectClient(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
  }
}
