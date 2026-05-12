/**
 * Fork-only delivery action: `tool_requirement`.
 *
 * v1-fork shipped this as an IPC case that the host watcher dispatched.
 * v2 has no `src/ipc.ts` — the agent communicates by writing
 * `kind='system'` rows to messages_out, and the host calls
 * `registerDeliveryAction(action, handler)` to attach handlers.
 *
 * This file:
 *   1. owns the SQLite table for tool requirements (registered as a
 *      module-style migration in fork-features/migrations.ts).
 *   2. registers the `tool_requirement` action handler.
 *
 * No upstream files edited; only fork-features/index.ts gains an import.
 */
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';
import { upsertToolRequirement } from './db-accessors.js';

registerDeliveryAction('tool_requirement', async (content, session): Promise<void> => {
  const tool = typeof content.tool === 'string' ? content.tool : null;
  if (!tool) {
    log.warn('tool_requirement action missing `tool` field', { sessionId: session.id });
    return;
  }
  upsertToolRequirement({
    group_folder: session.agent_group_id,
    tool_name: tool,
    reason: typeof content.reason === 'string' ? content.reason : null,
    needs_auth: content.needs_auth ? 1 : 0,
    auth_provider: typeof content.auth_provider === 'string' ? content.auth_provider : null,
  });
  log.info('Tool requirement recorded', { tool, sessionId: session.id });
});
