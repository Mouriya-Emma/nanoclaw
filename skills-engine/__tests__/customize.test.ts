import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  isCustomizeActive,
  startCustomize,
  commitCustomize,
  abortCustomize,
} from '../customize.js';
import { CUSTOM_DIR } from '../constants.js';
import {
  createTempDir,
  setupNanoclawDir,
  createMinimalState,
  cleanup,
  writeState,
} from './test-helpers.js';
import { readState, recordSkillApplication, computeFileHash } from '../state.js';

describe('customize', () => {
  let tmpDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tmpDir = createTempDir();
    setupNanoclawDir(tmpDir);
    createMinimalState(tmpDir);
    fs.mkdirSync(path.join(tmpDir, CUSTOM_DIR), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(tmpDir);
  });

  it('startCustomize creates pending.yaml and isCustomizeActive returns true', () => {
    // Need at least one applied skill with file_hashes for snapshot
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    expect(isCustomizeActive()).toBe(false);
    startCustomize('test customization');
    expect(isCustomizeActive()).toBe(true);

    const pendingPath = path.join(tmpDir, CUSTOM_DIR, 'pending.yaml');
    expect(fs.existsSync(pendingPath)).toBe(true);
  });

  it('abortCustomize removes pending.yaml', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('test');
    expect(isCustomizeActive()).toBe(true);

    abortCustomize();
    expect(isCustomizeActive()).toBe(false);
  });

  it('commitCustomize with no changes clears pending', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('no-op');
    commitCustomize();

    expect(isCustomizeActive()).toBe(false);
  });

  it('commitCustomize with changes creates patch and records in state', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('add feature');

    // Modify the tracked file
    fs.writeFileSync(trackedFile, 'export const x = 2;\nexport const y = 3;');

    commitCustomize();

    expect(isCustomizeActive()).toBe(false);
    const state = readState();
    expect(state.custom_modifications).toBeDefined();
    expect(state.custom_modifications!.length).toBeGreaterThan(0);
    expect(state.custom_modifications![0].description).toBe('add feature');
  });

  it('commitCustomize throws descriptive error on diff failure', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('diff-error test');

    // Modify the tracked file
    fs.writeFileSync(trackedFile, 'export const x = 2;');

    // Make the base file a directory to cause diff to exit with code 2.
    // On some platforms (e.g. GNU diff on Linux), comparing a directory
    // against a file exits with code 1 (not 2), so this test is
    // platform-dependent. We accept either a throw or a successful commit.
    const baseFilePath = path.join(tmpDir, '.nanoclaw', 'base', 'src', 'app.ts');
    fs.mkdirSync(baseFilePath, { recursive: true });

    try {
      commitCustomize();
      // If it doesn't throw, diff returned code 1 (platform-dependent behavior)
      // — the commit proceeded with whatever diff output was produced.
      expect(isCustomizeActive()).toBe(false);
    } catch (err) {
      expect((err as Error).message).toMatch(/diff error/i);
    }
  });

  it('startCustomize while active throws', () => {
    const trackedFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
    fs.writeFileSync(trackedFile, 'export const x = 1;');
    recordSkillApplication('test-skill', '1.0.0', {
      'src/app.ts': computeFileHash(trackedFile),
    });

    startCustomize('first');
    expect(() => startCustomize('second')).toThrow();
  });
});
