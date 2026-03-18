import { send, sendAndExpectReply, interTestDelay } from './helpers.js';

export type Backend = {
  name: string;
  switchCmd: string;
  switchMatch: string;
  modelCmd?: string;
};

export const PI: Backend = {
  name: 'pi-mono',
  switchCmd: '/pi google-antigravity',
  switchMatch: 'google-antigravity',
  modelCmd: '/model gemini-3-flash',
};

export const CLA: Backend = {
  name: 'claude-sdk',
  switchCmd: '/cla',
  switchMatch: 'Switched to Claude Agent SDK',
};

export const ALL_BACKENDS: Backend[] = [PI, CLA];

const COLD_START_TIMEOUT = 180_000;

/** Stop current container, clear history, switch to backend, cold-start. */
export async function switchToBackend(backend: Backend, trigger: string): Promise<void> {
  await send('/stop');
  await interTestDelay();
  await send('/clear');
  await interTestDelay();
  await sendAndExpectReply(backend.switchCmd, { timeout: 10_000 });
  await interTestDelay();
  if (backend.modelCmd) {
    await sendAndExpectReply(backend.modelCmd, { timeout: 10_000 });
    // Extra delay to ensure DB write completes before container starts
    await new Promise(r => setTimeout(r, 5_000));
  }
  // Cold-start the container
  await sendAndExpectReply(`${trigger} say ready`, { timeout: COLD_START_TIMEOUT });
  await interTestDelay();
}
