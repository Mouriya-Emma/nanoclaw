import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readEnvFile } from '../src/env.js';
import { sendAndExpectReply, waitForBotReply, interTestDelay, startWsListener, stopWsListener } from './mm-setup.js';
import { ALL_BACKENDS, switchToBackend } from './mm-backend-helpers.js';

const env = readEnvFile(['ASSISTANT_NAME']);
const TRIGGER = `@${process.env.ASSISTANT_NAME || env.ASSISTANT_NAME || 'Andy'}`;

const WARM_TIMEOUT = 120_000;

beforeAll(async () => { await startWsListener(); }, 15_000);
afterAll(() => { stopWsListener(); });

for (const backend of ALL_BACKENDS) {
  describe(`Mattermost IPC tools (${backend.name})`, () => {
    beforeAll(async () => {
      await switchToBackend(backend, TRIGGER);
    });

    afterEach(async () => { await interTestDelay(); });

    it('send_message', async () => {
      const marker = `mm-ipc-ping-${backend.name}`;
      await sendAndExpectReply(
        `${TRIGGER} use the mcp__nanoclaw__send_message tool to send the message "${marker}" and confirm`,
        { timeout: WARM_TIMEOUT },
      );
      const forwarded = await waitForBotReply({ match: marker, timeout: 30_000 });
      expect(forwarded).toContain(marker);
    });

    it('schedule_task', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} use the mcp__nanoclaw__schedule_task tool to schedule a once-type task for 2099-01-01T00:00:00Z with message "mm-e2e-scheduled-task" and tell me the result`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply.toLowerCase()).toMatch(/schedul|调度|计划|任务/);
    });

    it('list_tasks', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} use the mcp__nanoclaw__list_tasks tool and show me what it returns`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply.length).toBeGreaterThan(0);
    });

    it('cancel_task', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} use mcp__nanoclaw__list_tasks to find the task with message "mm-e2e-scheduled-task", then use mcp__nanoclaw__cancel_task to cancel it, and tell me the result`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply.toLowerCase()).toMatch(/cancel|取消|removed|deleted/);
    });

    it('request_tool', async () => {
      const reply = await sendAndExpectReply(
        `${TRIGGER} use the mcp__nanoclaw__request_tool tool to request a tool called "mm-e2e-test-tool" with reason "testing" and tell me the result`,
        { timeout: WARM_TIMEOUT },
      );
      expect(reply.toLowerCase()).toMatch(/record|记录|logged|noted|request/);
    });
  });
}
