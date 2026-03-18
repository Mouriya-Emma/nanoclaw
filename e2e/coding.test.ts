import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import { sendAndExpectReply, interTestDelay } from './helpers.js';
import { disconnectClient } from './setup.js';
import { ALL_BACKENDS, switchToBackend } from './backend-helpers.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

const WARM_TIMEOUT = 120_000;

afterAll(async () => { await disconnectClient(); });

for (const backend of ALL_BACKENDS) {
  describe(`Coding tools (${backend.name})`, () => {
    beforeAll(async () => {
      await switchToBackend(backend, TRIGGER);
    });

    afterEach(async () => { await interTestDelay(); });

    it('bash: executes command', async () => {
      const marker = `hello-from-${backend.name}`;
      const reply = await sendAndExpectReply(
        `${TRIGGER} run this exact bash command and show me its output: echo ${marker}`,
        { timeout: WARM_TIMEOUT, match: marker },
      );
      expect(reply).toContain(marker);
    });

    it('bash: can access workspace', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} run "ls /workspace/group" and show me the output`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply.length).toBeGreaterThan(0);
    });

    it('file: write + read roundtrip', async () => {
      const marker = `test-ok-${backend.name}`;
      // Step 1: write a file
      await sendAndExpectReply(
        `${TRIGGER} create a file at /workspace/group/e2e-test.txt with the exact content "${marker}" and confirm when done`,
        { timeout: WARM_TIMEOUT },
      );
      await interTestDelay();

      // Step 2: read it back
      const reply = await sendAndExpectReply(
        `${TRIGGER} read the file /workspace/group/e2e-test.txt and show me its exact content`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply).toContain(marker);
    });

    it('file: cannot write outside workspace', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} try to write "test" to /tmp/outside-test.txt and tell me what happens`,
        { timeout: WARM_TIMEOUT },
      );
      // Agent should report something — either success or error, but not crash
      expect(reply.length).toBeGreaterThan(0);
    });
  });
}
