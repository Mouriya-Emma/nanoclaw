import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { readEnvFile } from '../src/env.js';

// Telegram Desktop public API credentials (from open-source repo)
const API_ID = 2040;
const API_HASH = 'b18441a1ff607e10a989891a5462e627';

const env = readEnvFile([
  'E2E_TELEGRAM_SESSION',
  'E2E_CHAT_ID',
  'E2E_THREAD_ID',
  'E2E_BOT_USER_ID',
]);

function required(key: string): string {
  const val = process.env[key] || env[key];
  if (!val) throw new Error(`Missing env var: ${key}. Run "npm run e2e:auth" first.`);
  return val;
}

export const E2E_CONFIG = {
  session: () => required('E2E_TELEGRAM_SESSION'),
  chatId: () => BigInt(required('E2E_CHAT_ID')),
  threadId: () => Number(required('E2E_THREAD_ID')),
  botUserId: () => BigInt(required('E2E_BOT_USER_ID')),
};

let client: TelegramClient | null = null;

export async function getClient(): Promise<TelegramClient> {
  if (client?.connected) return client;

  client = new TelegramClient(
    new StringSession(E2E_CONFIG.session()),
    API_ID,
    API_HASH,
    { connectionRetries: 5, useWSS: true },
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
