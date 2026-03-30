import { defineConfig } from 'vitest/config';

const shared = {
  sequence: { concurrent: false },
  pool: 'forks' as const,
  maxWorkers: 1,
  hookTimeout: 200_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'commands',
          include: ['e2e/commands.test.ts'],
          testTimeout: 30_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'message-flow',
          include: ['e2e/message-flow.test.ts'],
          testTimeout: 200_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'mcp-tools',
          include: ['e2e/mcp-tools.test.ts'],
          testTimeout: 200_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'coding',
          include: ['e2e/coding.test.ts'],
          testTimeout: 200_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'ipc-tools',
          include: ['e2e/ipc-tools.test.ts'],
          testTimeout: 200_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'host-exec',
          include: ['e2e/host-exec.test.ts'],
          testTimeout: 200_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'session',
          include: ['e2e/session.test.ts'],
          testTimeout: 300_000,
          ...shared,
        },
      },
      // --- Mattermost E2E ---
      {
        test: {
          name: 'mm-commands',
          include: ['e2e/mm-commands.test.ts'],
          testTimeout: 30_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'mm-message-flow',
          include: ['e2e/mm-message-flow.test.ts'],
          testTimeout: 200_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'mm-coding',
          include: ['e2e/mm-coding.test.ts'],
          testTimeout: 200_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'mm-ipc-tools',
          include: ['e2e/mm-ipc-tools.test.ts'],
          testTimeout: 200_000,
          ...shared,
        },
      },
      {
        test: {
          name: 'mm-session',
          include: ['e2e/mm-session.test.ts'],
          testTimeout: 300_000,
          ...shared,
        },
      },
    ],
  },
});
