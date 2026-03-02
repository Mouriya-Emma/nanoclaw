# E2E Tests Design

## Overview

End-to-end tests for NanoClaw that run against a live instance via Telegram User API (gramjs/MTProto). Tests send real messages as a real user and verify bot responses.

## Tech Stack

- **Test framework**: vitest (separate config, long timeouts, sequential execution)
- **Telegram client**: `telegram` npm package (gramjs) — MTProto protocol, real user account
- **Run command**: `npm run test:e2e`

## Project Structure

```
e2e/
  vitest.config.ts          # Separate config: 120s timeout, sequential
  auth.ts                   # One-time script to generate StringSession
  setup.ts                  # gramjs client init, session management
  helpers.ts                # send, sendAndExpectReply, sendAndExpectNoReply, waitForReply
  commands.test.ts          # All Telegram bot commands
  message-flow.test.ts      # Trigger messages, runtime switching, /ask execution
```

## Configuration

`.env` additions:

```
E2E_TELEGRAM_API_ID=12345
E2E_TELEGRAM_API_HASH=abc123...
E2E_TELEGRAM_SESSION=1BQA...   # StringSession (generated via e2e:auth)
E2E_TELEGRAM_CHAT_ID=-1001234  # Test group chat ID
E2E_BOT_USER_ID=7654321        # NanoClaw bot's user id (for filtering replies)
```

`package.json` additions:

```json
"test:e2e": "vitest run --config e2e/vitest.config.ts",
"e2e:auth": "tsx e2e/auth.ts"
```

First-time setup: run `npm run e2e:auth`, enter phone number + verification code, save the output StringSession to `.env`.

## Core Helpers

```typescript
// Send a message to the test group
async function send(text: string): Promise<void>

// Send and wait for bot reply (event-based via client.addEventHandler on NewMessage)
async function sendAndExpectReply(
  text: string,
  opts?: { timeout?: number; match?: string | RegExp }
): Promise<string>

// Send and assert no bot reply within wait period
async function sendAndExpectNoReply(
  text: string,
  opts?: { wait?: number }
): Promise<void>

// Wait for next bot reply without sending (for multi-reply commands)
async function waitForReply(
  opts?: { timeout?: number; match?: string | RegExp }
): Promise<string>
```

### Reply Detection

Uses `client.addEventHandler` with `NewMessage` event (no polling):
- Filter by `chatId` matching test group
- Filter by `senderId` matching NanoClaw bot user id
- Resolve corresponding Promise on match

### Test Isolation

- 2s delay between test cases to avoid message ordering issues
- Message flow tests use random markers (e.g., `e2e-ok-{random}`) for precise matching
- Command tests match fixed response text

## Test Cases

### commands.test.ts

| Test | Send | Expected reply contains |
|------|------|------------------------|
| /ping | `/ping` | `is online` |
| /chatid | `/chatid` | `Chat ID:` + `tg:` |
| /clear | `/clear` | `Session cleared` |
| /stop | `/stop` | `Container stopped` |
| /model (no args) | `/model` | `default model` or `Select a model` |
| /model (with arg) | `/model <modelId>` | `Model set to` |
| /cla | `/cla` | `Switched to Claude Agent SDK` |
| /pi (no args) | `/pi` | `Select a pi-mono provider` or `No authenticated` |
| /pi (with provider) | `/pi anthropic` | `Switched to pi-mono/anthropic` |
| /pi (invalid) | `/pi invalid_xxx` | `Unknown pi-mono provider` |
| /ask (no args) | `/ask` | `Usage: /ask` |
| /ask (invalid provider) | `/ask invalid_xxx hello` | `Unknown provider` |
| /pi_login (no args) | `/pi_login` | `select a provider to login` |
| /requirements | `/requirements` | `No tool requirements` or `Tool requirements:` |

### message-flow.test.ts

| Test | Send | Expected |
|------|------|----------|
| Trigger message gets reply | `@Andy hello, reply with exactly "e2e-ok"` | Reply contains `e2e-ok` |
| No trigger = no reply | `e2e-silent-test-{random}` | No bot reply within 15s |
| /ask executes | `/ask anthropic reply with exactly "e2e-ask-ok"` | Reply contains `e2e-ask-ok` |
| /cla switch + execute | `/cla` then `@Andy reply with exactly "e2e-cla-ok"` | Reply contains `e2e-cla-ok` |
