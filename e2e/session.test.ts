import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import { send, sendAndExpectReply, interTestDelay } from './helpers.js';
import { disconnectClient } from './setup.js';
import { ALL_BACKENDS, switchToBackend } from './backend-helpers.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

const COLD_START_TIMEOUT = 180_000;

afterAll(async () => { await disconnectClient(); });

for (const backend of ALL_BACKENDS) {
  describe(`Session persistence (${backend.name})`, () => {
    afterEach(async () => { await interTestDelay(); });

    it('remembers across container restarts', async () => {
      const codeWord = `elephant-purple-42-${backend.name}`;

      // Step 1: Start fresh session and teach it a code word
      await switchToBackend(backend, TRIGGER);

      await sendAndExpectReply(
        `${TRIGGER} remember this code word exactly: ${codeWord}. Just confirm you have it.`,
        { timeout: COLD_START_TIMEOUT },
      );
      await interTestDelay();

      // Step 2: Stop the container
      await sendAndExpectReply('/stop', { timeout: 10_000 });
      await interTestDelay();

      // Step 3: Restart and ask for the code word
      const reply = await sendAndExpectReply(
        `${TRIGGER} what was the code word I told you to remember?`,
        { timeout: COLD_START_TIMEOUT },
      );
      expect(reply).toMatch(/elephant|purple|42/i);
    });
  });
}
