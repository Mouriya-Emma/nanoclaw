/**
 * Backend switching helpers for Mattermost E2E — CLA only (no pi-mono).
 */
import { send, sendAndExpectReply, interTestDelay } from './mm-setup.js';

export type Backend = {
  name: string;
  switchCmd: string;
  switchMatch: string;
};

export const CLA: Backend = {
  name: 'claude-sdk',
  switchCmd: '/cla',
  switchMatch: 'Switched to Claude Agent SDK',
};

// Only Claude SDK — no pi-mono accounts available
export const ALL_BACKENDS: Backend[] = [CLA];

const COLD_START_TIMEOUT = 180_000;

/** Stop current container, clear history, switch to backend, cold-start. */
export async function switchToBackend(backend: Backend, trigger: string): Promise<void> {
  await send('/stop');
  await interTestDelay();
  await send('/clear');
  await interTestDelay();
  await sendAndExpectReply(backend.switchCmd, { timeout: 10_000 });
  await interTestDelay();
  // Cold-start the container
  await sendAndExpectReply(`${trigger} say ready`, { timeout: COLD_START_TIMEOUT });
  await interTestDelay();
}
