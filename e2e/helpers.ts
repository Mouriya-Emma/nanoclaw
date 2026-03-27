import { Api } from 'telegram';
import { NewMessage, NewMessageEvent } from 'telegram/events/index.js';
import { E2E_CONFIG, getClient } from './setup.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEBUG = !!process.env.E2E_DEBUG;
function log(...args: unknown[]) {
  if (DEBUG) console.log(`[e2e ${new Date().toISOString()}]`, ...args);
}

/** Send a text message to the test group topic. */
export async function send(text: string): Promise<void> {
  const client = await getClient();
  await client.sendMessage(E2E_CONFIG.chatId(), {
    message: text,
    replyTo: E2E_CONFIG.threadId(),
  });
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

  // Debug: listen to ALL new messages in this chat to see what's coming
  const debugEvent = new NewMessage({ chats: [chatId] });
  const debugHandler = (evt: NewMessageEvent) => {
    const from = evt.message.senderId;
    const txt = (evt.message.text || '').slice(0, 120);
    log(`[ALL_MSG] from=${from} bot=${from === botUserId} text="${txt}"`);
  };
  client.addEventHandler(debugHandler, debugEvent);

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      log(`[TIMEOUT] No matching reply after ${timeout}ms. Sent: "${text}"`);
      client.removeEventHandler(handler, event);
      client.removeEventHandler(debugHandler, debugEvent);
      reject(new Error(`Timed out waiting for bot reply after ${timeout}ms. Sent: "${text}"`));
    }, timeout);

    const event = new NewMessage({ chats: [chatId], fromUsers: [botUserId] });

    const handler = (evt: NewMessageEvent) => {
      const msg = evt.message.text || '';
      log(`[BOT_MSG] text="${msg.slice(0, 120)}"`);
      if (opts?.match) {
        const matches =
          typeof opts.match === 'string' ? msg.includes(opts.match) : opts.match.test(msg);
        if (!matches) {
          log(`[SKIP] match="${opts.match}" not found in reply`);
          return;
        }
      }
      clearTimeout(timer);
      client.removeEventHandler(handler, event);
      client.removeEventHandler(debugHandler, debugEvent);
      log(`[MATCHED] reply="${msg.slice(0, 120)}"`);
      resolve(msg);
    };

    client.addEventHandler(handler, event);

    log(`[SEND] "${text}" to chat=${chatId} thread=${E2E_CONFIG.threadId()}`);
    client.sendMessage(chatId, {
      message: text,
      replyTo: E2E_CONFIG.threadId(),
    }).catch((err) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, event);
      client.removeEventHandler(debugHandler, debugEvent);
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
  await client.sendMessage(chatId, {
    message: text,
    replyTo: E2E_CONFIG.threadId(),
  });
  await sleep(wait);
  client.removeEventHandler(handler, event);

  if (gotReply) {
    throw new Error(`Expected no reply but got: "${replyText}"`);
  }
}

/**
 * Wait for the next bot reply (without sending a message).
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
