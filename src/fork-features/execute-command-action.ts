/**
 * Fork-only delivery action: `execute_command`.
 *
 * Mattermost-channel feature: agent invokes a slash command using a stored
 * per-user OAuth token (so the command runs as the user, not the bot).
 * Originally lived in fork's IPC handler; v2 moves to the
 * registerDeliveryAction surface.
 *
 * The actual Mattermost call lives in the fork's mattermost channel
 * adapter; this file is just the dispatcher.
 */
import { registerDeliveryAction } from '../delivery.js';
import { log } from '../log.js';

export type ExecuteSlashCommandFn = (
  userId: string,
  command: string,
  channelId: string,
) => Promise<{ ok: boolean; response?: string; error?: string }>;

let executor: ExecuteSlashCommandFn | null = null;

export function setExecuteSlashCommand(fn: ExecuteSlashCommandFn): void {
  executor = fn;
}

registerDeliveryAction('execute_command', async (content, session): Promise<void> => {
  const command = typeof content.command === 'string' ? content.command : null;
  const channelId = typeof content.channelId === 'string' ? content.channelId : null;
  const userId = typeof content.userId === 'string' ? content.userId : null;

  if (!command || !channelId || !userId) {
    log.warn('execute_command missing fields', { sessionId: session.id, content });
    return;
  }
  if (!executor) {
    log.warn('execute_command received but no executor registered', { sessionId: session.id });
    return;
  }
  const result = await executor(userId, command, channelId);
  log.info('Slash command executed via execute_command action', {
    sessionId: session.id,
    command,
    ok: result.ok,
    error: result.error,
  });
  // Reply delivery: would go through the v2 outbound path. Fork's mattermost
  // adapter writes a chat outbound row directly.
});
