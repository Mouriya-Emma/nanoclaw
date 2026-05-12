/**
 * Fork-only DB accessors. Lazy-creates the fork schema on first call.
 *
 * Tables are prefixed `fork_` so they cannot collide with future upstream
 * tables and are obviously fork-owned in DB tooling.
 *
 * Key delta vs the v1 fork accessors:
 *   - v2's primary key for an agent group is `agent_group_id` (string), not
 *     `group_folder`. ToolRequirement keeps `group_folder` because that's
 *     what the IPC payload referenced; callers should pass agent_group_id
 *     into both fields uniformly until the legacy callsites are cleaned.
 *   - reply_to_* columns from the v1 fork are gone — v2 stores reply
 *     context inside the messages_in.content JSON.
 */
import { getDb } from '../db/connection.js';
import { ensureForkSchema } from './migration.js';
import type { ModelPreference } from './model-preference.js';
import type { ToolRequirement } from './tool-requirement.js';

// --- Model preferences ---

export function getModelPreference(agentGroupId: string): ModelPreference {
  ensureForkSchema();
  const row = getDb()
    .prepare('SELECT provider, model_id FROM fork_model_preferences WHERE agent_group_id = ?')
    .get(agentGroupId) as { provider: string; model_id: string | null } | undefined;
  return row ? { provider: row.provider, modelId: row.model_id ?? undefined } : { provider: 'claude' };
}

export function setModelPreference(agentGroupId: string, pref: ModelPreference): void {
  ensureForkSchema();
  getDb()
    .prepare(
      `INSERT INTO fork_model_preferences (agent_group_id, provider, model_id)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET provider = excluded.provider, model_id = excluded.model_id`,
    )
    .run(agentGroupId, pref.provider, pref.modelId ?? null);
}

export function deleteModelPreference(agentGroupId: string): void {
  ensureForkSchema();
  getDb().prepare('DELETE FROM fork_model_preferences WHERE agent_group_id = ?').run(agentGroupId);
}

export function getLastPiPreference(agentGroupId: string): ModelPreference | undefined {
  ensureForkSchema();
  const row = getDb()
    .prepare('SELECT last_pi_provider, last_pi_model_id FROM fork_model_preferences WHERE agent_group_id = ?')
    .get(agentGroupId) as { last_pi_provider: string | null; last_pi_model_id: string | null } | undefined;
  if (!row?.last_pi_provider) return undefined;
  return { provider: row.last_pi_provider, modelId: row.last_pi_model_id ?? undefined };
}

export function setLastPiPreference(agentGroupId: string, provider: string, modelId?: string): void {
  ensureForkSchema();
  getDb()
    .prepare(
      `INSERT INTO fork_model_preferences (agent_group_id, provider, last_pi_provider, last_pi_model_id)
       VALUES (?, 'claude', ?, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET last_pi_provider = excluded.last_pi_provider, last_pi_model_id = excluded.last_pi_model_id`,
    )
    .run(agentGroupId, provider, modelId ?? null);
}

// --- Tool requirements ---

export function upsertToolRequirement(req: {
  group_folder: string;
  tool_name: string;
  reason?: string | null;
  needs_auth?: boolean | number;
  auth_provider?: string | null;
}): void {
  ensureForkSchema();
  getDb()
    .prepare(
      `INSERT INTO fork_tool_requirements (group_folder, tool_name, reason, needs_auth, auth_provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_folder, tool_name) DO UPDATE SET
         reason = excluded.reason,
         needs_auth = excluded.needs_auth,
         auth_provider = excluded.auth_provider`,
    )
    .run(
      req.group_folder,
      req.tool_name,
      req.reason ?? null,
      req.needs_auth ? 1 : 0,
      req.auth_provider ?? null,
      new Date().toISOString(),
    );
}

export function getToolRequirements(groupFolder?: string): ToolRequirement[] {
  ensureForkSchema();
  const db = getDb();
  if (groupFolder) {
    return db
      .prepare('SELECT * FROM fork_tool_requirements WHERE group_folder = ? ORDER BY created_at DESC')
      .all(groupFolder) as ToolRequirement[];
  }
  return db.prepare('SELECT * FROM fork_tool_requirements ORDER BY created_at DESC').all() as ToolRequirement[];
}

// --- User tokens (mattermost slash-command-as-user) ---

export function getUserToken(userId: string, channel = 'mattermost'): string | undefined {
  ensureForkSchema();
  const row = getDb()
    .prepare('SELECT token FROM fork_user_tokens WHERE user_id = ? AND channel = ?')
    .get(userId, channel) as { token: string } | undefined;
  return row?.token;
}

export function setUserToken(userId: string, channel: string, token: string): void {
  ensureForkSchema();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO fork_user_tokens (user_id, channel, token, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(userId, channel, token, new Date().toISOString());
}

export function deleteUserToken(userId: string, channel = 'mattermost'): void {
  ensureForkSchema();
  getDb().prepare('DELETE FROM fork_user_tokens WHERE user_id = ? AND channel = ?').run(userId, channel);
}
