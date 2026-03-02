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
