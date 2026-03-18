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
  describe(`Host Exec Proxy (${backend.name})`, () => {
    beforeAll(async () => {
      await switchToBackend(backend, TRIGGER);
    });

    afterEach(async () => { await interTestDelay(); });

    it('executes whitelisted command', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} run "fulcrum --help" and show me the output`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply.length).toBeGreaterThan(0);
    });

    it('PATH configured correctly', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} run "which fulcrum" and show me the output`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply.toLowerCase()).toMatch(/\/opt\/host-exec|host-exec|host.exec/);
    });

    it('non-allowlisted command is blocked', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} run "/opt/host-exec/curl --help" and tell me what happens`,
        { timeout: WARM_TIMEOUT },
      );
      // Should report an error — command not in allowlist
      expect(reply.toLowerCase()).toMatch(/error|not found|denied|block|fail|no such|没有|不存在|enoent/);
    });
  });
}
