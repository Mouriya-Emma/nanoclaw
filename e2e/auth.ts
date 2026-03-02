/**
 * Generate a gramjs StringSession for E2E tests.
 * Uses Telegram Desktop's public API credentials (from open-source repo).
 * Run: npm run e2e:auth
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';

const API_ID = 2040;
const API_HASH = 'b18441a1ff607e10a989891a5462e627';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

async function main() {
  console.log('Using Telegram Desktop public API credentials');
  console.log(`API ID: ${API_ID}\n`);

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
    useWSS: true,
  });

  await client.start({
    phoneNumber: () => ask('Phone number: '),
    password: () => ask('2FA password (if any): '),
    phoneCode: () => ask('Verification code: '),
    onError: (err) => console.error(err),
  });

  const session = client.session.save() as unknown as string;
  console.log('\n--- Copy this into your .env ---');
  console.log(`E2E_TELEGRAM_SESSION=${session}`);
  console.log('--- Done ---\n');

  await client.disconnect();
  rl.close();
}

main().catch(console.error);
