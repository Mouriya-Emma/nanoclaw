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
    // Try to open existing session file
    const sessionFile = path.join(sessDir, `${sessionId}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      log(`Resuming session: ${sessionId}`);
      return SessionManager.open(sessionFile, sessDir);
    }
    log(`Session file not found: ${sessionFile}, creating new`);
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
