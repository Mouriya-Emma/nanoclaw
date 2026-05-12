/**
 * Fork-only config knobs.
 *
 * Adds image tag, provider secret-key map, credential-proxy port,
 * MCP-proxy port, and host-exec allowlist alongside upstream config.
 * No upstream config.ts edits — consumers (pi-runner, mcp-proxy,
 * host-exec wrapper, container-runner) import from here.
 *
 * `ONECLI_URL` keeps upstream's behaviour (env-only, no default), because
 * /use-native-credential-proxy explicitly removes the OneCLI gateway in
 * the fork; the fork's CREDENTIAL_PROXY_PORT replaces it.
 */
import { readEnvFile } from '../env.js';

const envConfig = readEnvFile(['PI_CONTAINER_IMAGE', 'HOST_EXEC_ALLOWLIST']);

export const PI_CONTAINER_IMAGE =
  process.env.PI_CONTAINER_IMAGE || envConfig.PI_CONTAINER_IMAGE || 'nanoclaw-pi:latest';

/**
 * Provider → env-key mapping for fork pi-mono backends. The pi runtime
 * supports OAuth credentials (via pi-auth.json) plus optional API key
 * fallback for some providers. Empty array = OAuth only.
 */
export const PROVIDER_SECRET_KEYS: Record<string, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  anthropic: [],
  google: ['GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'github-copilot': [],
  'google-antigravity': [],
};

/** Pi-mono provider names recognized by /pi command. */
export const PI_PROVIDERS = ['anthropic', 'google', 'openai', 'github-copilot', 'google-antigravity'] as const;

/** Native credential proxy bind port (replaces OneCLI when /use-native-credential-proxy installed). */
export const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);

/** Port for MCP-proxy + host-exec proxy HTTP server. */
export const MCP_PROXY_PORT = parseInt(process.env.MCP_PROXY_PORT || '18321', 10);

/** Host commands allowed via the container-side host-exec wrapper. */
export const HOST_EXEC_ALLOWLIST = process.env.HOST_EXEC_ALLOWLIST || envConfig.HOST_EXEC_ALLOWLIST || '';
