/**
 * Fork-only feature barrel.
 *
 * Each import triggers a side-effect registration into upstream extension
 * points (registerDeliveryAction, registerChannelAdapter, registerCliCommand,
 * etc.). Adding `import './fork-features/index.js'` to upstream src/index.ts
 * is the only trunk-level edit required.
 */

// Delivery actions
import './tool-requirement-action.js';
import './execute-command-action.js';

// Pi-mono provider container configs (mounts + env per provider).
import './pi-provider-config.js';

// Re-exports for fork code that needs the types/functions
export type { ModelPreference } from './model-preference.js';
export type { ToolRequirement } from './tool-requirement.js';
export {
  PI_CONTAINER_IMAGE,
  PROVIDER_SECRET_KEYS,
  PI_PROVIDERS,
  CREDENTIAL_PROXY_PORT,
  MCP_PROXY_PORT,
  HOST_EXEC_ALLOWLIST,
} from './config.js';
export { setExecuteSlashCommand } from './execute-command-action.js';
export {
  NANOCLAW_EXCHANGE_SCHEMA_VERSION,
  NANOCLAW_INBOUND_BODY_KIND,
  NANOCLAW_OUTBOUND_BODY_KIND,
  bridgeReceiveErrorToDeliveryErrorEnvelope,
  buildExchangeDeliveryErrorEnvelope,
  createNanoClawExchangeRuntimeBridge,
  decodeExchangeInboundEnvelope,
  nanoclawRuntimeChannelId,
  normalizePossiblyStringifiedJson,
  projectNanoClawMessageToExchangeEnvelope,
  receiveExchangeEnvelope,
} from './exchange-runtime-bridge.js';
export type {
  BridgeReceiveErrorCode,
  BridgeReceiveResult,
  DecodedExchangeInbound,
  ExchangeDeliverError,
  ExchangeDeliverErrorEnvelope,
  ExchangeDeliverMessage,
  ExchangeDeliverMessageEnvelope,
  ExchangeDeliveryErrorVariant,
  ExchangeEnvelope,
  NanoClawExchangeDestination,
  NanoClawExchangeRuntimeBridge,
  NanoClawExchangeRuntimeDeps,
  NanoClawMessageProjection,
} from './exchange-runtime-bridge.js';
export {
  getModelPreference,
  setModelPreference,
  deleteModelPreference,
  getLastPiPreference,
  setLastPiPreference,
  upsertToolRequirement,
  getToolRequirements,
  getUserToken,
  setUserToken,
  deleteUserToken,
} from './db-accessors.js';
