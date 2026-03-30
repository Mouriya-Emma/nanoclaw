import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import { sendAndExpectReply, interTestDelay, startWsListener, stopWsListener } from './mm-setup.js';
import { ALL_BACKENDS, switchToBackend } from './mm-backend-helpers.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

const WARM_TIMEOUT = 120_000;

beforeAll(async () => { await startWsListener(); }, 15_000);
afterAll(() => { stopWsListener(); });

for (const backend of ALL_BACKENDS) {
  describe(`Mattermost coding tools (${backend.name})`, () => {
    beforeAll(async () => {
      await switchToBackend(backend, TRIGGER);
    });

    afterEach(async () => { await interTestDelay(); });

    it('bash: executes command', async () => {
      const marker = `mm-hello-${backend.name}`;
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
      const marker = `mm-test-ok-${backend.name}`;
      await sendAndExpectReply(
        `${TRIGGER} create a file at /workspace/group/mm-e2e-test.txt with the exact content "${marker}" and confirm when done`,
        { timeout: WARM_TIMEOUT },
      );
      await interTestDelay();

      const reply = await sendAndExpectReply(
        `${TRIGGER} read the file /workspace/group/mm-e2e-test.txt and show me its exact content`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply).toContain(marker);
    });

    it('file: cannot write outside workspace', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} try to write "test" to /tmp/outside-test.txt and tell me what happens`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply.length).toBeGreaterThan(0);
    });
  });
}
