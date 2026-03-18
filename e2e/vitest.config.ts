import { defineConfig } from 'vitest/config';

// Shared base config — prefer using the workspace (vitest.workspace.ts) instead.
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    testTimeout: 200_000,
    hookTimeout: 30_000,
    sequence: { concurrent: false },
    pool: 'forks',
    maxWorkers: 1,
  },
});
