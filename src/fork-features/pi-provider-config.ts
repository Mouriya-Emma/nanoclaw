/**
 * Fork pi-mono provider container configs.
 *
 * Registers per-provider host-side container contributions for each pi-mono
 * provider. v2's `provider-container-registry` lets us declare extra mounts
 * + env per provider name, exactly the pi-mono use case.
 *
 * What this CANNOT do via the registry alone:
 *   - swap the runner image (pi-runner vs agent-runner) — that decision lives
 *     in container-runner.ts hardcoded as CONTAINER_IMAGE. v2 has
 *     ContainerConfigRow.image_tag for per-group override, but no provider-
 *     keyed image switch hook.
 *   - mount the fork's pi-runner src tree (would need an upstream patch in
 *     buildMounts to look up a runner-src path by provider).
 *   - inject MCP server URLs as a Record<name, {url}> structure to the
 *     runner — can be passed as a single JSON-encoded env var though.
 *
 * What this CAN do:
 *   - export OAuth credentials path / API key fallback secrets.
 *   - inject MCP_PROXY_URL env so the in-container runner knows where to
 *     find host MCP servers (it has to discover names another way).
 *   - mount pi-auth.json into the container as RO.
 */
import path from 'path';
import os from 'os';

import { registerProviderContainerConfig } from '../providers/provider-container-registry.js';
import { MCP_PROXY_PORT, PROVIDER_SECRET_KEYS } from './config.js';

const PI_AUTH_HOST_PATH = path.join(os.homedir(), '.pi-mono', 'pi-auth.json');

function piContribution(providerName: string) {
  return () => {
    const env: Record<string, string> = {
      PI_PROVIDER: providerName,
      MCP_PROXY_URL: `http://host.docker.internal:${MCP_PROXY_PORT}`,
    };
    // Fall through to API keys when provider supports them.
    for (const envKey of PROVIDER_SECRET_KEYS[providerName] ?? []) {
      const v = process.env[envKey];
      if (v) env[envKey] = v;
    }
    return {
      mounts: [{ hostPath: PI_AUTH_HOST_PATH, containerPath: '/workspace/.pi-mono/pi-auth.json', readonly: true }],
      env,
    };
  };
}

for (const provider of ['anthropic', 'google', 'openai', 'github-copilot', 'google-antigravity'] as const) {
  registerProviderContainerConfig(provider, piContribution(provider));
}
