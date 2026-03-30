/**
 * Backend switching helpers for Mattermost E2E — CLA only (no pi-mono).
 * Mattermost channel doesn't implement /cla or /pi commands,
 * so "switching" is just stop + clear + cold-start.
 */
import { send, sendAndExpectReply, interTestDelay } from './mm-setup.js';

export type Backend = {
  name: string;
};

export const CLA: Backend = { name: 'claude-sdk' };

export const ALL_BACKENDS: Backend[] = [CLA];

const COLD_START_TIMEOUT = 180_000;

/** Stop current container, clear history, cold-start. */
export async function switchToBackend(backend: Backend, trigger: string): Promise<void> {
  await send('/stop');
  await interTestDelay();
  await send('/clear');
  await interTestDelay();
  // Cold-start the container
  await sendAndExpectReply(`${trigger} say ready`, { timeout: COLD_START_TIMEOUT });
  await interTestDelay();
}
