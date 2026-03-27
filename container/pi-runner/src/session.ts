import { SessionManager } from '@mariozechner/pi-coding-agent';
import { log } from './protocol.js';
import fs from 'fs';
import path from 'path';

const SESSIONS_DIR = '/workspace/group/.pi-sessions';
const CWD = '/workspace/group';

export function getSessionDir(): string {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  return SESSIONS_DIR;
}

/**
 * Create a SessionManager that either continues an existing session
 * or starts a new one.
 */
export function createSessionManager(sessionId?: string): SessionManager {
  const sessDir = getSessionDir();

  if (sessionId) {
    // Session files are named {timestamp}_{sessionId}.jsonl by SessionManager.
    // Search for any file whose name ends with the sessionId.
    const exactFile = path.join(sessDir, `${sessionId}.jsonl`);
    if (fs.existsSync(exactFile)) {
      log(`Resuming session: ${sessionId}`);
      return SessionManager.open(exactFile, sessDir);
    }
    // Search for timestamp-prefixed variant
    const match = fs.readdirSync(sessDir).find(f => f.endsWith(`_${sessionId}.jsonl`));
    if (match) {
      const matchPath = path.join(sessDir, match);
      log(`Resuming session: ${sessionId} (file: ${match})`);
      return SessionManager.open(matchPath, sessDir);
    }
    log(`Session file not found for ${sessionId}, creating new`);
  }

  log('Creating new session');
  return SessionManager.create(CWD, sessDir);
}

/**
 * Extract session ID from a SessionManager.
 */
export function extractSessionId(sessionManager: SessionManager): string | undefined {
  try {
    return sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}
