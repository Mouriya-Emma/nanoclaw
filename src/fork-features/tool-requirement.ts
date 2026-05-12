/**
 * Tool-requirement record (fork-only).
 *
 * The agent inside the container uses a `request_tool` MCP-side mechanism
 * to ask the host to install/auth a host-side tool. The host stores
 * unanswered requests in this table and surfaces them to the operator.
 *
 * v2 has no equivalent — closest concepts are pending_approvals (per
 * action+payload) and the install-skill flow, but neither directly models
 * "agent asked for tool X with reason Y, needs auth from provider Z" as a
 * persistent inbox row. This is fork domain logic, kept entirely in
 * fork-features.
 */
export interface ToolRequirement {
  id: number;
  group_folder: string;
  tool_name: string;
  reason: string | null;
  needs_auth: number;
  auth_provider: string | null;
  created_at: string;
}
