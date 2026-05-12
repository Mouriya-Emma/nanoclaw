/**
 * Pi-mono per-group model preference.
 *
 * Fork-only — selects which provider (and optional sub-model) the pi-mono
 * runtime should use for an agent group. The /pi command writes this; the
 * pi-runner reads it at spawn time. Independent of the v2 ContainerConfigRow.provider
 * field because pi-mono enumerates a different set of provider names
 * (anthropic vs claude, plus google/openai/github-copilot/google-antigravity).
 */
export interface ModelPreference {
  provider: string; // 'claude' | 'anthropic' | 'google' | 'openai' | 'github-copilot' | 'google-antigravity'
  modelId?: string; // specific model id within the provider
}
