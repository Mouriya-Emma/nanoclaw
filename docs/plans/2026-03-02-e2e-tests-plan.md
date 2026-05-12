# E2E Tests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement end-to-end tests that run against a live NanoClaw instance via Telegram User API, covering all bot commands and core message flow.

**Architecture:** gramjs MTProto client sends messages as a real Telegram user to a group where NanoClaw bot is active. Event-based reply detection filters by bot user ID. Vitest with separate config handles long timeouts and sequential execution.

**Tech Stack:** vitest, telegram (gramjs), tsx

---

### Task 1: Install dependency and add scripts

**Files:**
- Modify: `package.json`

**Step 1: Install gramjs**

Run: `bun add -d telegram`

**Step 2: Add e2e scripts to package.json**

Add to `"scripts"`:
```json
"test:e2e": "vitest run --config e2e/vitest.config.ts",
"e2e:auth": "tsx e2e/auth.ts"
```

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add telegram (gramjs) dep and e2e scripts"
```

---

### Task 2: Create vitest config for E2E

**Files:**
- Create: `e2e/vitest.config.ts`

**Step 1: Write the config**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
```

Key decisions:
- 120s test timeout (agent responses can take a while)
- Sequential execution (messages must not interleave)
- Single fork (shared gramjs client connection)

**Step 2: Commit**

```bash
git add e2e/vitest.config.ts
git commit -m "chore: add vitest config for e2e tests"
```

---

### Task 3: Create auth script for first-time session generation

**Files:**
- Create: `e2e/auth.ts`

This is a one-time interactive script. The user runs it manually, enters phone + code, and gets a StringSession to paste into `.env`.

**Step 1: Write the auth script**

```typescript
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
```

**Step 2: Run it to verify it works**

Run: `npm run e2e:auth`
Expected: prompts for phone, code, outputs session string.
Save the output values to `.env`.

**Step 3: Commit**

```bash
git add e2e/auth.ts
git commit -m "feat(e2e): add auth script for gramjs session generation"
```

---

### Task 4: Create setup and helpers

**Files:**
- Create: `e2e/setup.ts`
- Create: `e2e/helpers.ts`

**Step 1: Write setup.ts — gramjs client lifecycle**

```typescript
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
```

**Step 2: Write helpers.ts — send/receive utilities**

```typescript
import { Api } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { E2E_CONFIG, getClient } from './setup.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send a text message to the test group. */
export async function send(text: string): Promise<void> {
  const client = await getClient();
  await client.sendMessage(E2E_CONFIG.chatId(), { message: text });
}

/**
 * Send a message and wait for the bot to reply.
 * Uses event handler — no polling.
 */
export async function sendAndExpectReply(
  text: string,
  opts?: { timeout?: number; match?: string | RegExp },
): Promise<string> {
  const client = await getClient();
  const timeout = opts?.timeout ?? 60_000;
  const chatId = E2E_CONFIG.chatId();
  const botUserId = E2E_CONFIG.botUserId();

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeEventHandler(handler, event);
      reject(new Error(`Timed out waiting for bot reply after ${timeout}ms. Sent: "${text}"`));
    }, timeout);

    const event = new NewMessage({ chats: [chatId], fromUsers: [botUserId] });

    const handler = (evt: NewMessageEvent) => {
      const msg = evt.message.text || '';
      if (opts?.match) {
        const matches =
          typeof opts.match === 'string' ? msg.includes(opts.match) : opts.match.test(msg);
        if (!matches) return; // keep waiting
      }
      clearTimeout(timer);
      client.removeEventHandler(handler, event);
      resolve(msg);
    };

    client.addEventHandler(handler, event);

    // Send the message after handler is attached
    client.sendMessage(chatId, { message: text }).catch((err) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, event);
      reject(err);
    });
  });
}

/**
 * Send a message and assert no bot reply within the wait period.
 */
export async function sendAndExpectNoReply(
  text: string,
  opts?: { wait?: number },
): Promise<void> {
  const client = await getClient();
  const wait = opts?.wait ?? 15_000;
  const chatId = E2E_CONFIG.chatId();
  const botUserId = E2E_CONFIG.botUserId();

  let gotReply = false;
  let replyText = '';

  const event = new NewMessage({ chats: [chatId], fromUsers: [botUserId] });
  const handler = (evt: NewMessageEvent) => {
    gotReply = true;
    replyText = evt.message.text || '';
  };

  client.addEventHandler(handler, event);
  await client.sendMessage(chatId, { message: text });
  await sleep(wait);
  client.removeEventHandler(handler, event);

  if (gotReply) {
    throw new Error(`Expected no reply but got: "${replyText}"`);
  }
}

/**
 * Wait for the next bot reply (without sending a message).
 * Use after a command that triggers a delayed or follow-up response.
 */
export async function waitForReply(
  opts?: { timeout?: number; match?: string | RegExp },
): Promise<string> {
  const client = await getClient();
  const timeout = opts?.timeout ?? 60_000;
  const chatId = E2E_CONFIG.chatId();
  const botUserId = E2E_CONFIG.botUserId();

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeEventHandler(handler, event);
      reject(new Error(`Timed out waiting for bot reply after ${timeout}ms`));
    }, timeout);

    const event = new NewMessage({ chats: [chatId], fromUsers: [botUserId] });

    const handler = (evt: NewMessageEvent) => {
      const msg = evt.message.text || '';
      if (opts?.match) {
        const matches =
          typeof opts.match === 'string' ? msg.includes(opts.match) : opts.match.test(msg);
        if (!matches) return;
      }
      clearTimeout(timer);
      client.removeEventHandler(handler, event);
      resolve(msg);
    };

    client.addEventHandler(handler, event);
  });
}

/** Delay between test cases to avoid message interleaving. */
export async function interTestDelay(): Promise<void> {
  await sleep(2000);
}
```

**Step 3: Commit**

```bash
git add e2e/setup.ts e2e/helpers.ts
git commit -m "feat(e2e): add gramjs client setup and test helpers"
```

---

### Task 5: Write commands.test.ts

**Files:**
- Create: `e2e/commands.test.ts`

**Step 1: Write the test file**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendAndExpectReply, interTestDelay } from './helpers.js';
import { getClient, disconnectClient } from './setup.js';

beforeAll(async () => { await getClient(); });
afterAll(async () => { await disconnectClient(); });

describe('Telegram commands', () => {
  afterEach(async () => { await interTestDelay(); });

  it('/ping responds with online status', async () => {
    const reply = await sendAndExpectReply('/ping', { timeout: 10_000 });
    expect(reply).toContain('is online');
  });

  it('/chatid returns chat info', async () => {
    const reply = await sendAndExpectReply('/chatid', { timeout: 10_000 });
    expect(reply).toContain('Chat ID:');
    expect(reply).toContain('tg:');
  });

  it('/clear confirms session cleared', async () => {
    const reply = await sendAndExpectReply('/clear', { timeout: 10_000 });
    expect(reply).toContain('Session cleared');
  });

  it('/stop confirms container stopped', async () => {
    const reply = await sendAndExpectReply('/stop', { timeout: 10_000 });
    expect(reply).toContain('Container stopped');
  });

  it('/cla switches to Claude Agent SDK', async () => {
    const reply = await sendAndExpectReply('/cla', { timeout: 10_000 });
    expect(reply).toContain('Switched to Claude Agent SDK');
  });

  it('/pi with invalid provider returns error', async () => {
    const reply = await sendAndExpectReply('/pi invalid_xxx', { timeout: 10_000 });
    expect(reply).toContain('Unknown pi-mono provider');
  });

  it('/pi with valid provider switches runtime', async () => {
    const reply = await sendAndExpectReply('/pi anthropic', { timeout: 10_000 });
    expect(reply).toContain('Switched to pi-mono/anthropic');
  });

  it('/model with no args shows info', async () => {
    const reply = await sendAndExpectReply('/model', { timeout: 10_000 });
    expect(reply.toLowerCase()).toMatch(/select a model|default model|uses the default/);
  });

  it('/ask with no args shows usage', async () => {
    const reply = await sendAndExpectReply('/ask', { timeout: 10_000 });
    expect(reply).toContain('Usage: /ask');
  });

  it('/ask with invalid provider returns error', async () => {
    const reply = await sendAndExpectReply('/ask invalid_xxx hello', { timeout: 10_000 });
    expect(reply).toContain('Unknown provider');
  });

  it('/pi_login with no args shows provider list', async () => {
    const reply = await sendAndExpectReply('/pi_login', { timeout: 10_000 });
    expect(reply.toLowerCase()).toContain('select a provider');
  });

  it('/requirements shows tool requirements', async () => {
    const reply = await sendAndExpectReply('/requirements', { timeout: 10_000 });
    expect(reply).toMatch(/No tool requirements|Tool requirements:/);
  });
});
```

Note: import `afterEach` too — add it to the import line.

**Step 2: Run a smoke test (just /ping)**

Run: `npm run test:e2e -- --testNamePattern "/ping"`
Expected: PASS — bot responds with "is online"

**Step 3: Run the full commands suite**

Run: `npm run test:e2e -- e2e/commands.test.ts`
Expected: all tests pass

**Step 4: Commit**

```bash
git add e2e/commands.test.ts
git commit -m "feat(e2e): add command tests for all Telegram bot commands"
```

---

### Task 6: Write message-flow.test.ts

**Files:**
- Create: `e2e/message-flow.test.ts`

The ASSISTANT_NAME is read from `.env` (currently `riri`). Tests use the trigger pattern `@riri`.

**Step 1: Write the test file**

```typescript
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import {
  sendAndExpectReply,
  sendAndExpectNoReply,
  waitForReply,
  interTestDelay,
} from './helpers.js';
import { getClient, disconnectClient } from './setup.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

beforeAll(async () => { await getClient(); });
afterAll(async () => { await disconnectClient(); });

describe('Message flow', () => {
  afterEach(async () => { await interTestDelay(); });

  it('trigger message gets agent reply', async () => {
    const marker = `e2e-ok-${Date.now()}`;
    const reply = await sendAndExpectReply(
      `${TRIGGER} reply with exactly "${marker}" and nothing else`,
      { timeout: 120_000, match: marker },
    );
    expect(reply).toContain(marker);
  });

  it('message without trigger gets no reply', async () => {
    const marker = `e2e-silent-${Date.now()}`;
    await sendAndExpectNoReply(marker, { wait: 15_000 });
  });

  it('/ask executes with specific provider', async () => {
    const marker = `e2e-ask-${Date.now()}`;
    const reply = await sendAndExpectReply(
      `/ask anthropic reply with exactly "${marker}" and nothing else`,
      { timeout: 120_000, match: marker },
    );
    expect(reply).toContain(marker);
  });

  it('/cla switch then trigger message works', async () => {
    // Switch to Claude SDK first
    const switchReply = await sendAndExpectReply('/cla', { timeout: 10_000 });
    expect(switchReply).toContain('Switched to Claude Agent SDK');

    await interTestDelay();

    // Now send a trigger message
    const marker = `e2e-cla-${Date.now()}`;
    const reply = await sendAndExpectReply(
      `${TRIGGER} reply with exactly "${marker}" and nothing else`,
      { timeout: 120_000, match: marker },
    );
    expect(reply).toContain(marker);
  });
});
```

**Step 2: Run the trigger test first (slowest)**

Run: `npm run test:e2e -- --testNamePattern "trigger message"`
Expected: PASS — bot processes the trigger and replies with the marker

**Step 3: Run full message-flow suite**

Run: `npm run test:e2e -- e2e/message-flow.test.ts`
Expected: all tests pass (the "no reply" test takes ~15s)

**Step 4: Commit**

```bash
git add e2e/message-flow.test.ts
git commit -m "feat(e2e): add message flow tests for trigger, /ask, and /cla"
```

---

### Task 7: Run full E2E suite and fix issues

**Step 1: Run the complete suite**

Run: `npm run test:e2e`
Expected: all tests in commands.test.ts and message-flow.test.ts pass

**Step 2: Fix any failures**

Common issues to watch for:
- gramjs `NewMessage` event filter not matching — check `chatId` type (bigint vs number)
- Bot commands not reaching NanoClaw — verify the test group is registered
- Timeout on agent tests — increase timeout or check NanoClaw is running

**Step 3: Final commit**

```bash
git add -A
git commit -m "fix(e2e): resolve any issues from full suite run"
```
