/**
 * Fork-only DB migration.
 *
 * v2 doesn't expose a `registerMigration()` API — the migrations[] array in
 * src/db/migrations/index.ts is static. Two paths exist:
 *
 *   (a) edit src/db/migrations/index.ts to push a fork migration into the
 *       array (the v2-blessed "modules add migrations" path, but it's a
 *       trunk patch),
 *   (b) call ensureForkSchema() lazily on first use of fork accessors,
 *       creating tables idempotently. This avoids editing the migration
 *       array but skips the schema_version book-keeping (acceptable: the
 *       tables are fork-only, so the version row carries no upstream
 *       semantic value).
 *
 * Going with (b) here because the goal of the spike is to measure how few
 * trunk edits are required.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../db/connection.js';

let applied = false;

export function ensureForkSchema(): void {
  if (applied) return;
  const db: Database.Database = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS fork_model_preferences (
      agent_group_id   TEXT PRIMARY KEY,
      provider         TEXT NOT NULL DEFAULT 'claude',
      model_id         TEXT,
      last_pi_provider TEXT,
      last_pi_model_id TEXT
    );

    CREATE TABLE IF NOT EXISTS fork_tool_requirements (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder   TEXT NOT NULL,
      tool_name      TEXT NOT NULL,
      reason         TEXT,
      needs_auth     INTEGER DEFAULT 0,
      auth_provider  TEXT,
      created_at     TEXT NOT NULL,
      UNIQUE(group_folder, tool_name)
    );

    CREATE TABLE IF NOT EXISTS fork_user_tokens (
      user_id    TEXT NOT NULL,
      channel    TEXT NOT NULL DEFAULT 'mattermost',
      token      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, channel)
    );
  `);
  applied = true;
}

// Note: reply_to_* columns on `messages` from the fork are NOT replicated
// here — v2 stores reply context inside `messages_in.content` JSON
// (formatter.ts already reads content.replyTo.id). The fork's column-based
// storage is obsolete in v2.
