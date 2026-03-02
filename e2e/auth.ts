import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

async function main() {
  const apiId = parseInt(await ask('API ID: '), 10);
  const apiHash = await ask('API Hash: ');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => ask('Phone number: '),
    password: () => ask('2FA password (if any): '),
    phoneCode: () => ask('Verification code: '),
    onError: (err) => console.error(err),
  });

  const session = client.session.save() as unknown as string;
  console.log('\n--- Copy this into your .env ---');
  console.log(`E2E_TELEGRAM_API_ID=${apiId}`);
  console.log(`E2E_TELEGRAM_API_HASH=${apiHash}`);
  console.log(`E2E_TELEGRAM_SESSION=${session}`);
  console.log('--- Done ---\n');

  await client.disconnect();
  rl.close();
}

main().catch(console.error);
